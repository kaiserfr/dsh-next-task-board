/**
 * Testing-column limit: the test runs of the `testing` column obey their own
 * per-workspace limit (`maxTestingRuns`, default 1) — a slot of its own, apart
 * from the implementation limit (`maxConcurrentRuns`). A workspace may therefore
 * implement and test at the same time; a second test of that workspace queues in
 * the same launch queue and starts as soon as the running test settles.
 *
 * The queue is visible the same way the run column's is: an open execution
 * without a session, explained by the lane's holder (see
 * `waitingReasonFor`). A manual move wins over a *queued* test run and discards
 * it; a test run that already attached its session is working and blocks the
 * move like any other run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { createTask, queuedTestExecution, startExecution, waitingReasonFor, type TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 12, 0, 0).getTime()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-testing-wip-'))
  roots.push(root)
  return root
}

/** A service whose runner holds every launch until the test releases it. */
function harness() {
  const ledger = new HostTaskLedger(tempRoot(), () => NOW)
  for (const id of ['a', 'b', 'c']) {
    ledger.applyRequest(`create-${id}`, {
      kind: 'create',
      id,
      input: { title: id.toUpperCase(), description: '', prompt: `work ${id}`, workspaceId: 'w1' },
    })
  }
  const service = new TaskBoardHostService({} as unknown as TypertGateway, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
  })
  const startedRuns: string[] = []
  const startedTests: string[] = []
  const runReleases: Array<() => void> = []
  const testReleases: Array<() => void> = []
  vi.spyOn(service.runner, 'launch').mockImplementation(async (task, options = {}) => {
    if (options.test === true) {
      startedTests.push(task.id)
      await new Promise<void>(resolve => testReleases.push(resolve))
    } else {
      startedRuns.push(task.id)
      await new Promise<void>(resolve => runReleases.push(resolve))
    }
    return `session-${task.id}`
  })
  // The roster the service reads on its polls; the cases here only look at the
  // ledger's open executions, so an empty roster is enough.
  vi.spyOn(service.runner, 'listRunning').mockImplementation(async () => ({ known: true, count: 0, items: [] as never }))
  vi.spyOn(service.runner, 'inspect').mockImplementation(async () => ({ outcome: 'pending' }))
  vi.spyOn(service.runner, 'cancel').mockImplementation(async () => {})
  /** Let the queued microtasks (attach, release, pump) run to completion. */
  const flush = async (): Promise<void> => { await new Promise(resolve => { setTimeout(resolve, 0) }) }
  const task = (id: string): TaskRecord => ledger.state().tasks.find(candidate => candidate.id === id)!
  const open = (id: string) => task(id).executions.at(-1)
  /** Settle one card's newest execution (success parks an implementation in testing). */
  const settle = (id: string, outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): void => {
    const execution = open(id)
    if (execution === undefined) throw new Error(`task ${id} has no execution`)
    ledger.settle(id, execution.id, outcome)
  }
  /** Park a card: run it, attach the session, release the launch, then settle. */
  const park = async (id: string): Promise<void> => {
    void service.apply(`run-${id}`, { kind: 'run', taskId: id })
    await flush()
    runReleases.shift()?.()
    await flush()
    settle(id)
    await flush()
  }
  return { service, ledger, startedRuns, startedTests, runReleases, testReleases, flush, task, open, settle, park }
}

describe('task-board testing WIP limit', () => {
  it('runs one test per workspace, queues the next in arrival order', async () => {
    const { service, ledger, startedRuns, startedTests, testReleases, flush, park, open, settle } = harness()

    // `a` implements, parks in testing and its test run takes the workspace's
    // test slot.
    await park('a')
    expect(ledger.state().tasks.find(task => task.id === 'a')!.status).toBe('testing')
    testReleases.shift()?.()
    await flush()
    expect(startedTests).toEqual(['a'])
    expect(open('a')?.sessionId).toBe('session-a')

    // `b` implements on the freed implementation slot (the test run holds only
    // the test slot) and parks too: its test run must wait.
    await park('b')
    expect(startedRuns).toEqual(['a', 'b'])
    expect(startedTests).toEqual(['a'])
    const waiting = open('b')!
    expect(waiting.kind).toBe('test')
    expect(waiting.sessionId).toBeUndefined()

    // The Host names the wait: the run is in its launch queue, and the board's
    // waiting explanation points at the test that holds the workspace's slot.
    expect(service.snapshot().queued?.b?.reason).toBe('wip')
    const reason = waitingReasonFor(ledger.state().tasks.find(task => task.id === 'b')!, ledger.state().tasks, { maxConcurrentRuns: 1, maxTestingRuns: 1 })
    expect(reason?.blockerTitle).toBe('A')

    // The running test settles: the next test of the same workspace starts.
    settle('a')
    await flush()
    expect(startedTests).toEqual(['a', 'b'])
    testReleases.shift()?.()
    await flush()
    expect(open('b')?.sessionId).toBe('session-b')
    service.dispose()
  })

  it('keeps the test slot independent of the implementation slot', async () => {
    const { service, ledger, startedRuns, startedTests, runReleases, testReleases, flush, park, open } = harness()
    await park('a')
    testReleases.shift()?.()
    await flush()
    expect(open('a')?.kind).toBe('test')
    expect(open('a')?.sessionId).toBe('session-a')

    // The implementation slot of the same workspace is free again: another card
    // implements while `a` still tests. The test limit does not count it.
    void service.apply('run-b', { kind: 'run', taskId: 'b' })
    await flush()
    expect(startedRuns).toEqual(['a', 'b'])
    expect(startedTests).toEqual(['a'])
    runReleases.shift()?.()
    await flush()
    expect(ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')

    // And settling that implementation opens `b`'s test run behind `a`'s.
    void ledger.settle('b', ledger.state().tasks.find(task => task.id === 'b')!.executions.at(-1)!.id, 'succeeded')
    await flush()
    expect(startedTests).toEqual(['a'])
    service.dispose()
  })

  it('starts the queued tests once maxTestingRuns allows them', async () => {
    const { service, ledger, startedTests, testReleases, flush, park, open } = harness()
    await park('a')
    testReleases.shift()?.()
    await flush()
    await park('b')
    expect(startedTests).toEqual(['a'])

    service.setMaxTestingRuns(2)
    await flush()
    expect(startedTests).toEqual(['a', 'b'])
    testReleases.shift()?.()
    await flush()
    expect(open('b')?.sessionId).toBe('session-b')
    expect(service.snapshot().maxTestingRuns).toBe(2)
    service.dispose()
  })

  it('queues the manual "start tests" run like the automatic one', async () => {
    const { service, ledger, startedTests, testReleases, flush, park, task } = harness()
    await park('a')
    testReleases.shift()?.()
    await flush()
    expect(startedTests).toEqual(['a'])

    // A card parked in testing by hand, whose test run the human starts: the
    // workspace's test slot belongs to `a`, so the manual run waits as well.
    void service.apply('move-c', { kind: 'move', taskId: 'c', status: 'testing' })
    await flush()
    expect(task('c').status).toBe('testing')
    void service.apply('start-test-c', { kind: 'start-test', taskId: 'c' })
    await flush()
    expect(startedTests).toEqual(['a'])
    expect(service.snapshot().queued?.c?.reason).toBe('wip')
    service.dispose()
  })
})

describe('a manual move discards a queued test run', () => {
  /** One card parked in testing with an open, session-less test execution. */
  function ledgedCard() {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', {
      kind: 'create',
      id: 'card',
      input: { title: 'Card', description: '', prompt: 'work' },
    })
    const run = ledger.applyRequest('run-card', { kind: 'run', taskId: 'card' }).run!
    ledger.attachSession('card', run.execution.id, 'session-card')
    ledger.settle('card', run.execution.id, 'succeeded', undefined)
    const card = ledger.state().tasks.find(task => task.id === 'card')!
    return { ledger, card, testRun: card.executions.at(-1)! }
  }

  it('settles the waiting test as cancelled and lets the card move', () => {
    const { ledger, card, testRun } = ledgedCard()
    expect(card.status).toBe('testing')
    expect(testRun.kind).toBe('test')
    expect(queuedTestExecution(card)).not.toBeUndefined()

    ledger.applyRequest('move-card', { kind: 'move', taskId: 'card', status: 'tested' })

    const moved = ledger.state().tasks.find(task => task.id === 'card')!
    expect(moved.status).toBe('tested')
    expect(moved.executions.at(-1)?.result).toBe('cancelled')
    expect(queuedTestExecution(moved)).toBeUndefined()
    ledger.dispose()
  })

  it('discards the waiting tests in a group move as well', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    for (const id of ['card', 'other']) {
      ledger.applyRequest(`create-${id}`, {
        kind: 'create',
        id,
        input: { title: id, description: '', prompt: 'work' },
      })
      const run = ledger.applyRequest(`run-${id}`, { kind: 'run', taskId: id }).run!
      ledger.attachSession(id, run.execution.id, `session-${id}`)
      ledger.settle(id, run.execution.id, 'succeeded', undefined)
    }
    // Both cards are parked in testing with their test runs still waiting.
    expect(ledger.state().tasks.map(task => task.status)).toEqual(['testing', 'testing'])

    ledger.applyRequest('move-many', { kind: 'move-many', taskIds: ['card', 'other'], status: 'tested' })

    for (const task of ledger.state().tasks) {
      expect(task.status).toBe('tested')
      expect(task.executions.at(-1)?.result).toBe('cancelled')
      expect(queuedTestExecution(task)).toBeUndefined()
    }
    ledger.dispose()
  })

  it('refuses the move while the test run is working', () => {
    const { ledger, testRun } = ledgedCard()
    ledger.attachSession('card', testRun.id, 'session-test')
    expect(() => ledger.applyRequest('move-card', { kind: 'move', taskId: 'card', status: 'tested' }))
      .toThrow(/running task cannot be moved/)
    expect(ledger.state().tasks.find(task => task.id === 'card')!.status).toBe('testing')
    ledger.dispose()
  })
})

describe('waitingReasonFor is slot-aware', () => {
  function card(id: string, kind: 'run' | 'test', sessionId?: string, workspaceId = 'w1'): TaskRecord {
    const base = createTask({ title: id.toUpperCase(), description: '', prompt: 'work', workspaceId }, NOW, id)
    const opened = startExecution(base, NOW, `exec-${id}`, undefined, kind === 'test' ? 'test' : undefined)
    const execution = { ...opened.execution, ...(sessionId === undefined ? {} : { sessionId }) }
    return { ...opened.task, status: kind === 'test' ? 'testing' : 'running', executions: [execution] }
  }

  it('explains a waiting test with the test that holds the slot', () => {
    const holder = card('a', 'test', 'session-a')
    const waiting = card('b', 'test')
    const running = card('c', 'run', 'session-c')
    const all = [holder, waiting, running]

    const reason = waitingReasonFor(waiting, all, { maxConcurrentRuns: 1, maxTestingRuns: 1 })
    expect(reason?.blockerTitle).toBe('A')
    // The test slot is separate: the implementation of the same lane does not
    // make the test wait, and the test does not make the implementation wait.
    expect(waitingReasonFor({ ...running, executions: [{ ...running.executions[0]!, sessionId: undefined }] }, all, { maxConcurrentRuns: 1, maxTestingRuns: 1 })).toBeUndefined()
    // Raising only the test limit lets the test start, not because of the run slot.
    expect(waitingReasonFor(waiting, all, { maxConcurrentRuns: 1, maxTestingRuns: 2 })).toBeUndefined()
    // A second implementation of the same lane still waits for `maxConcurrentRuns`.
    const second = card('d', 'run')
    expect(waitingReasonFor(second, [...all, second], { maxConcurrentRuns: 1, maxTestingRuns: 2 })?.blockerTitle).toBe('C')
  })
})
