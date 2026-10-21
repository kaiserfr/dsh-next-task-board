/**
 * Legacy v1 browser persistence and the store seam used by pure client tests.
 *
 * Production v2 state is Host-authoritative. This backend is retained only to
 * read `dsh.taskBoard.v1` for one-time import; the old value is never removed,
 * so it remains a read-only rollback copy after migration.
 *
 * The seam keeps the backend swappable (e.g. an IndexedDB or a host-file
 * channel later); tests run against the in-memory backend and a jsdom
 * localStorage backend.
 */
import { isValidCron } from './schedule.ts'
import { isTaskPermission, isTaskStatus, normalizeParseText, normalizeTags, normalizeTargetId, type ScheduleRule, type TaskCompose, type TaskFreeze, type TaskGit, type TaskMerge, type TaskRecord, type TaskPermission, type TaskReview, type TaskStatus } from './tasks.ts'
import type { TaskHandover } from './handover.ts'
import { sanitizeFreezeSnapshot } from './freeze-snapshot.ts'
import { sanitizeHandover } from './handover.ts'

/** Persistence seam for the task ledger. */
export interface TaskStore {
  /** Read the persisted ledger (empty when nothing is stored yet). */
  load(): TaskRecord[]
  /** Persist the whole ledger (replaces the stored document). */
  save(tasks: readonly TaskRecord[]): void
  /** Drop the persisted ledger (leaves the in-memory state alone). */
  clear(): void
  /**
   * Subscribe to ledger changes written by ANOTHER tab of the same origin
   * (browser storage events). The board controller reloads the ledger on
   * such a change, so a task deleted in one tab cannot keep firing (or be
   * written back) from the stale in-memory copy of another tab. No-op when
   * the backend has no cross-instance channel (in-memory store).
   */
  subscribeExternal?(listener: () => void): () => void
}

/** Storage key for the task ledger document. */
export const DEFAULT_STORAGE_KEY = 'dsh.taskBoard.v1'

/** Structural shape of the storage event fired in sibling tabs (DOM-free). */
export interface StorageChangeEvent {
  key: string | null
}

/** The event-target face the store needs for cross-tab notifications. */
export interface StorageEvents {
  addEventListener(type: 'storage', listener: (event: StorageChangeEvent) => void): void
  removeEventListener(type: 'storage', listener: (event: StorageChangeEvent) => void): void
}

/**
 * Structural row check with the status left unvalidated (see {@link parseLedger}).
 * The `schedule` field is deliberately NOT checked here: a malformed schedule
 * never drops the task row — {@link normalizeSchedule} repairs or drops the
 * schedule alone.
 */
function isTaskRecordShape(value: unknown): value is Omit<TaskRecord, 'status'> & { status: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return false
  if (typeof record.title !== 'string') return false
  if (typeof record.description !== 'string') return false
  if (typeof record.prompt !== 'string') return false
  if (record.parseText !== undefined && typeof record.parseText !== 'string') return false
  if (typeof record.createdAt !== 'number') return false
  if (typeof record.updatedAt !== 'number') return false
  if (record.workspaceId !== undefined && typeof record.workspaceId !== 'string') return false
  if (record.mode !== undefined && typeof record.mode !== 'string') return false
  if (record.permission !== undefined && typeof record.permission !== 'string') return false
  if (record.reuseSession !== undefined && typeof record.reuseSession !== 'boolean') return false
  if (record.git !== undefined && (typeof record.git !== 'object' || record.git === null)) return false
  if (record.compose !== undefined && (typeof record.compose !== 'object' || record.compose === null)) return false
  if (record.review !== undefined && (typeof record.review !== 'object' || record.review === null)) return false
  if (record.merge !== undefined && (typeof record.merge !== 'object' || record.merge === null)) return false
  if (!Array.isArray(record.executions)) return false
  for (const execution of record.executions) {
    if (typeof execution !== 'object' || execution === null) return false
    const entry = execution as Record<string, unknown>
    if (typeof entry.id !== 'string') return false
    if (entry.sessionId !== undefined && typeof entry.sessionId !== 'string') return false
    if (typeof entry.startedAt !== 'number') return false
    if (entry.endedAt !== undefined && typeof entry.endedAt !== 'number') return false
    if (entry.result !== undefined && entry.result !== 'succeeded' && entry.result !== 'failed' && entry.result !== 'cancelled') return false
    if (entry.error !== undefined && typeof entry.error !== 'string') return false
    if (entry.initiatedBy !== undefined && typeof entry.initiatedBy !== 'string') return false
    if (entry.frozenBy !== undefined && typeof entry.frozenBy !== 'string') return false
    if (entry.frozenAt !== undefined && typeof entry.frozenAt !== 'number') return false
  }
  return true
}

/** A task record is structurally valid if it round-trips through the UI. */
export function isTaskRecord(value: unknown): value is TaskRecord {
  return isTaskRecordShape(value) && isTaskStatus(value.status)
}

/**
 * Normalize a persisted status back into the closed status union. Legacy rows
 * from the board's former `todo` column migrate to `clarification`, whose role
 * they took over; an unknown status from a future version lands in the neutral
 * first column instead of dropping the row.
 */
function normalizeStatus(status: unknown): TaskStatus {
  if (status === 'todo') return 'clarification'
  return isTaskStatus(status) ? status : 'backlog'
}

/**
 * Repair a persisted schedule rule: drop rules without a usable cron string,
 * coerce booleans/numbers, and leave `nextRunAt`/`lastTriggeredAt` undefined
 * when missing (a fresh recompute or the next tick fixes them).
 */
function normalizeSchedule(schedule: unknown): ScheduleRule | undefined {
  if (typeof schedule !== 'object' || schedule === null) return undefined
  const rule = schedule as Record<string, unknown>
  // Reject (drop) a schedule whose cron is not a well-formed 5-field
  // expression: a malformed rule would otherwise linger as a never-firing
  // schedule instead of being dropped for later repair.
  if (typeof rule.cron !== 'string') return undefined
  if (rule.cron.trim() === '' || !isValidCron(rule.cron)) return undefined
  return {
    enabled: rule.enabled === true,
    cron: rule.cron,
    nextRunAt: typeof rule.nextRunAt === 'number' ? rule.nextRunAt : undefined,
    lastTriggeredAt: typeof rule.lastTriggeredAt === 'number' ? rule.lastTriggeredAt : undefined,
  }
}

/**
 * Repair a persisted freeze snapshot: shape + gate re-check (slash taint,
 * redaction idempotence, byte cap); a malformed or tainted snapshot is
 * dropped (undefined) rather than dropping the whole task row, mirroring
 * the schedule repair policy.
 */
function normalizeFreeze(value: unknown): TaskFreeze | undefined {
  const result = sanitizeFreezeSnapshot(value, ['frozenAt', 'redacted', 'frozenBy'])
  if (!result.ok) return undefined
  const frozenAt = result.extras.frozenAt
  if (typeof frozenAt !== 'number' || !Number.isFinite(frozenAt)) return undefined
  if (result.extras.redacted !== undefined && result.extras.redacted !== true) return undefined
  const frozenBy = result.extras.frozenBy
  if (frozenBy !== undefined && (typeof frozenBy !== 'string' || frozenBy === '')) return undefined
  return {
    goal: result.snapshot.goal,
    progress: result.snapshot.progress,
    next: result.snapshot.next,
    frozenAt,
    ...(result.redacted || result.extras.redacted === true ? { redacted: true } : {}),
    ...(frozenBy === undefined ? {} : { frozenBy }),
  }
}

/**
 * Repair a persisted handover bundle: shape re-check through the same gate
 * as the wire path; a malformed bundle is dropped rather than dropping the
 * task row (mirroring the schedule/freeze repair policy).
 */
function normalizeHandover(value: unknown): TaskHandover | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { bundledAt, ...rest } = value as Record<string, unknown> & { bundledAt: unknown }
  const bundle = sanitizeHandover(rest)
  if (bundle === undefined) return undefined
  if (typeof bundledAt !== 'number' || !Number.isFinite(bundledAt)) return undefined
  return { ...bundle, bundledAt }
}

/**
 * Repair a persisted git workflow state: a card without a usable branch/base/
 * worktree triple drops the field (mirroring the schedule/handover repair
 * policy), so a half-written state never sends a merge to the wrong place.
 */
function normalizeGit(value: unknown): TaskGit | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const branch = typeof row.branch === 'string' ? row.branch.trim() : ''
  const base = typeof row.base === 'string' ? row.base.trim() : ''
  const repoPath = typeof row.repoPath === 'string' ? row.repoPath.trim() : ''
  if (branch === '' || base === '' || repoPath === '') return undefined
  const committedAt = typeof row.committedAt === 'number' && Number.isFinite(row.committedAt) ? row.committedAt : undefined
  const mergedAt = typeof row.mergedAt === 'number' && Number.isFinite(row.mergedAt) ? row.mergedAt : undefined
  const reviewedCommit = typeof row.reviewedCommit === 'string' ? row.reviewedCommit.trim() : ''
  const worktreePath = typeof row.worktreePath === 'string' ? row.worktreePath.trim() : ''
  return {
    branch,
    base,
    repoPath,
    ...(committedAt === undefined ? {} : { committedAt }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(reviewedCommit === '' ? {} : { reviewedCommit }),
    ...(worktreePath === '' ? {} : { worktreePath }),
  }
}

/**
 * Repair a persisted merge release: without its release instant there is no
 * release to report, so the field drops (mirroring the git repair policy) and
 * the card reads as "not merged" instead of claiming a merge it cannot date.
 * The stamps and the texts are sanitized but never required.
 */
function normalizeMerge(value: unknown): TaskMerge | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const releasedAt = typeof row.releasedAt === 'number' && Number.isFinite(row.releasedAt) ? row.releasedAt : undefined
  if (releasedAt === undefined) return undefined
  const attempts = typeof row.attempts === 'number' && Number.isFinite(row.attempts) && row.attempts > 0
    ? Math.floor(row.attempts)
    : 0
  const commit = typeof row.commit === 'string' ? row.commit.trim() : ''
  const conflict = typeof row.conflict === 'string' && row.conflict.trim() !== '' ? row.conflict : undefined
  const error = typeof row.error === 'string' && row.error.trim() !== '' ? row.error : undefined
  const resolvedAt = typeof row.resolvedAt === 'number' && Number.isFinite(row.resolvedAt) ? row.resolvedAt : undefined
  const mergedAt = typeof row.mergedAt === 'number' && Number.isFinite(row.mergedAt) ? row.mergedAt : undefined
  return {
    releasedAt,
    attempts,
    ...(commit === '' ? {} : { commit }),
    ...(conflict === undefined ? {} : { conflict }),
    ...(error === undefined ? {} : { error }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(row.skipped === true ? { skipped: true } : {}),
  }
}

/**
 * Repair a persisted compose state: without a project and a file there is
 * nothing to tear down, so the field drops (mirroring the git repair policy).
 * Ports and the error are sanitized but never required.
 */
function normalizeCompose(value: unknown): TaskCompose | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const project = typeof row.project === 'string' ? row.project.trim() : ''
  const file = typeof row.file === 'string' ? row.file.trim() : ''
  if (project === '' || file === '') return undefined
  const startedAt = typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : undefined
  const error = typeof row.error === 'string' && row.error.trim() !== '' ? row.error : undefined
  const ports = Array.isArray(row.ports)
    ? [...new Set(row.ports.filter((port): port is string => typeof port === 'string' && port.trim() !== ''))]
    : undefined
  const env = typeof row.env === 'object' && row.env !== null && !Array.isArray(row.env)
    ? Object.fromEntries(Object.entries(row.env as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  return {
    project,
    file,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(ports === undefined || ports.length === 0 ? {} : { ports }),
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
    ...(error === undefined ? {} : { error }),
  }
}

/**
 * Repair a persisted review environment. The record exists to be stopped and
 * displayed, so it needs a mode, a source and a directory; without them there is
 * nothing to act on and the field drops (the same repair policy the git and
 * compose records follow). Everything the Host re-reads anyway — pending marker,
 * timestamps, ports, env, links, error — is sanitized but never required, and an
 * unknown mode from a future version drops the field instead of guessing at a
 * teardown.
 */
function normalizeReview(value: unknown): TaskReview | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const mode = row.mode === 'compose' ? 'compose' as const : row.mode === 'command' ? 'command' as const : undefined
  const source = typeof row.source === 'string' ? row.source.trim() : ''
  const dir = typeof row.dir === 'string' ? row.dir.trim() : ''
  if (mode === undefined || source === '' || dir === '') return undefined
  const startedAt = typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : undefined
  const stoppedAt = typeof row.stoppedAt === 'number' && Number.isFinite(row.stoppedAt) ? row.stoppedAt : undefined
  const context = typeof row.context === 'string' && row.context.trim() !== '' ? row.context.trim() : undefined
  const error = typeof row.error === 'string' && row.error.trim() !== '' ? row.error : undefined
  const stringsOf = (input: unknown): string[] | undefined => {
    if (!Array.isArray(input)) return undefined
    const values = [...new Set(input.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== ''))]
    return values.length === 0 ? undefined : values
  }
  const ports = stringsOf(row.ports)
  const links = stringsOf(row.links)
  const env = typeof row.env === 'object' && row.env !== null && !Array.isArray(row.env)
    ? Object.fromEntries(Object.entries(row.env as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  return {
    mode,
    source,
    dir,
    ...(context === undefined ? {} : { context }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    ...(ports === undefined ? {} : { ports }),
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
    ...(links === undefined ? {} : { links }),
    ...(error === undefined ? {} : { error }),
  }
}

/** Parse + validate a persisted ledger document; invalid rows are dropped. */export function parseLedger(raw: string | null): TaskRecord[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error('[dsh-task-board] persisted task ledger is not valid JSON; starting empty', error)
    return []
  }
  if (!Array.isArray(parsed)) {
    console.error('[dsh-task-board] persisted task ledger is not an array; starting empty')
    return []
  }
  const tasks: TaskRecord[] = []
  for (const row of parsed) {
    // Status is normalized (the retired `todo` column migrates to clarification
    // and an unknown status from a future version lands in backlog instead of
    // dropping the row); the schedule is repaired field by field; every other
    // field must be valid.
    if (!isTaskRecordShape(row)) {
      console.warn('[dsh-task-board] dropping invalid task row from persisted ledger', row)
      continue
    }
    // Always (re)assign the schedule: a repair that returns undefined must
    // clear a malformed persisted rule rather than leave it in the row.
    const task: TaskRecord = { ...row, status: normalizeStatus(row.status) }
    task.schedule = normalizeSchedule(row.schedule)
    // Execution targets are normalized like the schedule: blank strings
    // clear the pin and unknown permission strings from a future version
    // fall back to the session default instead of dropping the row.
    task.workspaceId = normalizeTargetId(row.workspaceId)
    task.mode = normalizeTargetId(row.mode)
    task.archivedAt = typeof row.archivedAt === 'number' && Number.isFinite(row.archivedAt) ? row.archivedAt : undefined
    // The Done-column FIFO key: kept for a card in `done`, backfilled from
    // `updatedAt` for a legacy row, and cleared on every other status so a card
    // that left Done cannot resurface with a stale queue position.
    task.doneAt = task.status === 'done'
      ? (typeof row.doneAt === 'number' && Number.isFinite(row.doneAt) ? row.doneAt : row.updatedAt)
      : undefined
    task.permission = isTaskPermission(row.permission) ? row.permission as TaskPermission : undefined
    task.reuseSession = row.reuseSession === true ? true : undefined
    task.freeze = normalizeFreeze(row.freeze)
    task.handover = normalizeHandover(row.handover)
    task.git = normalizeGit(row.git)
    task.compose = normalizeCompose(row.compose)
    task.review = normalizeReview(row.review)
    // Tags are repaired field by field like the schedule: a malformed entry is
    // dropped, and a list that repairs to nothing clears the field instead of
    // dropping the task row.
    task.tags = normalizeTags(row.tags)
    task.clarificationSessionId = typeof row.clarificationSessionId === 'string' && row.clarificationSessionId !== ''
      ? row.clarificationSessionId
      : undefined
    // The parse source is repaired like the schedule: a blank or non-string
    // persisted value clears the field instead of dropping the card row.
    task.parseText = normalizeParseText(row.parseText)
    task.permissionConfirmedAt = typeof row.permissionConfirmedAt === 'number' && Number.isFinite(row.permissionConfirmedAt) ? row.permissionConfirmedAt : undefined
    // The retired specification-release stamp is dropped from legacy rows: the
    // release gate no longer exists and no board state reads the old value.
    delete (task as unknown as Record<string, unknown>).specApprovedAt
    // The pause stamp is repaired like the other runtime stamps: a malformed
    // persisted value clears the pause instead of dropping the card row.
    task.pausedAt = typeof row.pausedAt === 'number' && Number.isFinite(row.pausedAt) ? row.pausedAt : undefined
    // The rework stamp is repaired like the other runtime stamps; a count
    // without a stamp is a torn pair and clears with it.
    task.reworkAt = typeof row.reworkAt === 'number' && Number.isFinite(row.reworkAt) ? row.reworkAt : undefined
    task.reworkCount = task.reworkAt === undefined
      ? undefined
      : (typeof row.reworkCount === 'number' && Number.isFinite(row.reworkCount) && row.reworkCount > 0
          ? Math.floor(row.reworkCount)
          : undefined)
    // Execution rows are shape-checked above; only their rework mark and their
    // kind need repair, and an already-clean row keeps its identity (no
    // needless copy per load). An unknown kind drops to a plain run: the mark
    // only ever suppresses the card move, never the execution itself.
    task.executions = row.executions.map((execution) => {
      const rework = execution.rework === true ? true : undefined
      const kind = execution.kind === 'clarify'
        ? 'clarify' as const
        : execution.kind === 'merge' ? 'merge' as const : undefined
      if (rework === execution.rework && kind === execution.kind) return execution
      return { ...execution, rework, kind }
    })
    task.merge = normalizeMerge(row.merge)
    tasks.push(task)
  }
  return tasks
}

/** localStorage-backed store (the browser backend). */
export class LocalStorageTaskStore implements TaskStore {
  /**
   * @param key - storage key for the ledger document.
   * @param storage - storage backend (defaults to the global localStorage; tests inject fakes).
   * @param events - storage-event target for cross-tab notifications (defaults
   *   to the browser global; undefined in non-browser runtimes, where the
   *   subscription becomes a no-op).
   */
  constructor(
    private readonly key: string = DEFAULT_STORAGE_KEY,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.localStorage,
    private readonly events: StorageEvents | undefined = typeof (globalThis as { addEventListener?: unknown }).addEventListener === 'function'
      ? (globalThis as unknown as StorageEvents)
      : undefined,
  ) {}

  load(): TaskRecord[] {
    if (this.storage === undefined) return []
    try {
      return parseLedger(this.storage.getItem(this.key))
    } catch (error) {
      // Storage read failures (private mode, quota) degrade to an empty ledger,
      // never break the board.
      console.error('[dsh-task-board] task ledger read failed; starting empty', error)
      return []
    }
  }

  save(tasks: readonly TaskRecord[]): void {
    if (this.storage === undefined) return
    try {
      this.storage.setItem(this.key, JSON.stringify(tasks))
    } catch (error) {
      // Write failures only skip persistence; in-memory state stays live.
      console.error('[dsh-task-board] task ledger write failed (persistence skipped)', error)
    }
  }

  clear(): void {
    if (this.storage === undefined) return
    try {
      this.storage.removeItem(this.key)
    } catch (error) {
      console.error('[dsh-task-board] task ledger clear failed', error)
    }
  }

  /**
   * Cross-tab change subscription (see {@link TaskStore.subscribeExternal}).
   * The browser fires the storage event in every OTHER tab of the same origin
   * when one tab writes; a null key means the whole storage was cleared. Both
   * cases reload the ledger here; unrelated keys are ignored.
   */
  subscribeExternal(listener: () => void): () => void {
    if (this.events === undefined) return () => {}
    const onStorage = (event: StorageChangeEvent): void => {
      if (event.key !== null && event.key !== this.key) return
      listener()
    }
    this.events.addEventListener('storage', onStorage)
    return () => { this.events?.removeEventListener('storage', onStorage) }
  }
}

/** In-memory backend (tests, and a fallback when storage is unavailable). */
export class InMemoryTaskStore implements TaskStore {
  private ledger: TaskRecord[] = []

  load(): TaskRecord[] {
    return this.ledger.map(task => ({ ...task, executions: [...task.executions] }))
  }

  save(tasks: readonly TaskRecord[]): void {
    this.ledger = tasks.map(task => ({ ...task, executions: [...task.executions] }))
  }

  clear(): void {
    this.ledger = []
  }
}
