/**
 * Update-task use case: apply an editable-field patch (title/description/
 * prompt/the parse source plus the execution targets
 * workspaceId/mode/permission) with a fresh updatedAt. Pure ledger transition
 * (no persistence or notify — the controller orchestrates those).
 *
 * An explicit `undefined` in the patch clears the field (the task falls
 * back to the runtime default); an unknown permission string is ignored so
 * stale UI can never persist a value the execution service rejects.
 */
import { type TaskRecord, type TaskTag } from '../tasks.ts';
import type { FreezeSnapshot } from '../freeze-snapshot.ts';
import type { TaskHandoverInput } from '../handover.ts';
/**
 * Editable fields on a task (the update patch surface). `freeze` replaces the
 * continuation-card snapshot (restamping frozenAt); an explicit null clears it.
 */
export type TaskUpdatePatch = Partial<Pick<TaskRecord, 'title' | 'description' | 'prompt' | 'parseText' | 'workspaceId' | 'mode' | 'permission' | 'model' | 'reuseSession'>> & {
    freeze?: FreezeSnapshot & {
        redacted?: boolean;
    } | null;
    /** Replaces the handover bundle (restamping bundledAt); an explicit null clears it. */
    handover?: TaskHandoverInput | null;
    /**
     * Replaces the task's labels (issue #1521). Unlike the content fields, tags
     * stay editable after the first run: they classify the task and shape the
     * NEXT execution prompt, they are not the record of what already ran. An
     * explicit null (or a list that normalizes to nothing) clears them.
     */
    tags?: TaskTag[] | null;
};
/** The fields that edit the task's content (what the user reads and what the
 * next execution sends). They stay editable while the card is still waiting in
 * a pre-execution column; once it left those columns the recorded content is
 * the record of what happened, so it becomes read-only.
 */
export declare const TASK_CONTENT_FIELDS: readonly ["title", "description", "prompt"];
/**
 * Whether an update patch touches the task's own content. The parse source
 * (`parseText`) counts as content: it is the text the box was filled with and
 * is edited through the same form, so it obeys the same gate.
 */
export declare function hasContentPatch(patch: TaskUpdatePatch): boolean;
/**
 * Whether a task's content may still be edited: the task must be on-board (not
 * archived) and must still sit in one of the pre-execution columns `backlog` or
 * `todo`. Fail-closed everywhere else: a running task holds the content its
 * session reads, and once a card moved on to `ready_for_test`/`done`/`failed`
 * its content is the record of what ran.
 *
 * Earlier attempts do NOT lock the card: a task whose run failed (or was
 * cancelled) and was dragged back to `backlog`/`todo` is preparation again and
 * gets the edit form back — including the "Parse with AI" source text.
 */
export declare function canEditTaskContent(task: TaskRecord): boolean;
/**
 * Apply an update across the ledger. Tasks that do not match the id are left
 * untouched; the matched task receives the patch plus a fresh updatedAt.
 * @param tasks - current ledger.
 * @param id - the task to update.
 * @param patch - editable-field changes.
 * @param now - clock instant (ms epoch).
 */
export declare function applyUpdateTask(tasks: readonly TaskRecord[], id: string, patch: TaskUpdatePatch, now: number): readonly TaskRecord[];
