import { type BoardController } from '../../core/controller.ts';
import { type TaskRecord } from '../../core/tasks.ts';
/** Sentinel option value of the project row's "register a new project" entry. */
export declare const NEW_PROJECT_VALUE = "__dsh_new_project__";
/**
 * Drag payload MIME type carrying the whole group: a JSON array of card ids in
 * board (display) order. `text/plain` keeps the lead card's id so an external
 * drop target, an older board, or a plain single-card drag still works.
 */
export declare const BATCH_DRAG_MIME = "application/x-dsh-taskboard-cards";
/**
 * The notice for a drop on the run column whose cards cannot start yet, or
 * undefined when at least one of them starts now. `todo` and the review columns
 * are WIP-free, so only the cards whose lane is held by another run count; they
 * keep their place in the lane's FIFO queue and start on their own. Exported
 * for the test that pins the wording against a blocked lane.
 */
export declare function queuedDropNotice(tasks: readonly TaskRecord[], allTasks: readonly TaskRecord[], maxConcurrentRuns: number, workspaceTitles: ReadonlyMap<string, string>): string | undefined;
/**
 * The dragged card ids: the batch payload when present and well-formed, else
 * the lead id from `text/plain` (single-card drags and older writers).
 */
export declare function readDragIds(dataTransfer: DataTransfer, lead: string): string[];
/** Case-insensitive title/description/tag/freeze-snapshot match. */
export declare function matchesFilter(task: TaskRecord, filter: string): boolean;
/**
 * Whether a task carries every selected label (issue #1521). Multi-select is
 * conjunctive: adding a label narrows the board instead of widening it, which
 * is the only reading that keeps "工作" selected from dragging unrelated cards
 * back in when a second label is added.
 */
export declare function matchesTagFilter(task: TaskRecord, selected: readonly string[]): boolean;
/** Board component; subscribes to the controller snapshot. */
export declare function TaskBoard({ controller }: {
    controller: BoardController;
}): import("react").JSX.Element;
