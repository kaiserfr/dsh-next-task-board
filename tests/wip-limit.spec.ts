/**
 * WIP limit: the Host starts queued runs strictly in arrival order and never
 * lets more executions hold a session than `maxConcurrentRuns` (default 1).
 *
 * A slot is held from the moment a run attaches its session until that
 * execution settles — attaching alone does not free it, which is what makes
 * the board serial instead of merely throttled at launch time.
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
 * the test releases it, so concurrency is observable.
 */
function harness(now: number) {
  const ledger = new HostTaskLedger(root(), () => now)
  for (const id of ['a', 'b', 'c']) {
    ledger.applyRequest(`create-${id}`, {
      kind: 'create',
      id,
      input: { title: id.toUpperCase(), description: '', prompt: `work ${id}` },
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
  return { service, ledger, started, releases, run, flush, settleTask }
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
