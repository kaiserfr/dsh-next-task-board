/**
 * The hard stop: what "stop" means on the Host side.
 *
 * Two properties are load-bearing and pinned here:
 *
 * 1. A stop ends the *session*, not just its turn. A background job outlives a
 *    turn and its completion notice wakes the agent into a new one — the exact
 *    reason a card could keep working after the user pressed stop.
 * 2. When the runtime still reports the agent as running after the cancel, the
 *    stop escalates (force the phase to idle) instead of silently doing nothing,
 *    and it says so in its report.
 *
 * Plus the two follow-ups that make the board act on it: a pause reaches a
 * conversation without an open run, and a paused session that runs again is
 * stopped by the watchdog.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { HostExecutionRunner, type LiveSessionAgent, type SessionControl } from '../src/host-runner.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const roots: string[] = []
type GatewayRequest = { namespace: string; method: string; args: Record<string, unknown> }

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-stop-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

/** A fake live agent whose status the stop's cancel changes. */
function liveAgent(options: { stubborn?: boolean } = {}) {
  const agent = {
    status: 'running',
    cancel: vi.fn((_cause: { kind: 'user' }, _options?: { keepInbox?: boolean }) => {
      if (options.stubborn === true) return
      agent.status = 'idle'
    }),
    inbox: {
      nextTurn: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Bitte noch X prüfen' }] },
        { id: 'm2', role: 'user', source: { kind: 'plugin:dsh-tool-jobs' }, content: [{ type: 'text', text: 'background job finished' }] },
      ],
      nextStep: [],
    },
    phase: { kind: 'running', lastTurn: 4 },
    setPhase: vi.fn((next: { kind: 'idle'; lastTurn: number }) => { agent.status = next.kind }),
  }
  return agent as typeof agent & { cancel: ReturnType<typeof vi.fn>; setPhase: ReturnType<typeof vi.fn> }
}

function makeGateway(handler: (request: GatewayRequest) => unknown | Promise<unknown> = () => ({ accepted: true })) {
  const invoke = vi.fn(async (request: GatewayRequest) => handler(request))
  return { invoke, gateway: { invoke } as unknown as TypertGateway }
}

describe('HostExecutionRunner.stopSession', () => {
  it('cancels the turn without retaining the queue, kills the jobs and keeps human messages', async () => {
    const agent = liveAgent()
    const jobs = {
      list: vi.fn(() => [{ id: 'job-1', status: 'running' }, { id: 'job-2', status: 'completed' }]),
      kill: vi.fn(),
    }
    const control: SessionControl = { agent: () => agent, jobs }
    const { gateway } = makeGateway()
    const runner = new HostExecutionRunner(gateway, undefined, undefined, undefined, undefined, control)

    const report = await runner.stopSession('session-a', { timeoutMs: 100 })

    // The queued prompt must not start the next turn; the human message is
    // preserved for the resume turn, the job notice is not.
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(jobs.kill).toHaveBeenCalledTimes(1)
    expect(jobs.kill).toHaveBeenCalledWith('job-1', 'session-a', expect.any(String))
    expect(report).toMatchObject({ attached: true, stopped: true, jobsKilled: 1, phaseReset: false })
    expect(report.preserved).toEqual(['Bitte noch X prüfen'])
  })

  it('escalates to a phase reset when the runtime still reports the agent as running', async () => {
    const agent = liveAgent({ stubborn: true })
    const control: SessionControl = { agent: () => agent }
    const { gateway } = makeGateway()
    const runner = new HostExecutionRunner(gateway, undefined, undefined, undefined, undefined, control)

    const report = await runner.stopSession('session-a', { timeoutMs: 80 })

    expect(agent.setPhase).toHaveBeenCalledWith({ kind: 'idle', lastTurn: 4 })
    expect(report).toMatchObject({ attached: true, stopped: true, phaseReset: true })
  })

  it('reports a failed stop instead of pretending', async () => {
    const agent = liveAgent({ stubborn: true })
    agent.setPhase = vi.fn((_next: { kind: 'idle'; lastTurn: number }) => undefined)
    const control: SessionControl = { agent: () => agent }
    const runner = new HostExecutionRunner(makeGateway().gateway, undefined, undefined, undefined, undefined, control)

    const report = await runner.stopSession('session-a', { timeoutMs: 60 })

    expect(report.stopped).toBe(false)
    expect(report.attached).toBe(true)
  })

  it('falls back to the session RPC when no live agent handle exists', async () => {
    const { invoke, gateway } = makeGateway()
    const runner = new HostExecutionRunner(gateway) as unknown as HostExecutionRunner
    const report = await runner.stopSession('session-a', { timeoutMs: 50 })
    expect(invoke).toHaveBeenCalledOnce()
    expect((invoke.mock.calls[0][0] as unknown as { method: string }).method).toBe('cancel')
    expect(report.attached).toBe(false)
    expect(report.stopped).toBe(true)
  })
})

function serviceWith(ledger: HostTaskLedger, control: SessionControl, now = 0) {
  const { gateway, invoke } = makeGateway((request) => {
    if (request.namespace === 'session' && request.method === 'list') {
      return { items: [{ sessionId: 'session-a', running: true, updatedAt: 10 }] }
    }
    return { accepted: true }
  })
  const service = new TaskBoardHostService(gateway, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => now,
    sessionControl: control,
  })
  return { service, invoke }
}

describe('board side of the hard stop', () => {
  async function flush(): Promise<void> {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }

  /** A card in the clarification column with one open run on `session-a`. */
  function openLedger(): { ledger: HostTaskLedger; executionId: string } {
    const ledger = new HostTaskLedger(root(), () => 0)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    const moved = ledger.applyRequest('move', { kind: 'move', taskId: 'card', status: 'clarification' })
    const execution = moved.clarification!.execution
    ledger.attachSession('card', execution.id, 'session-a')
    return { ledger, executionId: execution.id }
  }

  it('pauses a conversation that no longer has an open run (the orphaned-session case)', async () => {
    const ledger = new HostTaskLedger(root(), () => 0)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    const moved = ledger.applyRequest('move', { kind: 'move', taskId: 'card', status: 'clarification' })
    const execution = moved.clarification!.execution
    ledger.attachSession('card', execution.id, 'session-a')
    ledger.settle('card', execution.id, 'succeeded')

    const agent = liveAgent()
    const { service } = serviceWith(ledger, { agent: () => agent })
    await service.apply('pause-orphan', { kind: 'pause', taskIds: ['card'] })
    await flush()

    // There is no run to suspend, yet the human's pause still reached the
    // session that a late job notice had woken.
    expect(ledger.state().tasks[0]!.pausedAt).toBeUndefined()
    expect(agent.cancel).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('stops a paused run again when the roster shows its session running', async () => {
    const { ledger } = openLedger()
    const agent = liveAgent({ stubborn: true })
    const { service } = serviceWith(ledger, { agent: () => agent })
    vi.useFakeTimers()
    try {
      await service.apply('pause', { kind: 'pause', taskIds: ['card'] })
      expect(ledger.state().tasks[0]!.pausedAt).toBe(0)
      // The pause's own stop already ran and reset the phase; the watchdog then
      // finds the roster still claiming the session runs and stops it again.
      await service.start()
      await vi.advanceTimersByTimeAsync(5_100)
      expect(agent.setPhase.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
      service.dispose()
    }
  })
})

describe('immediate session stop and the paused card', () => {
  it('settles the running conversation on the spot instead of leaving the card running', async () => {
    const { ledger } = openLedgerForTest()
    const agent = liveAgent()
    const { service } = serviceWith(ledger, { agent: () => agent })
    await service.apply('stop-now', { kind: 'stop-session', taskId: 'card' })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(agent.cancel).toHaveBeenCalledOnce()
    // The clarification run keeps its column, but it is settled at once: the
    // card can no longer read as Running/Queued. The marker refuses adoption of
    // the very session that was stopped.
    const task = ledger.state().tasks[0]!
    expect(task.status).toBe('clarification')
    expect(task.executions[0]!.endedAt).toBe(0)
    expect(task.executions[0]!.result).toBe('cancelled')
    expect(task.stoppedAt).toBe(0)
    expect(task.stoppedSessionId).toBe('session-a')
    service.dispose()
  })

  it('settles a running implementation card as cancelled on a regular stop', async () => {
    const { ledger } = runningLedger()
    const agent = liveAgent()
    const { service } = serviceWith(ledger, { agent: () => agent })
    await service.apply('stop-running', { kind: 'stop-session', taskId: 'card' })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const task = ledger.state().tasks[0]!
    expect(task.status).toBe('clarification')
    expect(task.executions.at(-1)!.endedAt).toBe(0)
    expect(task.executions.at(-1)!.result).toBe('cancelled')
    expect(task.pausedAt).toBeUndefined()
    service.dispose()
  })

  it('settles the run even when the killed session can no longer confirm its end', async () => {
    const { ledger } = runningLedger()
    const { service } = serviceWith(ledger, { agent: () => liveAgent() })
    // The stop RPC never answers (the session was killed): neither a turn end
    // nor a confirmation can arrive. The card must leave `running` nonetheless.
    vi.spyOn(service.runner, 'stopSession').mockReturnValue(new Promise(() => {}))
    await service.apply('hard-stop-killed', { kind: 'hard-stop', taskId: 'card' })
    const task = ledger.state().tasks[0]!
    expect(task.status).toBe('clarification')
    expect(task.executions.at(-1)!.result).toBe('cancelled')
    expect(task.stoppedAt).toBe(0)
    expect(task.stoppedSessionId).toBe('session-a')
    service.dispose()
  })

  it('releases a pause and settles the run when the paused card is stopped', async () => {
    const { ledger } = runningLedger()
    ledger.applyRequest('pause-card', { kind: 'pause', taskIds: ['card'] })
    expect(ledger.state().tasks[0]!.pausedAt).toBe(0)
    const { service } = serviceWith(ledger, { agent: () => liveAgent() })
    await service.apply('stop-paused', { kind: 'stop-session', taskId: 'card' })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const task = ledger.state().tasks[0]!
    expect(task.status).toBe('clarification')
    expect(task.pausedAt).toBeUndefined()
    expect(task.executions.at(-1)!.result).toBe('cancelled')
    service.dispose()
  })

  it('publishes which conversations run, so the card can always offer its stop', async () => {
    const { ledger } = openLedgerForTest()
    const { service } = serviceWith(ledger, { agent: () => liveAgent() })
    vi.useFakeTimers()
    try {
      await service.start()
      await vi.advanceTimersByTimeAsync(100)
      expect(service.snapshot().runningSessions).toEqual({ card: true })
    } finally {
      vi.useRealTimers()
      service.dispose()
    }
  })

  it('treats a human message in a paused conversation as a resume, not as work to kill', async () => {
    const { ledger } = openLedgerForTest()
    const agent = liveAgent({ stubborn: true })
    const { service } = serviceWith(ledger, { agent: () => agent })
    vi.spyOn(service.runner, 'newestHumanTurn').mockResolvedValue({ known: true, at: 7 })
    vi.useFakeTimers()
    try {
      await service.apply('pause', { kind: 'pause', taskIds: ['card'] })
      expect(ledger.state().tasks[0]!.pausedAt).toBe(0)
      await service.start()
      await vi.advanceTimersByTimeAsync(100)
      expect(ledger.state().tasks[0]!.pausedAt).toBeUndefined()
    } finally {
      vi.useRealTimers()
      service.dispose()
    }
  })

  it('stops a conversation that keeps running after the stop without waiting for the adoption window', async () => {
    const { ledger } = openLedgerForTest()
    ledger.stopCard('card', 'session-a', 'Session von der Karte gestoppt.')
    const agent = liveAgent()
    const { service } = serviceWith(ledger, { agent: () => agent })
    vi.useFakeTimers()
    try {
      await service.start()
      // The 5 s pass already stops a stopped session (the adopted card would
      // otherwise wait for the 60 s safety-net poll while claiming no run).
      await vi.advanceTimersByTimeAsync(5_100)
      expect(agent.cancel).toHaveBeenCalled()
      // The card stays settled; a late stop does not revive it.
      expect(ledger.state().tasks[0]!.status).toBe('clarification')
    } finally {
      vi.useRealTimers()
      service.dispose()
    }
  })
})

/** A card in clarification with one open run on `session-a`. */
function openLedgerForTest(): { ledger: HostTaskLedger } {
  const ledger = new HostTaskLedger(root(), () => 0)
  ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
  const moved = ledger.applyRequest('move', { kind: 'move', taskId: 'card', status: 'clarification' })
  const execution = moved.clarification!.execution
  ledger.attachSession('card', execution.id, 'session-a')
  return { ledger }
}

/** A card in `running` whose open implementation run holds `session-a`. */
function runningLedger(): { ledger: HostTaskLedger } {
  const ledger = new HostTaskLedger(root(), () => 0)
  ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
  ledger.applyRequest('to-clarification', { kind: 'move', taskId: 'card', status: 'clarification' })
  const opened = ledger.applyRequest('run-card', { kind: 'run', taskId: 'card' })
  ledger.attachSession('card', opened.run!.execution.id, 'session-a')
  return { ledger }
}

describe('the stop marker keeps a stopped card out of the running column', () => {
  it('refuses to adopt the conversation that was stopped, and the next run clears the marker', () => {
    const { ledger } = openLedgerForTest()
    ledger.settle('card', ledger.state().tasks[0]!.executions[0]!.id, 'succeeded')
    ledger.stopCard('card', 'session-a', 'Session von der Karte gestoppt.')
    expect(ledger.state().tasks[0]!.stoppedAt).toBe(0)
    expect(ledger.sessionWatch()[0]!.stopped).toBe(true)
    // The late event of the stopped conversation is exactly the wake-up the
    // stop removed: no adoption, no return to `running`.
    expect(ledger.adoptRunningSession('card', 'session-a', 'clarify')).toBe(false)
    expect(ledger.state().tasks[0]!.status).toBe('clarification')
    // A deliberate new run is allowed to look at the session again.
    const opened = ledger.applyRequest('run-again', { kind: 'run', taskId: 'card' })
    expect(opened.run).toBeDefined()
    expect(ledger.state().tasks[0]!.stoppedAt).toBeUndefined()
    expect(ledger.state().tasks[0]!.stoppedSessionId).toBeUndefined()
    ledger.dispose()
  })

  it('keeps a conflict-resolution run paused in running, its conflict still in the worktree', () => {
    const { ledger } = openLedgerForTest()
    ledger.settle('card', ledger.state().tasks[0]!.executions[0]!.id, 'succeeded')
    // The release path re-opens the settled card on its conversation for the
    // conflict resolution; stopping it is the merge exception.
    expect(ledger.adoptRunningSession('card', 'session-a', 'merge')).toBe(true)
    expect(ledger.state().tasks[0]!.status).toBe('running')
    ledger.stopCard('card', 'session-a', 'Session hart gestoppt (offline).')
    const task = ledger.state().tasks[0]!
    expect(task.status).toBe('running')
    expect(task.pausedAt).toBe(0)
    // A cancelled merge run is paused, not settled: its conflict stays in the
    // worktree and "Weitermachen" continues this very execution.
    expect(task.executions.at(-1)!.endedAt).toBeUndefined()
    expect(task.executions.at(-1)!.result).toBeUndefined()
    expect(task.stoppedSessionId).toBe('session-a')
    ledger.dispose()
  })
})

describe('TaskBoardHostService.acceptAction', () => {
  it('applies asynchronously, reports the result as an event and sends only the changed card afterwards', async () => {
    const ledger = new HostTaskLedger(root(), () => 0)
    const { service } = serviceWith(ledger, {})
    // Collect what a connected tab would receive: one frame per emit, and
    // every tab of the same emit reads that same frame.
    const frames: Array<ReturnType<typeof service.eventPayload>> = []
    const shared: unknown[] = []
    service.subscribe(() => {
      const frame = service.eventPayload()
      frames.push(frame)
      shared.push(service.eventPayload())
    })
    const accepted = service.acceptAction('request-1', {
      kind: 'create',
      id: 'card',
      input: { title: 'Card', description: '', prompt: '' },
    })
    expect(accepted).toBe(true)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    // The card change and the action result are separate frames, in that order.
    expect(frames[0]!.tasks?.map(task => task.id)).toEqual(['card'])
    expect(frames.at(-1)!.actionResults).toEqual([{ requestId: 'request-1', ok: true, at: 0 }])
    expect(shared[0]).toBe(frames[0])

    // A later change sends only the card it touched, without repeating results.
    await service.apply('move-1', { kind: 'move', taskId: 'card', status: 'clarification' })
    expect(frames.some(frame => frame.tasks?.some(task => task.id === 'card') && frame.revision > frames[0]!.revision)).toBe(true)
    expect(frames.at(-1)!.actionResults).toBeUndefined()
    service.dispose()
  })

  it('reports a refused action instead of throwing into the route', async () => {
    const ledger = new HostTaskLedger(root(), () => 0)
    const { service } = serviceWith(ledger, {})
    service.acceptAction('request-2', { kind: 'move', taskId: 'missing', status: 'running' })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const frame = service.eventPayload()
    expect(frame.actionResults?.[0]).toMatchObject({ requestId: 'request-2', ok: false })
    expect(frame.actionResults?.[0]?.error).toContain('task not found')
    service.dispose()
  })
})
