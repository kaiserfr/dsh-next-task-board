/**
 * Done-column limit (FIFO displacement): a move into `done` that would leave
 * more than N on-board cards there archives the cards that entered `done`
 * earliest — only as many as the limit requires — and never deletes them.
 *
 * The pure gate is covered for exactly N, N+1, and an overshoot of several;
 * the Host ledger integration proves both triggers (a move into `done` and
 * applying a limit to an already over-limit column), the default limit of 9,
 * the FIFO order independent of ledger/array position, that other columns and
 * the surviving order are untouched, and that displaced cards stay in the
 * ledger under the archive view.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTask, withStatus, type TaskRecord, type TaskStatus } from '../src/core/tasks.ts'
import { enforceDoneLimit } from '../src/core/use-cases/done-limit.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-done-'))
  roots.push(root)
  return root
}

function makeTask(id: string, status: TaskStatus, stamp: number): TaskRecord {
  return {
    ...createTask({ title: id, description: '', prompt: id }, stamp, id),
    status,
    updatedAt: stamp,
    ...(status === 'done' ? { doneAt: stamp } : {}),
  }
}

function byId(tasks: readonly TaskRecord[], id: string): TaskRecord {
  const task = tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new Error(`missing task ${id}`)
  return task
}

function onBoardDone(tasks: readonly TaskRecord[]): string[] {
  return tasks.filter(task => task.status === 'done' && task.archivedAt === undefined).map(task => task.id)
}

describe('enforceDoneLimit', () => {
  it('leaves exactly N done tasks untouched', () => {
    const tasks = [makeTask('a', 'done', 1), makeTask('b', 'done', 2)]
    const result = enforceDoneLimit(tasks, 2, 100)
    expect(result.archivedIds).toEqual([])
    expect(result.tasks).toBe(tasks)
  })

  it('archives the oldest task when the limit is exceeded by one', () => {
    const tasks = [makeTask('a', 'done', 1), makeTask('b', 'done', 2), makeTask('c', 'done', 3)]
    const result = enforceDoneLimit(tasks, 2, 100)
    expect(result.archivedIds).toEqual(['a'])
    expect(byId(result.tasks, 'a')).toMatchObject({ status: 'done', archivedAt: 100 })
    expect(byId(result.tasks, 'b').archivedAt).toBeUndefined()
    expect(byId(result.tasks, 'c').archivedAt).toBeUndefined()
    expect(onBoardDone(result.tasks)).toEqual(['b', 'c'])
  })

  it('archives only as many tasks as needed when several are over the limit', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((id, index) => makeTask(id, 'done', index + 1))
    const result = enforceDoneLimit(tasks, 2, 100)
    expect(result.archivedIds).toEqual(['a', 'b', 'c'])
    expect(onBoardDone(result.tasks)).toEqual(['d', 'e'])
    // The ledger keeps every row in its original position; only the marker is added.
    expect(result.tasks.map(task => task.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('follows the done-entry order, not the ledger array position', () => {
    // Array order is newest, oldest, middle; the oldest stamp must still go first.
    const tasks = [makeTask('newest', 'done', 3), makeTask('oldest', 'done', 1), makeTask('middle', 'done', 2)]
    const result = enforceDoneLimit(tasks, 2, 100)
    expect(result.archivedIds).toEqual(['oldest'])
    expect(onBoardDone(result.tasks)).toEqual(['newest', 'middle'])
  })

  it('never touches other columns', () => {
    const tasks = [
      makeTask('backlog', 'backlog', 1),
      makeTask('old', 'done', 2),
      makeTask('failed', 'failed', 3),
      makeTask('fresh', 'done', 4),
      makeTask('review', 'ready_for_test', 5),
    ]
    const result = enforceDoneLimit(tasks, 1, 100)
    expect(result.archivedIds).toEqual(['old'])
    expect(result.tasks.filter(task => task.archivedAt !== undefined).map(task => task.id)).toEqual(['old'])
    expect(onBoardDone(result.tasks)).toEqual(['fresh'])
  })

  it('does not count already-archived done tasks against the limit', () => {
    const archived = { ...makeTask('archived', 'done', 1), archivedAt: 50 }
    const tasks = [archived, makeTask('b', 'done', 2), makeTask('c', 'done', 3)]
    const result = enforceDoneLimit(tasks, 2, 100)
    expect(result.archivedIds).toEqual([])
  })

  it('falls back to updatedAt for a done row without an entry stamp', () => {
    const legacy = { ...createTask({ title: 'legacy', description: '', prompt: '' }, 1, 'legacy'), status: 'done' as const, updatedAt: 5 }
    const tasks = [makeTask('fresh', 'done', 9), legacy]
    const result = enforceDoneLimit(tasks, 1, 100)
    expect(result.archivedIds).toEqual(['legacy'])
  })

  it('disables enforcement for a missing, below-one, or non-finite limit', () => {
    const tasks = [makeTask('a', 'done', 1), makeTask('b', 'done', 2)]
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = enforceDoneLimit(tasks, limit, 100)
      expect(result.archivedIds).toEqual([])
      expect(result.tasks).toBe(tasks)
    }
  })
})

describe('withStatus done stamp', () => {
  it('stamps doneAt on entering done, clears it on leaving, and keeps it on a same-status move', () => {
    const task = makeTask('a', 'ready_for_test', 10)
    const done = withStatus(task, 'done', 20)
    expect(done.doneAt).toBe(20)
    const again = withStatus(done, 'done', 30)
    expect(again.doneAt).toBe(20)
    const reopened = withStatus(again, 'todo', 40)
    expect(reopened.doneAt).toBeUndefined()
  })
})

/** Ledger harness with a controllable clock and unique request ids. */
function harness(maxDoneTasks?: number) {
  let now = NOW
  let sequence = 0
  const ledger = new HostTaskLedger(tempRoot(), () => now, maxDoneTasks === undefined ? {} : { maxDoneTasks })
  const create = (id: string): void => {
    now += 1000
    ledger.applyRequest(`create-${id}`, { kind: 'create', id, input: { title: id, description: '', prompt: id } })
  }
  const move = (id: string, status: TaskStatus): void => {
    now += 1000
    sequence += 1
    ledger.applyRequest(`move-${id}-${status}-${sequence}`, { kind: 'move', taskId: id, status })
  }
  return { ledger, create, move }
}

describe('HostTaskLedger done-column limit', () => {
  it('keeps exactly N done cards and archives none', () => {
    const { ledger, create, move } = harness(2)
    create('a'); create('b'); create('c')
    move('a', 'done'); move('b', 'done')
    expect(onBoardDone(ledger.state().tasks)).toEqual(['a', 'b'])
    expect(ledger.state().tasks.some(task => task.archivedAt !== undefined)).toBe(false)
  })

  it('archives the longest-waiting card when a move exceeds the limit by one', () => {
    const { ledger, create, move } = harness(2)
    create('a'); create('b'); create('c')
    move('a', 'done'); move('b', 'done'); move('c', 'done')
    const tasks = ledger.state().tasks
    expect(onBoardDone(tasks)).toEqual(['b', 'c'])
    // The displaced card is archived, not deleted: same status, still in the ledger.
    expect(byId(tasks, 'a')).toMatchObject({ status: 'done' })
    expect(byId(tasks, 'a').archivedAt).toBeTypeOf('number')
    expect(tasks.map(task => task.id)).toEqual(['a', 'b', 'c'])
  })

  it('trims an over-limit column as soon as the limit is applied', () => {
    // The deployment-visible case: 12 cards are already in Done, then the
    // configured/startup limit of 9 arrives — the column must converge at once,
    // not only on the next move.
    const { ledger, create, move } = harness(12)
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
    for (const id of ids) create(id)
    for (const id of ids) move(id, 'done')
    expect(onBoardDone(ledger.state().tasks)).toHaveLength(12)

    ledger.setMaxDoneTasks(9)
    const tasks = ledger.state().tasks
    expect(onBoardDone(tasks)).toEqual(['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'])
    // The three oldest are archived (not deleted) and still in ledger order.
    expect(byId(tasks, 'a').archivedAt).toBeTypeOf('number')
    expect(byId(tasks, 'b').archivedAt).toBeTypeOf('number')
    expect(byId(tasks, 'c').archivedAt).toBeTypeOf('number')
    expect(byId(tasks, 'd').archivedAt).toBeUndefined()
    expect(tasks.map(task => task.id)).toEqual(ids)
  })

  it('applies the default limit of 9 while moving cards into Done', () => {
    const { ledger, create, move } = harness()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    for (const id of ids) create(id)
    for (const id of ids) move(id, 'done')
    const tasks = ledger.state().tasks
    expect(onBoardDone(tasks)).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
    expect(byId(tasks, 'a').archivedAt).toBeTypeOf('number')
  })

  it('never displaces a card from another column', () => {
    const { ledger, create, move } = harness(1)
    create('done-card'); create('todo-card')
    move('done-card', 'done')
    move('todo-card', 'todo')
    const tasks = ledger.state().tasks
    expect(byId(tasks, 'done-card').archivedAt).toBeUndefined()
    expect(byId(tasks, 'todo-card').status).toBe('todo')
    expect(byId(tasks, 'todo-card').archivedAt).toBeUndefined()
  })
})
