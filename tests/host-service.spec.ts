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

describe('TaskBoardHostService rework continuation', () => {
  /**
   * The launch wiring for a corrected card: the note has to reach the
   * conversation it corrects, and the card's fresh-run default (a new session
   * per execution) must not swallow it.
   */
  it('continues the previous conversation and prompts only the note', async () => {
    const now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    // A first run that finished, then a review that did not accept it.
    const first = ledger.applyRequest('run-first', { kind: 'run', taskId: 'card' }).run
    ledger.attachSession('card', first!.execution.id, 'session-first')
    ledger.settle('card', first!.execution.id, 'succeeded', undefined)
    ledger.applyRequest('rework', { kind: 'rework', taskId: 'card', note: 'the redirect is missing' })
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
      now: () => now,
    })
    // The roster has to be known before the launch: an unknown roster never
    // reuses, and the note would then ride on a fresh prompt instead.
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
    const opened = ledger.applyRequest('run-second', { kind: 'run', taskId: 'card' }).run
    await (service as unknown as { launch(run: unknown): Promise<void> }).launch(opened)

    expect(create).not.toHaveBeenCalled()
    const request = (prompt.mock.calls[0]?.[0] as unknown as { args: { request: { sessionId: string; content: Array<{ text: string }> } } }).args.request
    expect(request.sessionId).toBe('session-first')
    // The continued session already holds `work`; the new turn is the note.
    expect(request.content[0].text).not.toContain('work')
    expect(request.content[0].text).toContain('the redirect is missing')
    const latest = ledger.state().tasks[0].executions.at(-1)
    expect(latest?.sessionId).toBe('session-first')
    expect(latest?.reworkNote).toBe('the redirect is missing')
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
    expect(stream.mock.calls.map(call => (call[0] as GatewayRequest).method)).toEqual(['follow', 'control'])
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
