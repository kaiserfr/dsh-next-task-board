import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService, installStreamErrorGuards, safeConsoleError } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { createTask, EXECUTION_HISTORY_LIMIT, startExecution, withSchedule } from '../src/core/tasks.ts'

const roots: string[] = []

type GatewayRequest = {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

type GatewayHandler = (request: GatewayRequest) => unknown | Promise<unknown>
type FollowHandler = (request: GatewayRequest) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>

function emptyStream(): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() {} }
}

function makeGateway(handler: GatewayHandler, follow?: FollowHandler) {
  const invoke = vi.fn(async (request: GatewayRequest) => handler(request))
  const stream = vi.fn(async (request: GatewayRequest) => follow === undefined ? emptyStream() : follow(request))
  const gateway = { invoke, stream } as unknown as TypertGateway
  return { gateway, invoke, stream }
}

function sessionEvent(type: string, seq: number, time: number, data: unknown) {
  return { type: 'event' as const, event: { type, seq, time, data } }
}

function snapshot(records: readonly unknown[], cursor: number, hasMore: boolean) {
  return { type: 'snapshot' as const, header: {}, cursor, records, hasMore, projections: {} }
}

/** The live `session/control` baseline: pending inbox items and jobs per session. */
function controlBaseline(
  queues: Record<string, readonly unknown[]> = {},
  jobs: Record<string, readonly { status: string }[]> = {},
) {
  return { type: 'baseline' as const, value: { queues, jobs, projections: {} } }
}

/**
 * Route the fake stream by method: `follow` probes the history head, `control`
 * is the live inbox/job baseline the session-end check reads.
 */
function sessionStream(handlers: {
  follow?: () => AsyncIterable<unknown>
  control?: () => AsyncIterable<unknown>
}): FollowHandler {
  return (request: GatewayRequest) => {
    const build = request.method === 'control' ? handlers.control : handlers.follow
    return build === undefined
      ? { async *[Symbol.asyncIterator]() { yield request.method === 'control' ? controlBaseline() : snapshot([], 0, false) } }
      : build()
  }
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-service-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('TaskBoardHostService scheduling without a browser', () => {
  it('fires one due run and records its independent session', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 30).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 'scheduled', input: {
        title: 'Scheduled', description: '', prompt: 'work', schedule: { enabled: true, cron: '* * * * *' },
      },
    })
    const create = vi.fn(async (_request: GatewayRequest) => ({ sessionId: 'session-scheduled' }))
    const prompt = vi.fn(async (_request: GatewayRequest) => ({ accepted: true }))
    const { gateway } = makeGateway(request => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'create') return create(request)
      if (request.method === 'rename') return { title: 'Scheduled', seq: 1 }
      if (request.method === 'prompt') return prompt(request)
      throw new Error('unexpected gateway call')
    })
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })
    now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    await (service as unknown as { tickSchedule(first: boolean): Promise<void> }).tickSchedule(false)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(create).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledOnce()
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
    expect(ledger.state().tasks[0].executions[0].sessionId).toBe('session-scheduled')
    await (service as unknown as { tickSchedule(first: boolean): Promise<void> }).tickSchedule(false)
    expect(create).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('does not launch an imported archived task with a legacy enabled schedule', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    const base = createTask({ title: 'Archived', description: '', prompt: '' }, now - 60_000, 'archived')
    const archived = {
      ...withSchedule(base, { enabled: true, cron: '* * * * *', nextRunAt: now, lastTriggeredAt: undefined }, now - 60_000),
      status: 'done' as const,
      archivedAt: now - 30_000,
    }
    ledger.applyRequest('import', { kind: 'import', sourceId: 'legacy', tasks: [archived] })
    const create = vi.fn()
    const { gateway } = makeGateway(request => request.method === 'create' ? create(request) : { items: [] })
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })

    await (service as unknown as { tickSchedule(first: boolean): Promise<void> }).tickSchedule(false)

    expect(create).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0].executions).toEqual([])
    service.dispose()
  })

  it('skips a due occurrence on the recovery tick and rolls from current Host time', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 30).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 'scheduled', input: {
        title: 'Scheduled', description: '', prompt: '', schedule: { enabled: true, cron: '* * * * *' },
      },
    })
    const create = vi.fn()
    const { gateway } = makeGateway(request => request.method === 'create' ? create(request) : { items: [] })
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })
    now = new Date(2026, 7, 16, 10, 2, 0).getTime()
    await (service as unknown as { tickSchedule(first: boolean): Promise<void> }).tickSchedule(true)
    expect(create).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0].executions).toEqual([])
    expect(ledger.state().tasks[0].schedule?.nextRunAt).toBe(new Date(2026, 7, 16, 10, 3, 0).getTime())
    service.dispose()
  })

  it('treats the first session snapshot after re-enable as unknown', () => {
    const { gateway } = makeGateway(() => ({ items: [] }))
    const service = new TaskBoardHostService(gateway, {
      ledger: new HostTaskLedger(root()),
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    service.power.updateReasons({ runningSessions: 0, armedSchedules: 0, sessionStateKnown: true })
    service.setConfiguration(false, true)
    service.setConfiguration(true, true)
    expect(service.power.snapshot().sessionStateKnown).toBe(false)
    service.dispose()
  })

  it('returns the first ledger result for a duplicate request id', () => {
    const { gateway } = makeGateway(() => ({ items: [] }))
    const service = new TaskBoardHostService(gateway, {
      ledger: new HostTaskLedger(root()),
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    const first = service.apply('request-a', {
      kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' },
    })
    service.apply('request-b', {
      kind: 'create', id: 'task-b', input: { title: 'B', description: '', prompt: '' },
    })
    const duplicate = service.apply('request-a', {
      kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' },
    })
    expect(duplicate.revision).toBeGreaterThan(first.revision)
    expect(duplicate.tasks.map(task => task.id)).toEqual(['task-a', 'task-b'])
    expect(() => service.apply('request-a', {
      kind: 'create', id: 'ignored', input: { title: 'ignored', description: '', prompt: '' },
    })).toThrow('different action')
    service.dispose()
  })

  it('continues settling an open execution after the plugin is disabled even if task status drifted', async () => {
    const ledger = new HostTaskLedger(root())
    const base = createTask({ title: 'A', description: '', prompt: '' }, 1_000, 'task-a')
    const opened = startExecution(base, 1_100, 'execution-a').task
    const imported = {
      ...opened,
      status: 'todo' as const,
      executions: opened.executions.map(execution => ({ ...execution, sessionId: 'session-a' })),
    }
    ledger.applyRequest('import', { kind: 'import', sourceId: 'browser', tasks: [imported] })
    const { gateway, stream } = makeGateway(request => {
      if (request.method === 'list') return { items: [{ sessionId: 'session-a', running: false }] }
      if (request.method === 'page') return {
        records: [sessionEvent('turn/end', 10, 1_200, { reason: { kind: 'completed' } })],
        hasMore: false,
      }
      throw new Error('unexpected gateway call')
    }, sessionStream({
      follow: () => ({
        async *[Symbol.asyncIterator]() {
          yield snapshot([], 10, true)
        },
      }),
    }))
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    service.setConfiguration(false, false)
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
    expect(ledger.state().tasks[0].executions[0].result).toBe('succeeded')
    expect(ledger.state().tasks[0].status).toBe('ready_for_test')
    // One history probe plus the live inbox/job baseline that confirms the
    // session has nothing left to run.
    expect(stream.mock.calls.map(call => (call[0] as GatewayRequest).method)).toEqual(['follow', 'control'])
    service.dispose()
  })

  it('starts its two Host timers only once', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const { gateway } = makeGateway(() => ({ items: [] }))
    const service = new TaskBoardHostService(gateway, {
      ledger: new HostTaskLedger(root()),
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    service.start()
    service.start()
    expect(interval).toHaveBeenCalledTimes(2)
    service.dispose()
    interval.mockRestore()
  })
})

describe('TaskBoardHostService clarification runs', () => {
  /** Let the fire-and-forget launch chains settle (they only await gateway microtasks). */
  async function flush(): Promise<void> {
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }

  /**
   * The todo-column clarification is a real execution, but `todo` is WIP-free:
   * it starts right away even while the lane's slot is held by a working run,
   * and the later run continues exactly its session with the short go-ahead.
   */
  it('starts next to a busy lane and wakes the same session with the go-ahead', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create-busy', { kind: 'create', id: 'busy', input: { title: 'Busy', description: '', prompt: 'work' } })
    const busy = ledger.applyRequest('run-busy', { kind: 'run', taskId: 'busy' }).run!
    ledger.attachSession('busy', busy.execution.id, 'session-busy')
    ledger.applyRequest('create-card', {
      kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'implement it' },
    })

    const prompts: Array<{ sessionId: string; text: string }> = []
    let created = 0
    const { gateway } = makeGateway(request => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'list') {
        return { items: [{ sessionId: 'session-busy', running: true }, { sessionId: 'session-clarify', running: false }] }
      }
      if (request.method === 'create') { created += 1; return { sessionId: 'session-clarify' } }
      if (request.method === 'rename') return { title: 'Card', seq: 1 }
      if (request.method === 'prompt') {
        const args = request.args as unknown as { request: { sessionId: string; content: Array<{ text: string }> } }
        prompts.push({ sessionId: args.request.sessionId, text: args.request.content[0].text })
        return { accepted: true }
      }
      throw new Error('unexpected gateway call: ' + request.method)
    })
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()

    // The lane's only slot is held by `busy` (the roster says it is working) —
    // and the card still starts at once: `todo` never waits for a slot, so the
    // human gets the questions without waiting for the run to settle. The prompt
    // is the card's own prompt plus the clarification addendum, and the run
    // links the card's conversation.
    service.apply('card-to-todo', { kind: 'move', taskId: 'card', status: 'todo' })
    await flush()
    expect(created).toBe(1)
    expect(prompts[0]?.sessionId).toBe('session-clarify')
    expect(prompts[0]?.text).toContain('implement it')
    expect(prompts[0]?.text).toContain('Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts.')
    expect(prompts[0]?.text).toContain('Die Implementierung beginnt erst mit')
    const card = ledger.state().tasks.find(task => task.id === 'card')!
    expect(card.status).toBe('todo')
    expect(card.clarificationSessionId).toBe('session-clarify')

    // The go-ahead closes the clarification round and starts the run, which
    // continues exactly the clarification session — the agent only needs the
    // short prompt (plus the completion contract). The *implementation* run is
    // an ordinary run: it needs the lane's slot, which `busy` still holds.
    service.setMaxConcurrentRuns(2)
    service.apply('card-to-running', { kind: 'move', taskId: 'card', status: 'running' })
    await flush()
    expect(prompts[1]?.sessionId).toBe('session-clarify')
    expect(prompts[1]?.text.startsWith('Bitte jetzt implementieren.')).toBe(true)
    expect(prompts[1]?.text).toContain('FERTIG:')
    const implemented = ledger.state().tasks.find(task => task.id === 'card')!
    expect(implemented.status).toBe('running')
    // One session for the whole card: the round was closed, not left running in
    // parallel with the implementation.
    expect(implemented.executions.map(execution => execution.kind)).toEqual(['clarify', undefined])
    expect(implemented.executions[0]?.endedAt).toBe(now)
    service.dispose()
  })

  /**
   * The hazard the go-ahead creates for a round whose session is still being
   * created: `todo` starts without waiting for a slot, so the human can pull the
   * card on to the run column while the round is mid-launch. The round is closed
   * with the go-ahead, so its late session must not be attached as the card's
   * conversation — it is stopped instead, and the card owns exactly one.
   */
  it('cancels the late session of a round the go-ahead superseded', async () => {
    const now = new Date(2026, 7, 16, 10, 2, 0).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create-busy', { kind: 'create', id: 'busy', input: { title: 'Busy', description: '', prompt: 'work' } })
    const busy = ledger.applyRequest('run-busy', { kind: 'run', taskId: 'busy' }).run!
    ledger.attachSession('busy', busy.execution.id, 'session-busy')
    ledger.applyRequest('create-card', {
      kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'implement it' },
    })

    const prompts: Array<{ sessionId: string; text: string }> = []
    const cancelled: string[] = []
    let created = 0
    const { gateway } = makeGateway(request => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'list') {
        return { items: [{ sessionId: 'session-busy', running: true }] }
      }
      if (request.method === 'create') { created += 1; return { sessionId: `session-${created}` } }
      if (request.method === 'rename') return { title: 'Card', seq: 1 }
      if (request.method === 'cancel') { cancelled.push((request.args as { request: { sessionId: string } }).request.sessionId); return {} }
      if (request.method === 'prompt') {
        const args = request.args as unknown as { request: { sessionId: string; content: Array<{ text: string }> } }
        prompts.push({ sessionId: args.request.sessionId, text: args.request.content[0].text })
        return { accepted: true }
      }
      throw new Error('unexpected gateway call: ' + request.method)
    })
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()

    // The round starts at once (WIP-free) and the go-ahead follows before its
    // session could attach; the implementation is an ordinary run, so the busy
    // lane keeps it queued until the limit is raised.
    service.apply('card-to-todo', { kind: 'move', taskId: 'card', status: 'todo' })
    service.apply('card-to-running', { kind: 'move', taskId: 'card', status: 'running' })
    await flush()
    expect(created).toBe(1)
    service.setMaxConcurrentRuns(2)
    await flush()

    // Two sessions were created — the round's and the implementation's — but
    // only the implementation's is the card's: the superseded round's session
    // was stopped, and the implementation ran with the full prompt, because
    // there was no answered conversation to continue.
    expect(created).toBe(2)
    expect(cancelled).toEqual(['session-1'])
    expect(prompts.map(entry => entry.sessionId)).toEqual(['session-1', 'session-2'])
    expect(prompts[0]?.text).toContain('Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts.')
    expect(prompts[1]?.text).toContain('implement it')
    expect(prompts[1]?.text).not.toContain('Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts.')
    const card = ledger.state().tasks.find(task => task.id === 'card')!
    expect(card.status).toBe('running')
    expect(card.clarificationSessionId).toBeUndefined()
    expect(card.executions.find(execution => execution.kind === 'clarify')?.sessionId).toBeUndefined()
    expect(card.executions.filter(execution => execution.endedAt === undefined)).toHaveLength(1)
    service.dispose()
  })
})

describe('TaskBoardHostService rework continuation', () => {
  /**
   * The launch wiring for a corrected card: the round has to continue the
   * conversation it corrects, and the card's fresh-run default (a new session
   * per execution) must not swallow that. The correction itself is the human's
   * own turn in that chat — the board only frames the round.
   */
  it('continues the previous conversation and frames the round', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    let clock = now
    const ledger = new HostTaskLedger(root(), () => clock)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    // A first run that finished, then a review that did not accept it: the card
    // goes back to todo and is stamped.
    const first = ledger.applyRequest('run-first', { kind: 'run', taskId: 'card' }).run
    ledger.attachSession('card', first!.execution.id, 'session-first')
    clock += 1_000
    ledger.settle('card', first!.execution.id, 'succeeded', undefined)
    ledger.applyRequest('rework', { kind: 'move', taskId: 'card', status: 'todo' })
    expect(ledger.state().tasks[0].reworkAt).toBe(now + 1_000)
    expect(ledger.state().tasks[0].reuseSession).toBeUndefined()

    const create = vi.fn(async () => ({ sessionId: 'session-fresh' }))
    const prompt = vi.fn(async (_request: GatewayRequest) => ({ accepted: true }))
    const { gateway } = makeGateway(request => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'list') return { items: [{ sessionId: 'session-first', running: false }] }
      if (request.method === 'create') return create()
      if (request.method === 'rename') return { title: 'Card', seq: 1 }
      if (request.method === 'prompt') return prompt(request)
      throw new Error('unexpected gateway call: ' + request.method)
    })
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => clock,
    })
    // The roster has to be known before the launch: an unknown roster never
    // reuses, and the round would then open a fresh conversation.
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
    clock += 1_000
    const opened = ledger.applyRequest('run-second', { kind: 'run', taskId: 'card' }).run
    await (service as unknown as { launch(run: unknown): Promise<void> }).launch(opened)

    expect(create).not.toHaveBeenCalled()
    const request = (prompt.mock.calls[0]?.[0] as unknown as { args: { request: { sessionId: string; content: Array<{ text: string }> } } }).args.request
    expect(request.sessionId).toBe('session-first')
    // The continued session already holds `work` and the human's correction; the
    // new turn only frames the round.
    expect(request.content[0].text).not.toContain('work')
    expect(request.content[0].text).toContain('返工要求')
    const latest = ledger.state().tasks[0].executions.at(-1)
    expect(latest?.sessionId).toBe('session-first')
    expect(latest?.rework).toBe(true)
    service.dispose()
  })
})

describe('TaskBoardHostService poll heartbeat', () => {
  function sessionsList(items: Array<{ sessionId: string; running: boolean }>) {
    return makeGateway(request => {
      if (request.namespace !== 'session' || request.method !== 'list') throw new Error('unexpected gateway call')
      return { items }
    }).gateway
  }

  it('does not push SSE frames while the session and power snapshots stay unchanged', async () => {
    const service = new TaskBoardHostService(sessionsList([]), {
      ledger: new HostTaskLedger(root()),
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    let pushes = 0
    service.subscribe(() => { pushes += 1 })
    const poll = service as unknown as { pollSessions(): Promise<void> }
    await poll.pollSessions()
    // The first poll flips sessionStateKnown, so exactly one push is expected.
    expect(pushes).toBe(1)
    await poll.pollSessions()
    await poll.pollSessions()
    expect(pushes).toBe(1)
    service.dispose()
  })

  it('pushes an SSE frame when the running-session count changes', async () => {
    let items: Array<{ sessionId: string; running: boolean }> = []
    const { gateway } = makeGateway(request => {
      if (request.namespace !== 'session' || request.method !== 'list') throw new Error('unexpected gateway call')
      return { items }
    })
    const service = new TaskBoardHostService(gateway, {
      ledger: new HostTaskLedger(root()),
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    let pushes = 0
    service.subscribe(() => { pushes += 1 })
    const poll = service as unknown as { pollSessions(): Promise<void> }
    await poll.pollSessions()
    await poll.pollSessions()
    const before = pushes
    items = [{ sessionId: 'session-a', running: true }]
    await poll.pollSessions()
    expect(pushes).toBe(before + 1)
    service.dispose()
  })

  it('eventPayload carries revision/scheduler/power and never the task list', () => {
    const ledger = new HostTaskLedger(root())
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    const service = new TaskBoardHostService(sessionsList([]), {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    const payload = service.eventPayload()
    expect(payload).not.toHaveProperty('tasks')
    expect(payload.revision).toBe(ledger.state().revision)
    expect(payload.scheduler).toEqual(ledger.summary().scheduler)
    expect(payload.power).toEqual(service.power.snapshot())
    service.dispose()
  })

  it('settles an open execution only once its session is at rest', async () => {
    const ledger = new HostTaskLedger(root())
    const base = createTask({ title: 'A', description: '', prompt: '' }, 1_000, 'task-a')
    const opened = startExecution(base, 1_100, 'execution-a').task
    const imported = {
      ...opened,
      executions: opened.executions.map(execution => ({ ...execution, sessionId: 'session-a' })),
    }
    ledger.applyRequest('import', { kind: 'import', sourceId: 'browser', tasks: [imported] })
    const list = vi.fn(async () => ({ items: [{ sessionId: 'session-a', running: false }] }))
    const page = vi.fn(async () => ({
      records: [sessionEvent('turn/end', 10, 1_200, { reason: { kind: 'completed' } })],
      hasMore: false,
    }))
    const { gateway, stream } = makeGateway(request => {
      if (request.method === 'list') return list()
      if (request.method === 'page') return page()
      throw new Error('unexpected gateway call')
    }, sessionStream({
      follow: () => ({
        async *[Symbol.asyncIterator]() {
          yield snapshot([], 10, true)
        },
      }),
    }))
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
    })
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
    expect(ledger.state().tasks[0].executions[0].result).toBe('succeeded')
    // The poll roster plus the fresh roster read that confirms the park.
    expect(list).toHaveBeenCalledTimes(2)
    // `follow` probes the run's history head, `control` confirms the session is
    // at rest, and the trailing `follow` is the rework watch looking at the card
    // that this very poll parked in `ready_for_test`.
    expect(stream.mock.calls.map(call => (call[0] as GatewayRequest).method)).toEqual(['follow', 'control', 'follow'])
    expect(page).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('leaves a card in running while its session still runs or still owes work', async () => {
    const buildLedger = () => {
      const ledger = new HostTaskLedger(root())
      const base = createTask({ title: 'A', description: '', prompt: '' }, 1_000, 'task-a')
      const opened = startExecution(base, 1_100, 'execution-a').task
      ledger.applyRequest('import', {
        kind: 'import',
        sourceId: 'browser',
        tasks: [{ ...opened, executions: opened.executions.map(execution => ({ ...execution, sessionId: 'session-a' })) }],
      })
      return ledger
    }
    const page = () => ({
      records: [sessionEvent('turn/end', 10, 1_200, { reason: { kind: 'completed' } })],
      hasMore: false,
    })
    const poll = async (ledger: HostTaskLedger, items: unknown[], baseline: unknown) => {
      const { gateway } = makeGateway(request => {
        if (request.method === 'list') return { items }
        if (request.method === 'page') return page()
        throw new Error('unexpected gateway call')
      }, sessionStream({
        follow: () => ({
          async *[Symbol.asyncIterator]() {
            yield snapshot([], 10, true)
          },
        }),
        control: () => ({
          async *[Symbol.asyncIterator]() {
            yield baseline
          },
        }),
      }))
      const service = new TaskBoardHostService(gateway, { ledger, power: new PowerInhibitor({ platform: 'linux' }) })
      await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
      service.dispose()
      return ledger.state().tasks[0]
    }
    // A turn/end is already in the history, but the session is still running.
    const running = await poll(buildLedger(), [{ sessionId: 'session-a', running: true }], controlBaseline())
    expect(running.status).toBe('running')
    expect(running.executions[0].result).toBeUndefined()
    // The session is idle, yet a queued prompt will start another turn.
    const queued = await poll(buildLedger(), [{ sessionId: 'session-a', running: false }], controlBaseline({ 'session-a': [{ id: 'm1', placement: 'queued' }] }))
    expect(queued.status).toBe('running')
    expect(queued.executions[0].result).toBeUndefined()
    // A background job will wake the session for another turn.
    const job = await poll(buildLedger(), [{ sessionId: 'session-a', running: false }], controlBaseline({}, { 'session-a': [{ status: 'running' }] }))
    expect(job.status).toBe('running')
    expect(job.executions[0].result).toBeUndefined()
  })

  it('keeps hot polling and scheduling off the full-state clone', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 30).getTime()
    const ledger = new HostTaskLedger(root())
    const base = createTask({ title: 'A', description: '', prompt: '' }, now - 10_000, 'task-a')
    const executions = Array.from({ length: 2_000 }, (_, index) => ({
      id: 'settled-' + index,
      sessionId: 'old-session-' + index,
      startedAt: now - 8_000 - index * 2,
      endedAt: now - 7_999 - index * 2,
      result: 'succeeded' as const,
      error: undefined,
    }))
    const opened = startExecution({ ...base, executions }, now - 1_000, 'execution-open').task
    ledger.applyRequest('import', {
      kind: 'import',
      sourceId: 'browser',
      tasks: [{
        ...opened,
        executions: opened.executions.map(execution => execution.id === 'execution-open'
          ? { ...execution, sessionId: 'session-open' }
          : execution),
      }],
    })
    let sessionStateAvailable = false
    const list = vi.fn(async () => {
      if (!sessionStateAvailable) throw new Error('temporary list failure')
      return { items: [{ sessionId: 'session-open', running: true }] }
    })
    const { gateway } = makeGateway(request => request.method === 'list' ? list() : { items: [] })
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })
    const state = vi.spyOn(ledger, 'state')
    const runtimeView = vi.spyOn(ledger, 'runtimeView')

    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
    expect(runtimeView).not.toHaveBeenCalled()
    sessionStateAvailable = true
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
    await (service as unknown as { tickSchedule(first: boolean): Promise<void> }).tickSchedule(false)

    expect(state).not.toHaveBeenCalled()
    expect(runtimeView).toHaveBeenCalledOnce()
    // The 2,000-entry fixture is trimmed to the retention limit on append and
    // import, keeping snapshot and ledger size bounded.
    const snapshotValue = service.snapshot()
    expect(snapshotValue.tasks[0].executions).toHaveLength(EXECUTION_HISTORY_LIMIT)
    expect(snapshotValue.tasks[0].executions.at(-1)?.id).toBe('execution-open')
    expect(state).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('hands the enforced state machine to the browser in the snapshot', () => {
    const machine = {
      initial: 'todo',
      states: [{ status: 'backlog' }, { status: 'todo' }, { status: 'done' }],
      transitions: [{ from: 'todo', to: 'done' }],
    }
    const ledger = new HostTaskLedger(root(), Date.now, { stateMachine: machine })
    const service = new TaskBoardHostService({} as TypertGateway, { ledger })
    expect(service.snapshot().stateMachine).toEqual(machine)
    // The machine travels with an action result too, so the browser never
    // validates against a stale machine.
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: '' } })
    const applied = service.apply('move', { kind: 'move', taskId: 'card', status: 'done' })
    expect(applied.stateMachine).toEqual(machine)
    expect(applied.tasks[0].status).toBe('done')
    service.dispose()
  })

  it('installs error guards on streams without crashing on emitted error (#1427)', () => {
    installStreamErrorGuards()
    expect(() => {
      process.stderr.emit('error', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
      process.stdout.emit('error', Object.assign(new Error('EPIPE: broken pipe'), { code: 'EPIPE' }))
    }).not.toThrow()
  })

  it('safeConsoleError suppresses console.error exceptions (#1427)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: write failed'), { code: 'ENOSPC' })
    })
    expect(() => {
      safeConsoleError('test message', new Error('sample'))
    }).not.toThrow()
    errorSpy.mockRestore()
  })
})

/**
 * Which run may hold a lane's WIP slot. The slot belongs to every open
 * implementation execution that attached its session, from attachment until it
 * settles (or its card is paused): an idle roster entry means "no turn right
 * now", not "the run is over", so it must not push the lane's following cards
 * out of the queue. Only the settle (or pause) frees the lane, and a
 * clarification run in `todo` never needs a slot at all.
 */
describe('TaskBoardHostService lane occupancy', () => {
  /** Let the fire-and-forget launch chains settle (they only await gateway microtasks). */
  async function flush(): Promise<void> {
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }

  function gatewayWithRoster(
    roster: () => readonly { sessionId: string; running: boolean }[],
    prompts: Array<{ sessionId: string; text: string }>,
  ) {
    let created = 0
    const { gateway } = makeGateway(request => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'list') return { items: roster() }
      if (request.method === 'create') { created += 1; return { sessionId: `session-${created}` } }
      if (request.method === 'rename') return { title: 'Card', seq: 1 }
      if (request.method === 'prompt') {
        const args = request.args as unknown as { request: { sessionId: string; content: Array<{ text: string }> } }
        prompts.push({ sessionId: args.request.sessionId, text: args.request.content[0].text })
        return { accepted: true }
      }
      throw new Error('unexpected gateway call: ' + request.method)
    })
    return { gateway, created: () => created }
  }

  function poll(service: TaskBoardHostService): Promise<void> {
    return (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
  }

  /** Settle a task's current execution — the one thing that frees its WIP slot. */
  function settle(ledger: HostTaskLedger, id: string, outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): void {
    const task = ledger.state().tasks.find(candidate => candidate.id === id)
    const execution = task?.executions.at(-1)
    if (execution === undefined) throw new Error(`task ${id} has no execution to settle`)
    ledger.settle(id, execution.id, outcome)
  }

  /** `busy` with an open, session-attached execution; `card` waiting to be pulled. */
  function laneLedger(now: number): HostTaskLedger {
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create-busy', { kind: 'create', id: 'busy', input: { title: 'Busy', description: '', prompt: 'work' } })
    ledger.applyRequest('run-busy', { kind: 'run', taskId: 'busy' })
    const occupant = ledger.state().tasks.find(task => task.id === 'busy')!.executions.at(-1)!
    ledger.attachSession('busy', occupant.id, 'session-busy')
    ledger.applyRequest('create-card', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'implement it' } })
    return ledger
  }

  it('starts the next card when the lane occupant is only attached, not working', async () => {
    const now = new Date(2026, 7, 16, 10, 3, 0).getTime()
    const ledger = laneLedger(now)
    const prompts: Array<{ sessionId: string; text: string }> = []
    const { gateway, created } = gatewayWithRoster(() => [{ sessionId: 'session-busy', running: false }], prompts)
    const service = new TaskBoardHostService(gateway, { ledger, power: new PowerInhibitor({ platform: 'linux' }), now: () => now })
    await poll(service)

    service.apply('card-to-todo', { kind: 'move', taskId: 'card', status: 'todo' })
    await flush()
    // `busy` still carries an open, session-attached execution — but the roster
    // saw that session at rest, so it is not working and the clarification must
    // start right away instead of queueing behind a card that is already done.
    expect(created()).toBe(1)
    expect(prompts[0]?.sessionId).toBe('session-1')
    expect(ledger.state().tasks.find(task => task.id === 'card')?.clarificationSessionId).toBe('session-1')
    service.dispose()
  })

  it('queues an implementation run behind a lane occupant and starts it only once that run settles', async () => {
    const now = new Date(2026, 7, 16, 10, 4, 0).getTime()
    const ledger = laneLedger(now)
    const prompts: Array<{ sessionId: string; text: string }> = []
    let busyRunning = true
    const { gateway, created } = gatewayWithRoster(() => [{ sessionId: 'session-busy', running: busyRunning }], prompts)
    const service = new TaskBoardHostService(gateway, { ledger, power: new PowerInhibitor({ platform: 'linux' }), now: () => now })

    service.apply('card-to-running', { kind: 'run', taskId: 'card' })
    await flush()
    // No roster poll yet: an unreadable roster is no evidence of a free slot.
    expect(created()).toBe(0)
    await poll(service)
    // The occupant's session is working: the slot is taken, so the card waits.
    expect(created()).toBe(0)
    expect(ledger.state().tasks.find(task => task.id === 'card')?.executions[0]?.sessionId).toBeUndefined()

    // The occupant's turn ends without the run being settled (it asked a
    // question mid-task): the session is idle in the roster, but the run still
    // owns the lane's worktree, so the queued card must keep waiting.
    busyRunning = false
    await poll(service)
    await flush()
    expect(created()).toBe(0)
    expect(prompts).toHaveLength(0)

    settle(ledger, 'busy')
    await flush()
    expect(created()).toBe(1)
    expect(prompts).toHaveLength(1)
    service.dispose()
  })

  it('starts the card round beside a working lane, but queues its implementation behind it', async () => {
    const now = new Date(2026, 7, 16, 10, 5, 0).getTime()
    const ledger = laneLedger(now)
    const prompts: Array<{ sessionId: string; text: string }> = []
    let busyRunning = true
    // The roster names the card's round session once it exists, so the
    // implementation later finds it idle and continues it.
    const roster = (): Array<{ sessionId: string; running: boolean }> => {
      const items = [{ sessionId: 'session-busy', running: busyRunning }]
      const round = ledger.state().tasks.find(task => task.id === 'card')?.clarificationSessionId
      if (round !== undefined) items.push({ sessionId: round, running: false })
      return items
    }
    const { gateway, created } = gatewayWithRoster(roster, prompts)
    const service = new TaskBoardHostService(gateway, { ledger, power: new PowerInhibitor({ platform: 'linux' }), now: () => now })
    await poll(service)

    // `busy` works in the run column and holds the lane's slot, and the card's
    // round still starts at once: `todo` is WIP-free.
    service.apply('card-to-todo', { kind: 'move', taskId: 'card', status: 'todo' })
    await flush()
    expect(created()).toBe(1)
    expect(prompts[0]?.text).toContain('Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts.')

    // The go-ahead is an implementation run: that one is gated, so it queues
    // behind the occupant instead of opening a second session.
    service.apply('card-to-running', { kind: 'move', taskId: 'card', status: 'running' })
    await flush()
    expect(created()).toBe(1)
    expect(ledger.state().tasks.find(task => task.id === 'card')?.status).toBe('running')

    // An idle occupant still holds the lane: the implementation keeps waiting.
    busyRunning = false
    await poll(service)
    await flush()
    expect(created()).toBe(1)

    // Settling the occupant frees the lane; the implementation continues the
    // round's conversation with the short go-ahead instead of minting a session.
    settle(ledger, 'busy')
    await flush()
    expect(created()).toBe(1)
    expect(prompts[1]?.sessionId).toBe('session-1')
    expect(prompts[1]?.text.startsWith('Bitte jetzt implementieren.')).toBe(true)
    service.dispose()
  })
})

/**
 * The run's own completion report, end to end through the service. The report
 * is a note for the human: until the session itself has ended the card stays in
 * In progress, and only the session's end settles it into Ready for test.
 */
describe('TaskBoardHostService completion report', () => {
  it("leaves the card in In progress on the agent's FERTIG line while the session still runs", async () => {
    const now = new Date(2026, 7, 16, 10, 6, 0).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create-card', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'do work' } })
    const opened = ledger.applyRequest('run-card', { kind: 'run', taskId: 'card' }).run!
    ledger.attachSession('card', opened.execution.id, 'session-card')

    let sessionRunning = true
    const follow = (): AsyncIterable<unknown> => ({
      async *[Symbol.asyncIterator]() {
        yield snapshot([
          sessionEvent('assistant/message', 11, now + 1_000, {
            message: { role: 'assistant', content: [{ type: 'text', text: 'Alles erledigt.\nFERTIG: umgesetzt und getestet' }] },
          }),
          sessionEvent('turn/end', 12, now + 1_000, { reason: { kind: 'completed' } }),
        ], 12, false)
      },
    })
    const { gateway } = makeGateway(request => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'list') return { items: [{ sessionId: 'session-card', running: sessionRunning }] }
      throw new Error('unexpected gateway call: ' + request.method)
    }, sessionStream({ follow }))
    const service = new TaskBoardHostService(gateway, { ledger, power: new PowerInhibitor({ platform: 'linux' }), now: () => now })
    const poll = (): Promise<void> => (service as unknown as { pollSessions(): Promise<void> }).pollSessions()

    // The report is in the chat from the very first poll: a running session
    // blocks the column change, so the card keeps its open execution.
    await poll()
    let card = ledger.state().tasks.find(task => task.id === 'card')!
    expect(card.status).toBe('running')
    expect(card.executions[0]?.endedAt).toBeUndefined()

    // The session ends: the next poll settles the run and parks the card.
    sessionRunning = false
    await poll()
    card = ledger.state().tasks.find(task => task.id === 'card')!
    expect(card.status).toBe('ready_for_test')
    expect(card.executions[0]?.result).toBe('succeeded')
    expect(card.executions[0]?.endedAt).toBe(now)
    service.dispose()
  })
})

describe('TaskBoardHostService rework watch (a human turn in the settled chat)', () => {
  /** A card that finished its run and now waits for the review. */
  function parked(now: number): HostTaskLedger {
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    const run = ledger.applyRequest('run', { kind: 'run', taskId: 'card' }).run
    ledger.attachSession('card', run!.execution.id, 'session-card')
    ledger.settle('card', run!.execution.id, 'succeeded', undefined)
    return ledger
  }

  /** One service whose roster holds `session-card`, plus the follow stream. */
  function service(ledger: HostTaskLedger, now: number, follow: () => AsyncIterable<unknown>, updatedAt = 100) {
    const { gateway, stream } = makeGateway(request => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'list') return { items: [{ sessionId: 'session-card', running: false, updatedAt }] }
      throw new Error('unexpected gateway call: ' + request.method)
    }, sessionStream({ follow }))
    const instance = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })
    return { service: instance, stream }
  }

  const poll = (instance: TaskBoardHostService): Promise<void> =>
    (instance as unknown as { pollSessions(): Promise<void> }).pollSessions()

  it('sends the card back to todo and stamps it when the human wrote after the park', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = parked(now)
    const { service: instance } = service(ledger, now, () => ({
      async *[Symbol.asyncIterator]() {
        yield snapshot([sessionEvent('user/message', 11, now + 1_000, { message: { content: [{ type: 'text', text: 'the redirect is missing' }] } })], 11, false)
      },
    }))

    await poll(instance)

    const card = ledger.state().tasks.find(task => task.id === 'card')!
    expect(card.status).toBe('todo')
    expect(card.reworkAt).toBe(now)
    expect(card.reworkCount).toBe(1)
    // The correction itself is not copied anywhere: it stays in that chat.
    expect(JSON.stringify(card)).not.toContain('the redirect is missing')
    instance.dispose()
  })

  it('leaves the card parked when the newest human turn is older than the park', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = parked(now)
    // The board's own run prompt is a user turn too; it predates the settle.
    const { service: instance } = service(ledger, now, () => ({
      async *[Symbol.asyncIterator]() {
        yield snapshot([sessionEvent('user/message', 4, now - 60_000, { message: { content: [{ type: 'text', text: 'work' }] } })], 4, false)
      },
    }))

    await poll(instance)

    expect(ledger.state().tasks[0].status).toBe('ready_for_test')
    expect(ledger.state().tasks[0].reworkAt).toBeUndefined()
    instance.dispose()
  })

  it('reads an unchanged conversation once', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = parked(now)
    // No human turn in the newest window: the card stays parked, and the next
    // poll skips the read because the conversation's updatedAt did not move.
    const { service: instance, stream } = service(ledger, now, () => ({
      async *[Symbol.asyncIterator]() {
        yield snapshot([], 0, false)
      },
    }))

    await poll(instance)
    await poll(instance)

    expect(ledger.state().tasks[0].status).toBe('ready_for_test')
    expect(stream).toHaveBeenCalledOnce()
    instance.dispose()
  })

  it('retries an unreadable conversation instead of treating it as silence', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = parked(now)
    let readable = false
    const { service: instance } = service(ledger, now, () => {
      if (!readable) throw new Error('history unavailable')
      return {
        async *[Symbol.asyncIterator]() {
          yield snapshot([sessionEvent('user/message', 11, now + 1_000, { message: { content: [] } })], 11, false)
        },
      }
    })

    // Unreadable history is never evidence of "no human turn": the card stays.
    await poll(instance)
    expect(ledger.state().tasks[0].status).toBe('ready_for_test')
    readable = true
    await poll(instance)
    expect(ledger.state().tasks[0].status).toBe('todo')
    instance.dispose()
  })

  it('does not watch a card that is not waiting for a review', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = parked(now)
    ledger.applyRequest('back', { kind: 'move', taskId: 'card', status: 'todo' })
    const { service: instance, stream } = service(ledger, now, () => ({
      async *[Symbol.asyncIterator]() {
        yield snapshot([sessionEvent('user/message', 11, now + 1_000, { message: { content: [] } })], 11, false)
      },
    }))

    await poll(instance)

    expect(stream).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0].reworkAt).toBe(now)
    instance.dispose()
  })
})
