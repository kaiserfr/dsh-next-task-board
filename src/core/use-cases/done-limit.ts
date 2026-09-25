/**
 * Done-column limit (FIFO displacement). The limit bounds how many on-board
 * cards the `done` column may hold; a move into `done` that would exceed it
 * archives the cards that have been in `done` the longest — never deletes
 * them, and only as many as the limit requires. Archived cards stay in the
 * ledger and remain reachable through the board's archive view.
 */
import type { TaskRecord } from '../tasks.ts'
import { applyArchiveTask } from './task-archive.ts'

/** Result of one Done-limit enforcement pass. */
export interface DoneLimitResult {
  /** The next ledger (array order preserved; displaced cards only gain `archivedAt`). */
  tasks: readonly TaskRecord[]
  /** Ids of the displaced cards, oldest first (empty when the limit already held). */
  archivedIds: readonly string[]
}

/** Order key of the Done queue: the entry stamp, with `updatedAt` for legacy rows. */
export function doneQueuedAt(task: TaskRecord): number {
  return task.doneAt ?? task.updatedAt
}

/**
 * Archive the oldest on-board `done` cards until at most `limit` remain.
 *
 * The FIFO order is {@link doneQueuedAt} ascending, ties broken by the ledger's
 * own array position, so displacement is deterministic. A non-finite or
 * below-one limit disables enforcement instead of emptying the column. Tasks
 * in any other column are never touched, and surviving cards keep their
 * relative order.
 *
 * @param tasks - the current ledger.
 * @param limit - maximum number of on-board `done` cards (configured N).
 * @param now - archive timestamp for the displaced cards.
 */
export function enforceDoneLimit(
  tasks: readonly TaskRecord[],
  limit: number,
  now: number,
): DoneLimitResult {
  if (!Number.isFinite(limit) || limit < 1) return { tasks, archivedIds: [] }
  const done = tasks.filter(task => task.status === 'done' && task.archivedAt === undefined)
  const overflow = done.length - Math.floor(limit)
  if (overflow <= 0) return { tasks, archivedIds: [] }
  const oldest = [...done]
    .map((task, index) => ({ task, index }))
    .sort((a, b) => doneQueuedAt(a.task) - doneQueuedAt(b.task) || a.index - b.index)
    .slice(0, overflow)
  let next = tasks
  const archivedIds: string[] = []
  for (const { task } of oldest) {
    // Reuse the manual archive transition so displacement has identical
    // semantics: status and execution history stay, the schedule is disarmed,
    // and the card remains in the ledger under the archive view.
    const result = applyArchiveTask(next, task.id, now)
    if (!result.archived) continue
    next = result.tasks
    archivedIds.push(task.id)
  }
  return { tasks: next, archivedIds }
}
