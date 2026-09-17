/**
 * Archive/restore task use case: move a task off the main board and back,
 * whatever its status but `running`. The task keeps its status, execution history, and
 * transcript references, while archiving disarms any schedule so it cannot
 * create more execution records until the user restores and re-enables it.
 */
import type { TaskRecord } from '../tasks.ts';
/** Result of an archive transition. */
export interface ArchiveTaskResult {
    /** The next ledger. */
    tasks: readonly TaskRecord[];
    /** Whether the archive was applied (false = unknown task / not archivable). */
    archived: boolean;
}
/**
 * Archive one task: only a `running` task stays on the board (its runner
 * still owns its lifecycle until the execution settles); every other status
 * can be archived. Archiving disarms a schedule; already-archived tasks are
 * a no-op.
 */
export declare function applyArchiveTask(tasks: readonly TaskRecord[], id: string, now: number): ArchiveTaskResult;
/** Restore one task back onto the main board (clears the archive marker). */
export declare function applyRestoreTask(tasks: readonly TaskRecord[], id: string, now: number): ArchiveTaskResult;
