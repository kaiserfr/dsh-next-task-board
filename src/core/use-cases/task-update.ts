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
import { freezeOf, isTaskPermission, normalizeParseText, normalizeTags, normalizeTargetId, type TaskRecord, type TaskPermission, type TaskTag } from '../tasks.ts'
import type { FreezeSnapshot } from '../freeze-snapshot.ts'
import type { TaskHandoverInput } from '../handover.ts'

/**
 * Editable fields on a task (the update patch surface). `freeze` replaces the
 * continuation-card snapshot (restamping frozenAt); an explicit null clears it.
 */
export type TaskUpdatePatch = Partial<Pick<TaskRecord, 'title' | 'description' | 'prompt' | 'parseText' | 'workspaceId' | 'mode' | 'permission' | 'model' | 'reuseSession'>> & {
  freeze?: FreezeSnapshot & { redacted?: boolean } | null
  /** Replaces the handover bundle (restamping bundledAt); an explicit null clears it. */
  handover?: TaskHandoverInput | null
  /**
   * Replaces the task's labels (issue #1521). Unlike the content fields, tags
   * stay editable after the first run: they classify the task and shape the
   * NEXT execution prompt, they are not the record of what already ran. An
   * explicit null (or a list that normalizes to nothing) clears them.
   */
  tags?: TaskTag[] | null
}

/** The fields that edit the task's content (what the user reads and what the
 * next execution sends). They stay editable while the card is still waiting in
 * a pre-execution column; once it left those columns the recorded content is
 * the record of what happened, so it becomes read-only.
 */
export const TASK_CONTENT_FIELDS = ['title', 'description', 'prompt'] as const

/**
 * Whether an update patch touches the task's own content. The parse source
 * (`parseText`) counts as content: it is the text the box was filled with and
 * is edited through the same form, so it obeys the same gate.
 */
export function hasContentPatch(patch: TaskUpdatePatch): boolean {
  return 'parseText' in patch || (TASK_CONTENT_FIELDS as readonly string[]).some(field => field in patch)
}

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
export function canEditTaskContent(task: TaskRecord): boolean {
  return task.archivedAt === undefined && (task.status === 'backlog' || task.status === 'todo')
}

/** Keep an unknown permission string from entering the ledger. */
function normalizePermission(
  current: TaskPermission | undefined,
  value: TaskPermission | undefined,
): TaskPermission | undefined {
  if (value === undefined) return undefined
  return isTaskPermission(value) ? value : current
}

/**
 * Apply an update across the ledger. Tasks that do not match the id are left
 * untouched; the matched task receives the patch plus a fresh updatedAt.
 * @param tasks - current ledger.
 * @param id - the task to update.
 * @param patch - editable-field changes.
 * @param now - clock instant (ms epoch).
 */
export function applyUpdateTask(
  tasks: readonly TaskRecord[],
  id: string,
  patch: TaskUpdatePatch,
  now: number,
): readonly TaskRecord[] {
  return tasks.map(task => {
    if (task.id !== id) return task
    const { freeze: freezePatch, handover: handoverPatch, tags: tagsPatch, parseText: parseTextPatch, ...rest } = patch
    const workspaceId = 'workspaceId' in patch ? normalizeTargetId(patch.workspaceId) : undefined
    const mode = 'mode' in patch ? normalizeTargetId(patch.mode) : undefined
    const permission = 'permission' in patch ? normalizePermission(task.permission, patch.permission) : undefined
    const model = 'model' in patch ? normalizeTargetId(patch.model) : undefined
    const next: TaskRecord = { ...task, ...rest, updatedAt: now }
    // Content fields normalize like creation does (trimmed); an explicit
    // undefined keeps the current value — content cannot be cleared.
    for (const field of TASK_CONTENT_FIELDS) {
      if (!(field in patch)) continue
      const value = patch[field]
      next[field] = value === undefined ? task[field] : value.trim()
    }
    // The parse source follows the same gate, but normalizes like creation:
    // blank (or an explicit undefined) clears it, so "the text is gone" has
    // exactly one representation for the edit form's fallback seed to key on.
    if ('parseText' in patch) next.parseText = normalizeParseText(parseTextPatch)
    // null (or a vanished key value) clears the snapshot; a present object
    // replaces it with a fresh frozenAt stamp.
    next.freeze = freezePatch == null ? undefined : freezeOf(freezePatch, now)
    // Handover follows the same null-clears convention, restamping bundledAt.
    next.handover = handoverPatch == null ? undefined : { ...handoverPatch, bundledAt: now }
    // Tags use the same convention: a present array replaces the set (after
    // repair), an explicit null or a fully-invalid list clears it.
    if ('tags' in patch) next.tags = tagsPatch == null ? undefined : normalizeTags(tagsPatch)
    // The permission confirmation binds the exact permission value: a change
    // of the pinned permission or of the handover bundle re-arms the gate
    // (blocking confirm-then-swap escalation). handover was destructured out
    // of rest above, so the stamp survives only when explicitly kept.
    if (('permission' in patch && patch.permission !== undefined && patch.permission !== task.permission) || 'handover' in patch) {
      next.permissionConfirmedAt = undefined
    }
    // Session reuse is a boolean opt-in; false (or an explicit null from a
    // caller that needs to clear it) returns the task to one session per run.
    if ('reuseSession' in patch) next.reuseSession = patch.reuseSession === true ? true : undefined
    if (workspaceId !== undefined || 'workspaceId' in patch) next.workspaceId = workspaceId
    if (mode !== undefined || 'mode' in patch) next.mode = mode
    if (permission !== undefined || 'permission' in patch) next.permission = permission
    if (model !== undefined || 'model' in patch) next.model = model
    return next
  })
}
