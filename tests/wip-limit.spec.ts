/**
 * WIP limit: the Host starts queued runs strictly in arrival order within a
 * lane (workspace) and never lets more executions hold a session than
 * `maxConcurrentRuns` (default 1) in that lane. Lanes are independent: runs of
 * different workspaces do not block each other.
 *
 * A slot is held from the moment a run attaches its session until that
 * execution settles — attaching alone does not free it, which is what makes
 * the board serial instead of merely throttled at launch time. Clarification
 * runs (`todo`) are exempt: they never wait for, or hold, a lane slot.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-wip-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

/**
 * Three runnable tasks and a service whose runner holds every launch open until
 * the test releases it, so concurrency is observable. `workspaces` pins task
 * ids to workspace ids, which is what puts them in different WIP lanes.
 */
function harness(now: number, workspaces: Record<string, string> = {}) {
  const ledger = new HostTaskLedger(root(), () => now)
  for (const id of ['a', 'b', 'c']) {
    ledger.applyRequest(`create-${id}`, {
      kind: 'create',
      id,
      input: { title: id.toUpperCase(), description: '', prompt: `work ${id}`, ...(workspaces[id] === undefined ? {} : { workspaceId: workspaces[id] }) },
    })
  }
  const service = new TaskBoardHostService({} as unknown as TypertGateway, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => now,
  })
  const started: string[] = []
  const releases: Array<() => void> = []
  vi.spyOn(service.runner, 'launch').mockImplementation(async (task) => {
    started.push(task.id)
    await new Promise<void>(resolve => releases.push(resolve))
    return `session-${task.id}`
  })
  // The roster the service reads on every poll. `running: false` means the turn
  // is over right now — deliberately not the same as "the run is finished".
  const roster: Array<{ sessionId: string; running: boolean }> = []
  vi.spyOn(service.runner, 'listRunning').mockImplementation(async () => ({
    known: true,
    count: roster.filter(item => item.running).length,
    items: roster as never,
  }))
  // The monitor itself is not under test here: keep inspection and cancellation
  // off the (empty) gateway so the cases only exercise the slot accounting.
  vi.spyOn(service.runner, 'inspect').mockImplementation(async () => ({ outcome: 'pending' }))
  vi.spyOn(service.runner, 'cancel').mockImplementation(async () => {})
  /** One service poll: this is what refreshes the roster the queue used to trust. */
  const poll = async (): Promise<void> => {
    await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
    await flush()
  }
  const run = (id: string): void => {
    service.apply(`run-${id}`, { kind: 'run', taskId: id })
  }
  /** Let the queued microtasks (attach, release, pump) run to completion. */
  const flush = async (): Promise<void> => { await new Promise(resolve => { setTimeout(resolve, 0) }) }
  /** Settle a task's current execution, which is what frees its WIP slot. */
  const settleTask = (id: string): void => {
    const task = ledger.state().tasks.find(candidate => candidate.id === id)
    const execution = task?.executions.at(-1)
    if (execution === undefined) throw new Error(`task ${id} has no execution to settle`)
    ledger.settle(id, execution.id, 'succeeded')
  }
  return { service, ledger, started, releases, roster, run, flush, poll, settleTask }
}

describe('task-board WIP limit', () => {
  it('runs one task at a time by default, in arrival order', async () => {
    const { service, ledger, started, releases, run, flush, settleTask } = harness(Date.now())
    run('a')
    run('b')
    run('c')
    await flush()

    // Only the first run started; the other two wait in the queue, already
    // open as executions without a session (so their cards read as running).
    expect(started).toEqual(['a'])
    expect(ledger.runtimeView().openExecutions.map(execution => execution.sessionId))
      .toEqual([undefined, undefined, undefined])

    releases[0]?.()
    await flush()
    // Attaching a session does not free the slot: the task is still running.
    expect(started).toEqual(['a'])

    settleTask('a')
    await flush()
    expect(started).toEqual(['a', 'b'])

    releases[1]?.()
    await flush()
    settleTask('b')
    await flush()
    expect(started).toEqual(['a', 'b', 'c'])

    releases[2]?.()
    await flush()
    settleTask('c')
    await flush()
    expect(ledger.runtimeView().openExecutions).toEqual([])
    service.dispose()
  })

  it('starts a card pulled into todo without a WIP slot, but still gates its run', async () => {
    const { service, ledger, started, releases, run, flush, settleTask } = harness(Date.now())
    // `a` holds the lane's only slot (default limit 1) and keeps working.
    run('a')
    await flush()
    releases[0]?.()
    await flush()
    expect(started).toEqual(['a'])

    // `todo` is WIP-free: the clarification run starts next to the working run
    // instead of reading Queued.
    service.apply('b-to-todo', { kind: 'move', taskId: 'b', status: 'todo' })
    await flush()
    expect(started).toEqual(['a', 'b'])
    releases[1]?.()
    await flush()
    const clarified = ledger.state().tasks.find(task => task.id === 'b')!
    expect(clarified.status).toBe('todo')
    expect(clarified.executions[0]?.kind).toBe('clarify')
    expect(clarified.executions[0]?.sessionId).toBe('session-b')

    // The clarification run held no slot: settling it leaves `a` untouched, and
    // the card's *implementation* run (the go-ahead) queues behind `a` like any
    // other run of the lane.
    settleTask('b')
    await flush()
    service.apply('b-to-running', { kind: 'move', taskId: 'b', status: 'running' })
    await flush()
    expect(started).toEqual(['a', 'b'])

    // Only `a` settling frees the lane's slot for the implementation.
    settleTask('a')
    await flush()
    expect(started).toEqual(['a', 'b', 'b'])
    for (const release of releases) release()
    await flush()
    service.dispose()
  })

  it('starts up to maxConcurrentRuns at once and queues the rest', async () => {
    const { service, started, releases, run, flush, settleTask } = harness(Date.now())
    service.setMaxConcurrentRuns(2)
    run('a')
    run('b')
    run('c')
    await flush()
    expect(started).toEqual(['a', 'b'])

    releases[0]?.()
    releases[1]?.()
    await flush()
    expect(started).toEqual(['a', 'b'])

    settleTask('a')
    await flush()
    expect(started).toEqual(['a', 'b', 'c'])

    releases[2]?.()
    await flush()
    settleTask('b')
    settleTask('c')
    await flush()
    service.dispose()
  })

  it('enforces the limit per workspace: other lanes are not blocked', async () => {
    // a+b share w1 (serial), c alone in w2 (parallel to w1).
    const { service, started, releases, run, flush, settleTask } = harness(Date.now(), { a: 'w1', b: 'w1', c: 'w2' })
    run('a')
    run('b')
    run('c')
    await flush()
    expect(started).toEqual(['a', 'c'])

    releases[0]?.()
    releases[1]?.()
    await flush()

    // Settling the w2 run frees only w2: w1's queued run stays blocked by a.
    settleTask('c')
    await flush()
    expect(started).toEqual(['a', 'c'])

    // Settling a frees w1, so its own queue advances; w2 is independent again.
    settleTask('a')
    await flush()
    expect(started).toEqual(['a', 'c', 'b'])
    releases[2]?.()
    await flush()
    service.dispose()
  })

  it('does not let a saturated lane hold back later lanes in the queue', async () => {
    // Arrival order a(w1), b(w2), c(w1): b must overtake c because w1 is full.
    const { service, started, releases, run, flush, settleTask } = harness(Date.now(), { a: 'w1', c: 'w1', b: 'w2' })
    run('a')
    run('b')
    run('c')
    await flush()
    expect(started).toEqual(['a', 'b'])

    releases[0]?.()
    releases[1]?.()
    await flush()
    settleTask('a')
    await flush()
    expect(started).toEqual(['a', 'b', 'c'])
    releases[2]?.()
    await flush()
    service.dispose()
  })

  it('applies maxConcurrentRuns independently to every lane', async () => {
    const { service, started, releases, run, flush, settleTask } = harness(Date.now(), { a: 'w1', b: 'w1', c: 'w2' })
    service.setMaxConcurrentRuns(2)
    run('a')
    run('b')
    run('c')
    await flush()
    // w1 has two slots and takes both of its runs; w2 runs in parallel.
    expect(started).toEqual(['a', 'b', 'c'])

    for (const release of releases) release()
    await flush()
    settleTask('a')
    settleTask('b')
    settleTask('c')
    await flush()
    service.dispose()
  })

  it('keeps the lane occupied while the occupant run is open, even when its session is idle', async () => {
    const { service, ledger, started, releases, roster, run, flush, poll, settleTask } = harness(Date.now())
    run('a')
    await flush()
    // `a` holds the lane's slot: its session exists, the turn is over (the agent
    // asked a question mid-task), which the roster reports as idle.
    releases[0]?.()
    await flush()
    roster.push({ sessionId: 'session-a', running: false })
    await poll()
    expect(started).toEqual(['a'])

    // The idle roster must not free the slot: the lane's next run stays queued,
    // or the two would work in the same worktree at the same time.
    run('b')
    await flush()
    expect(started).toEqual(['a'])
    expect(ledger.runtimeView().openExecutions.map(execution => execution.sessionId))
      .toEqual(['session-a', undefined])

    // Only the settle — the run being over for real — frees the lane.
    settleTask('a')
    await flush()
    expect(started).toEqual(['a', 'b'])
    releases[1]?.()
    await flush()
    settleTask('b')
    await flush()
    service.dispose()
  })

  it('frees the lane as soon as the occupant is paused, not only when it settles', async () => {
    const { service, started, releases, roster, run, flush, poll } = harness(Date.now())
    run('a')
    await flush()
    releases[0]?.()
    await flush()
    roster.push({ sessionId: 'session-a', running: true })
    await poll()
    expect(started).toEqual(['a'])

    run('b')
    await flush()
    expect(started).toEqual(['a'])

    // Pausing stops the occupant's session and hands its slot to the queue: the
    // card keeps its column and its open execution, but is no longer working.
    service.apply('pause-all', { kind: 'pause', taskIds: ['a'] })
    await flush()
    expect(started).toEqual(['a', 'b'])
    releases[1]?.()
    await flush()
    service.dispose()
  })

  it('clamps a zero, negative, or non-finite limit to 1', async () => {
    const { service, started, run, flush } = harness(Date.now())
    service.setMaxConcurrentRuns(0)
    service.setMaxConcurrentRuns(-3)
    service.setMaxConcurrentRuns(Number.NaN)
    run('a')
    run('b')
    await flush()
    expect(started).toEqual(['a'])
    service.dispose()
  })
})
