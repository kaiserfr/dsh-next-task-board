/**
 * Done-column limit (FIFO displacement). The limit bounds how many on-board
 * cards the `done` column may hold; a move into `done` that would exceed it
 * archives the cards that have been in `done` the longest — never deletes
 * them, and only as many as the limit requires. Archived cards stay in the
 * ledger and remain reachable through the board's archive view.
 */
import type { TaskRecord } from '../tasks.ts';
/** Result of one Done-limit enforcement pass. */
export interface DoneLimitResult {
    /** The next ledger (array order preserved; displaced cards only gain `archivedAt`). */
    tasks: readonly TaskRecord[];
    /** Ids of the displaced cards, oldest first (empty when the limit already held). */
    archivedIds: readonly string[];
}
/** Order key of the Done queue: the entry stamp, with `updatedAt` for legacy rows. */
export declare function doneQueuedAt(task: TaskRecord): number;
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
export declare function enforceDoneLimit(tasks: readonly TaskRecord[], limit: number, now: number): DoneLimitResult;
