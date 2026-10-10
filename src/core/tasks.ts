/**
 * Task board domain model: task lifecycle statuses, the task record shape,
 * and the pure transition functions the controller and tests share.
 * Framework-free (no cordis, no runtime imports) so the state machine is
 * unit-testable in isolation.
 */
import type { FreezeSnapshot } from './freeze-snapshot.ts'
import type { TaskHandover, TaskHandoverInput } from './handover.ts'
import { DEFAULT_STATE_MACHINE, type TaskStatus } from './state-machine.ts'

/**
 * Task lifecycle status, one per kanban column. The statuses themselves are
 * defined by the configurable state machine (`core/state-machine.ts`); this
 * module re-exports the vocabulary so task code keeps one import.
 */
export type { TaskStatus }

/**
 * One real execution attempt: the run's own id, the dsh session that ran it
 * (filled once the session is created), and the settled outcome once the
 * session's turn ended.
 */
export interface ExecutionRecord {
  /** Execution attempt id (uuid). */
  id: string
  /** The dsh session that ran this attempt; absent until creation resolves. */
  sessionId: string | undefined
  /** When the run started (ms epoch). */
  startedAt: number
  /** When the run settled; absent while still running. */
  endedAt: number | undefined
  /** Outcome once settled. */
  result: 'succeeded' | 'failed' | 'cancelled' | undefined
  /** Human failure text when the run failed (prompt rejection or agent error). */
  error: string | undefined
  /**
   * Session id of the DSH session that issued the run/rerun action (issue #6
   * audit origin). Client-asserted, not a trust boundary; absent when the run
   * was triggered by cron (source unknown).
   */
  initiatedBy?: string
  /** Freeze instant captured from the card snapshot when the run opened. */
  frozenAt?: number
  /** Freeze source session captured from the card snapshot when the run opened. */
  frozenBy?: string
  /**
   * Whether this run was started to work off a rework: the card had been sent
   * back from `ready_for_test`/`failed` to `todo` (see
   * {@link TaskRecord.reworkAt}) and the human has not started a run since. The
   * correction itself was typed by the human into the card's own conversation,
   * so this mark only carries the two consequences the board owes that round:
   * the run continues that conversation instead of minting a new one, and its
   * opening turn is the rework framing instead of the whole card body.
   */
  rework?: boolean
  /**
   * What this execution is: absent means a normal run (the implementation that
   * walks the card through the run column). `'clarify'` marks the card's
   * clarification run — a real execution (it holds the card's session, the board
   * shows Running/Queued and links it) that settles **without moving the card**:
   * it still sits in `todo` so the human can pull it on to the run column, which
   * continues the very same session.
   */
  kind?: 'clarify'
}

/**
 * Maximum number of execution records retained per task. Older settled runs
 * are trimmed when a new execution starts so per-action ledger cost stays
 * bounded regardless of how often a task ran before.
 */
export const EXECUTION_HISTORY_LIMIT = 20

/**
 * Trim an execution list to at most {@link EXECUTION_HISTORY_LIMIT} records,
 * most recent last. A running (unsettled) execution is never trimmed: the
 * Host monitor and restart recovery depend on the active record, and a task
 * cannot start a new run while one is still open.
 */
export function retainRecentExecutions(executions: readonly ExecutionRecord[]): ExecutionRecord[] {
  if (executions.length <= EXECUTION_HISTORY_LIMIT) return [...executions]
  const open = executions.filter(execution => execution.endedAt === undefined)
  const settled = executions.filter(execution => execution.endedAt !== undefined)
  const keepSettled = Math.max(EXECUTION_HISTORY_LIMIT - open.length, 0)
  return [...settled.slice(Math.max(settled.length - keepSettled, 0)), ...open]
}

/**
 * A scheduled-run rule attached to a task. The Host scheduler triggers the
 * task when `nextRunAt` is due and persists the rule in the Host ledger.
 */
export interface ScheduleRule {
  /** Whether the schedule is armed. */
  enabled: boolean
  /** 5-field cron expression: `分 时 日 月 周`. */
  cron: string
  /** Next due instant (ms epoch); maintained by the scheduler/controller. */
  nextRunAt: number | undefined
  /** Instant of the latest scheduled trigger (ms epoch). */
  lastTriggeredAt: number | undefined
}

/**
 * Git workflow state of a task on the board's feature-branch flow: the branch
 * opened when the card entered `todo`, the branch it was cut from (the merge
 * target), and the worktree it lives in. Absent on cards whose workspace has
 * no git repository (the git integration is opt-in per workspace).
 */
export interface TaskGit {
  /** Feature branch opened for this task. */
  branch: string
  /** Branch the feature branch was cut from and merges back into. */
  base: string
  /** Repository worktree the branches belong to. */
  repoPath: string
  /**
   * When the card's work was last committed onto the feature branch (ms epoch).
   * Written when a card reaches `ready_for_test` (the `git.commitBranch` action
   * and the runner's own settle), so the worktree never keeps uncommitted card
   * work. A park that found nothing to commit leaves the previous instant.
   */
  committedAt?: number
  /** When the feature branch was merged back into `base` (ms epoch). */
  mergedAt?: number
}

/**
 * Frozen context snapshot carried by a continuation card (issue #4): the
 * goal/progress/next text (already sanitized by the freeze gates) plus the
 * freeze instant and the redaction warning flag.
 */
export interface TaskFreeze extends FreezeSnapshot {
  /** When the snapshot was frozen (ms epoch, stamped by the create/update use case). */
  frozenAt: number
  /** True when the freeze gates redacted sensitive patterns out of the text. */
  redacted?: boolean
  /**
   * Session id of the DSH session that authored the frozen snapshot (issue #6
   * provenance): stamped by the Host ledger from the create/update action's
   * initiator, or kept from the wire payload when no initiator was asserted.
   */
  frozenBy?: string
}

/**
 * One task label (issue #1521). The name is the badge and the tag-filter key;
 * the optional prompt line rides the execution prompt, so a label may be
 * display-only (no prefix) or carry an instruction (business-line routing,
 * output directory, house style) that every run of the task inherits.
 */
export interface TaskTag {
  /** Display name; trimmed, non-empty, unique within the task. */
  name: string
  /**
   * Prompt line injected ahead of the execution prompt. Absent (or blank
   * after trimming) keeps the tag display-only: it never touches the prompt,
   * so a label with no prefix has zero execution side effects.
   */
  promptPrefix?: string
}

/** Maximum number of tags carried by one task. */
export const TASK_TAG_LIMIT = 8
/** Maximum length of a tag name. */
export const TAG_NAME_MAX_LENGTH = 32
/** Maximum length of a tag's injected prompt line. */
export const TAG_PROMPT_MAX_LENGTH = 200

/** Whether an unknown value is a well-formed tag (strict: the wire gate). */
export function isTaskTag(value: unknown): value is TaskTag {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const tag = value as Record<string, unknown>
  if (Object.keys(tag).some(key => key !== 'name' && key !== 'promptPrefix')) return false
  if (typeof tag.name !== 'string') return false
  const name = tag.name.trim()
  if (name === '' || name.length > TAG_NAME_MAX_LENGTH) return false
  if (tag.promptPrefix !== undefined && typeof tag.promptPrefix !== 'string') return false
  return tag.promptPrefix === undefined || (tag.promptPrefix as string).trim().length <= TAG_PROMPT_MAX_LENGTH
}

/**
 * Whether an unknown value is a well-formed tag list (strict: the wire gate).
 * An empty list is rejected — clearing tags is expressed by omitting the field
 * (create) or by an explicit null (update), never by an empty array.
 */
export function isTaskTagList(value: unknown): value is TaskTag[] {
  return Array.isArray(value) && value.length > 0 && value.length <= TASK_TAG_LIMIT && value.every(isTaskTag)
}

/**
 * Repair a persisted tag list: keep the well-formed entries, trim, drop
 * blanks and repeats, cap the count, and collapse a blank prompt line to
 * "display-only". Returns undefined when nothing usable remains, so the caller
 * clears the field instead of storing an empty array.
 */
export function normalizeTags(value: unknown): TaskTag[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags: TaskTag[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    if (typeof row.name !== 'string') continue
    const name = row.name.trim()
    if (name === '' || name.length > TAG_NAME_MAX_LENGTH || seen.has(name)) continue
    const raw = typeof row.promptPrefix === 'string' ? row.promptPrefix.trim() : ''
    const promptPrefix = raw === '' ? undefined : raw.slice(0, TAG_PROMPT_MAX_LENGTH)
    seen.add(name)
    tags.push(promptPrefix === undefined ? { name } : { name, promptPrefix })
    if (tags.length >= TASK_TAG_LIMIT) break
  }
  return tags.length === 0 ? undefined : tags
}

/**
 * Stable palette slot (0..5) for a tag name. The same label always lands on the
 * same tone, so a badge needs no stored colour and two tasks sharing a label
 * cannot disagree about it.
 */
export function tagTone(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return hash % 6
}

/**
 * Union of the labels already carried by `tasks`, first occurrence wins (the
 * oldest task's hint is the one offered). Feeds the editor's name datalist and
 * the board's tag filter, so a label defined once can be reused everywhere.
 */
export function collectKnownTags(tasks: readonly TaskRecord[]): TaskTag[] {
  const known: TaskTag[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    for (const tag of task.tags ?? []) {
      if (seen.has(tag.name)) continue
      seen.add(tag.name)
      known.push(tag)
    }
  }
  return known
}

/** One task on the board. */
export interface TaskRecord {
  /** Stable task id (uuid). */
  id: string
  /** Short display title. */
  title: string
  /** Longer human description shown in the detail view. */
  description: string
  /** The prompt sent to dsh when this task is executed. */
  prompt: string
  /**
   * Source text the "Parse with AI" box was filled with (issue #1540). Kept so
   * editing the card can offer the same text again ("parse and fill again")
   * instead of losing it when the modal closes; absent means the box was never
   * used, in which case the edit form seeds itself from title/description/
   * prompt.
   */
  parseText?: string
  /** Current column. */
  status: TaskStatus
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
  /**
   * Execution history retained on the task, most recent last: the latest
   * {@link EXECUTION_HISTORY_LIMIT} attempts, oldest trimmed on append.
   */
  executions: ExecutionRecord[]
  /** Optional scheduled-run rule (absent on tasks without a schedule). */
  schedule?: ScheduleRule
  /**
   * Workspace the execution must run in (a workspace-list id); absent means
   * the recent-workspace fallback at execution time.
   */
  workspaceId?: string
  /**
   * Agent preset the execution session must be composed from (an
   * `agentPreset.list` id); absent means the deployment default.
   */
  mode?: string
  /**
   * Permission preset applied to the execution session through the
   * `/permission <id>` slash command; absent leaves the session default.
   */
  permission?: TaskPermission
  /**
   * Pinned model selection for the execution session (format: "provider/model" or model id);
   * absent falls back to the host default (agent-default-model).
   */
  model?: string
  /**
   * Whether later executions continue in the previous execution's session
   * (issue #1419) instead of minting a fresh conversation per run. Absent or
   * false keeps the historical one-session-per-execution behavior; the reuse
   * itself only happens when that session is idle and still present (see
   * {@link reusableSessionId}).
   */
  reuseSession?: boolean
  /**
   * Rework stamp: a human reviewed the card in `ready_for_test` (or the run
   * landed in `failed`) and sent it back to `todo`. The correction is typed
   * into the card's own conversation — the board keeps no note of its own — so
   * the stamp is the record that the card went through a rework and when.
   *
   * A stamp newer than the card's newest run means that round is still pending:
   * the next run continues the conversation it was written in and opens with
   * the rework framing (see {@link pendingRework}).
   */
  reworkAt?: number
  /** How often the card has been sent back for rework. */
  reworkCount?: number
  /**
   * Frozen context snapshot for a continuation card; absent on plain tasks.
   * Sanitized before it enters the ledger (redaction, slash-command taint,
   * 8 KiB per-field cap) by the protocol gate and re-normalized on load.
   */
  freeze?: TaskFreeze
  /**
   * Handover bundle carried by a continuation card (issue #5): the pinned
   * execution triplet plus doc/script references. Sanitized before it
   * enters the ledger by the protocol gate and re-normalized on load; the
   * bundle's triplet overrides the legacy pin fields at execution time.
   */
  handover?: TaskHandover
  /**
   * Task labels (issue #1521): optional, additive, and absent on every task
   * created before the field existed. A tag whose `promptPrefix` is set is
   * prepended to the execution prompt; a bare name is display and filter only.
   */
  tags?: TaskTag[]
  /**
   * Conversation the card's questions are settled in. Opened by the
   * clarification run of the `backlog → todo` step; the card links to it, and
   * the run that starts the work continues this conversation so the collected
   * answers stay in context. Absent until that session exists.
   */
  clarificationSessionId?: string
  /**
   * Human confirmation stamp for an above-default effective permission
   * (ms epoch). Absent while the binding awaits confirmation; any permission
   * or handover change re-arms the gate by clearing it.
   */
  permissionConfirmedAt?: number
  /**
   * Git feature-branch state for the agentic-programming workflow; absent on
   * cards whose workspace is not a git worktree.
   */
  git?: TaskGit
  /**
   * When the task was archived (ms epoch). Archived tasks keep their status
   * and execution history, leave the main board, and cannot run until restored;
   * absent means on-board.
   */
  archivedAt?: number
  /**
   * When the task last entered the `done` column (ms epoch), cleared on every
   * move out of `done`. The Done-column limit orders displacement by this
   * stamp, so the card that has been in Done longest is archived first (FIFO).
   * Absent on tasks that are not in `done`; a legacy `done` row without it
   * falls back to `updatedAt`.
   */
  doneAt?: number
  /**
   * When the card's open run was paused (ms epoch). A paused card keeps its
   * `running` status and its open execution record — it is simply not worked
   * on: the runner stopped the session and the monitor leaves the run alone
   * until the card is resumed. Resuming clears the stamp and continues the
   * run's conversation with a "continue" turn; no status column changes in
   * either direction.
   */
  pausedAt?: number
}

/**
 * Default maximum number of on-board tasks the `done` column may hold. A move
 * into `done` (or a lowered limit) that would leave more archives the oldest
 * `done` cards (by {@link TaskRecord.doneAt}, FIFO) until the limit holds
 * again. Configurable through the `task-board` settings namespace
 * (`maxDoneTasks`); the limit applies to `done` only.
 */
export const DEFAULT_MAX_DONE_TASKS = 9


/** Permission presets a task may pin on its execution session (the `/permission <id>` ids). */
export const TASK_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One permission preset id. */
export type TaskPermission = typeof TASK_PERMISSIONS[number]

/** Whether an unknown value is a known permission preset id. */
export function isTaskPermission(value: unknown): value is TaskPermission {
  return typeof value === 'string' && (TASK_PERMISSIONS as readonly string[]).includes(value)
}

/** Input for creating a task. */
export interface NewTaskInput {
  title: string
  description: string
  prompt: string
  /** Source text behind the "Parse with AI" box; absent/blank stores nothing. */
  parseText?: string
  /** Workspace the execution must run in; empty/absent = the recent workspace. */
  workspaceId?: string
  /** Agent preset the execution session must be composed from; empty/absent = deployment default. */
  mode?: string
  /** Permission preset applied to the execution session; absent = session default. */
  permission?: TaskPermission
  /** Optional pinned model for the execution session; absent = host default. */
  model?: string
  /** Reuse the previous execution's session for later runs (issue #1419). */
  reuseSession?: boolean
  /**
   * Optional scheduled-run rule requested at creation time (the new-task
   * dialog): an enable flag plus a 5-field cron expression. The create use
   * case arms it only when enabled and the expression is valid.
   */
  schedule?: { enabled: boolean; cron: string }
  /**
   * Optional frozen context snapshot (goal/progress/next, sanitized by the
   * protocol gate) turning the new task into a continuation card.
   */
  freeze?: FreezeSnapshot & { redacted?: boolean; frozenBy?: string }
  /**
   * Optional handover bundle (pinned triplet + doc/script references,
   * sanitized by the protocol gate) attached at creation.
   */
  handover?: TaskHandoverInput
  /**
   * Optional task labels. A tag with a non-blank `promptPrefix` is injected
   * ahead of the execution prompt; a bare name changes nothing at run time.
   */
  tags?: TaskTag[]
  /**
   * Column a new card lands in. Set by the Host from the configured state
   * machine's initial state; absent keeps the shipped `backlog` start.
   */
  initialStatus?: TaskStatus
}

/**
 * The kanban columns, in display order, taken from the default state machine.
 * A configured machine supersedes them (the Host sends its resolved machine to
 * the browser in the snapshot); this list is the fallback both halves share.
 */
export const COLUMNS: readonly { status: TaskStatus; label: string }[] = DEFAULT_STATE_MACHINE.states.map(state => ({
  status: state.status,
  label: state.label ?? state.status,
}))

/** All statuses the ledger knows, in board order (every status has a column in the default machine). */
export const ALL_STATUSES: readonly TaskStatus[] = DEFAULT_STATE_MACHINE.states.map(state => state.status)

/**
 * Statuses a task may be archived from: every status the ledger knows but
 * `running`, whose execution the runner still owns until it settles. A
 * settled-only gate made the duplicate-and-archive flow a silent no-op for
 * scheduled tasks, which return to `todo` after every successful run
 * (issue #1447).
 */
export const ARCHIVABLE_STATUSES: readonly TaskStatus[] = ALL_STATUSES.filter(status => status !== 'running')

/** Brand an unknown string as a status; undefined when it is not one. */
export { isTaskStatus } from './state-machine.ts'

/**
 * Statuses a screenshot diff or a manual move may target by default: every
 * column but `running`, which the runner owns. A configured machine decides
 * this per deployment; this is the shipped machine's answer, kept for code
 * that predates the machine (detail-view buttons).
 */
export const MANUAL_STATUSES: readonly TaskStatus[] = DEFAULT_STATE_MACHINE.states
  .map(state => state.status)
  .filter(status => status !== 'running')

/**
 * Whether the default machine allows a plain manual status move from `from` to
 * `to`. A transition carrying the `run` action is an execution start, not a
 * status move, and is not one of these. Prefer `StateMachine.canTransition`
 * with the deployment's resolved machine; this helper stays for callers that
 * have no machine at hand.
 */
export function canMoveManually(from: TaskStatus, to: TaskStatus): boolean {
  return DEFAULT_STATE_MACHINE.transitions.some(item =>
    item.from === from && item.to === to
    && (item.trigger ?? 'manual') === 'manual'
    && !(item.actions ?? []).includes('run'))
}

/** Normalize one optional execution-target string: trim; blank collapses to undefined. */
export function normalizeTargetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Normalize the stored parse source: trim, and collapse a blank string to
 * undefined so "the text is gone" has exactly one representation. Like the
 * other content strings it is not length-capped here; the parse endpoint caps
 * what it is willing to read ({@link TASK_PARSE_MAX_INPUT} in the Host), and a
 * stored source that outgrew the cap simply fails that parse visibly.
 */
export function normalizeParseText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Whether this move sends the card back for rework: out of the review column
 * (`ready_for_test`) or out of a failed run (`failed`) into `todo`. Every such
 * move is stamped ({@link withReworkStamp}), no matter who fired it — the
 * human's drag/chip or the Host noticing a correction in the card's chat.
 * @param from - the column the card leaves.
 * @param to - the column the card enters.
 */
export function isReworkReturn(from: TaskStatus, to: TaskStatus): boolean {
  return to === 'todo' && (from === 'ready_for_test' || from === 'failed')
}

/**
 * Stamp a rework return onto the card: when it last went back and how often it
 * has. The correction text lives in the card's conversation, never here.
 * @param task - the card being sent back.
 * @param now - the instant of the return.
 */
export function withReworkStamp(task: TaskRecord, now: number): TaskRecord {
  return { ...task, reworkAt: now, reworkCount: (task.reworkCount ?? 0) + 1 }
}

/**
 * Whether the card's latest send-back has not been worked off yet: the rework
 * happened after the newest run opened (a clarification round does not count,
 * it opens no implementation). Only then does the next run owe the round its
 * two consequences — continue the corrected conversation and open with the
 * rework framing. Starting any run consumes the marker by the clock alone, so
 * no extra bookkeeping field can drift.
 * @param task - the card about to run.
 */
export function pendingRework(task: TaskRecord): boolean {
  if (task.reworkAt === undefined) return false
  let newestRunAt = 0
  for (const execution of task.executions) {
    if (execution.kind === 'clarify') continue
    if (execution.startedAt > newestRunAt) newestRunAt = execution.startedAt
  }
  return task.reworkAt > newestRunAt
}

/**
 * WIP lane a task's executions belong to: the effective workspace, with the
 * handover bundle overriding the legacy pin — the same precedence the runner
 * uses to pick the session's workspace. Cards without a pinned workspace share
 * the empty lane, because their real target is only resolved at launch time.
 */
export function taskLane(task: TaskRecord): string {
  return task.handover?.workspaceId ?? task.workspaceId ?? ''
}

/**
 * Build the persisted freeze snapshot from a sanitized input, stamping the
 * freeze instant (shared by the create and update use cases).
 */
export function freezeOf(
  input: FreezeSnapshot & { redacted?: boolean; frozenBy?: string },
  now: number,
): TaskFreeze {
  return {
    goal: input.goal,
    progress: input.progress,
    next: input.next,
    frozenAt: now,
    ...(input.redacted === true ? { redacted: true } : {}),
    ...(input.frozenBy === undefined || input.frozenBy === '' ? {} : { frozenBy: input.frozenBy }),
  }
}

/** Create a task from user input. */
export function createTask(input: NewTaskInput, now: number, id: string): TaskRecord {
  const tags = normalizeTags(input.tags)
  const parseText = normalizeParseText(input.parseText)
  return {
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    ...(parseText === undefined ? {} : { parseText }),
    // New cards start where the state machine says (the shipped machine:
    // `backlog`, pulled into `todo` by hand — that move opens the feature
    // branch).
    status: input.initialStatus ?? 'backlog',
    createdAt: now,
    updatedAt: now,
    executions: [],
    workspaceId: normalizeTargetId(input.workspaceId),
    mode: normalizeTargetId(input.mode),
    permission: isTaskPermission(input.permission) ? input.permission : undefined,
    model: normalizeTargetId(input.model),
    reuseSession: input.reuseSession === true ? true : undefined,
    ...(input.freeze === undefined ? {} : { freeze: freezeOf(input.freeze, now) }),
    ...(input.handover === undefined ? {} : { handover: { ...input.handover, bundledAt: now } }),
    ...(tags === undefined ? {} : { tags }),
  }
}

/**
 * Clone a task with an updated status and a fresh updatedAt. Entering `done`
 * stamps {@link TaskRecord.doneAt} (the FIFO key of the Done-column limit);
 * leaving `done` clears it, so a card that re-enters later counts as newest.
 * A same-status move keeps the stamp, so re-dropping a card on its own column
 * cannot reorder the Done queue.
 */
export function withStatus(task: TaskRecord, status: TaskStatus, now: number): TaskRecord {
  if (status === task.status) return { ...task, status, updatedAt: now }
  return {
    ...task,
    status,
    updatedAt: now,
    doneAt: status === 'done' ? now : undefined,
  }
}

/**
 * Merge a schedule patch into a task's schedule rule (creating it when
 * absent), with a fresh updatedAt. Keys present in the patch overwrite the
 * current value — including explicit `undefined`, which clears a field (used
 * to disarm `nextRunAt`); absent keys keep their current value.
 */
export function withSchedule(
  task: TaskRecord,
  patch: Partial<ScheduleRule>,
  now: number,
): TaskRecord {
  const current = task.schedule
  const schedule: ScheduleRule = {
    enabled: current?.enabled ?? false,
    cron: current?.cron ?? '',
    nextRunAt: current?.nextRunAt,
    lastTriggeredAt: current?.lastTriggeredAt,
  }
  if ('enabled' in patch) schedule.enabled = patch.enabled ?? false
  if ('cron' in patch) schedule.cron = patch.cron ?? ''
  if ('nextRunAt' in patch) schedule.nextRunAt = patch.nextRunAt
  if ('lastTriggeredAt' in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt
  return { ...task, updatedAt: now, schedule }
}

/**
 * Open a fresh execution on a task: move it to 'running' and append a
 * running execution record. Returns the new task and the new execution.
 *
 * `kind: 'clarify'` opens the card's *clarification run* instead: the execution
 * is a real one (the WIP-free todo run — it starts without waiting for a lane
 * slot, and the board shows the card as Running and links the session), but the
 * card keeps its column — the clarification must not leave `todo`, because the
 * human pulls it on to the run column afterwards.
 */
export function startExecution(
  task: TaskRecord,
  now: number,
  executionId: string,
  initiatedBy?: string,
  kind?: 'clarify',
): { task: TaskRecord; execution: ExecutionRecord } {
  const clarification = kind === 'clarify'
  const execution: ExecutionRecord = {
    id: executionId,
    sessionId: undefined,
    startedAt: now,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    ...(clarification ? { kind: 'clarify' as const } : {}),
    ...(initiatedBy === undefined || initiatedBy === '' ? {} : { initiatedBy }),
    // The run records how it was started: a run that works off a send-back
    // continues the corrected conversation and opens with the rework framing.
    // A clarification is not that round: it must not consume the marker the
    // implementation run still has to honour.
    ...(clarification || !pendingRework(task) ? {} : { rework: true }),
    // Capture the card's freeze provenance on the execution record so the
    // audit trail stays queryable even if the snapshot is replaced later.
    ...(task.freeze === undefined ? {} : {
      frozenAt: task.freeze.frozenAt,
      ...(task.freeze.frozenBy === undefined ? {} : { frozenBy: task.freeze.frozenBy }),
    }),
  }
  return {
    task: {
      ...task,
      ...(clarification ? {} : { status: 'running' as TaskStatus }),
      updatedAt: now,
      // A fresh run is never a continuation of a pause: the stamp only ever
      // describes the run that is open right now.
      pausedAt: undefined,
      executions: retainRecentExecutions([...task.executions, execution]),
    },
    execution,
  }
}

/**
 * Settle a running execution: record the outcome and move the task into the
 * matching column. No-op (returns the input task) when the execution is not
 * the task's latest or is already settled.
 *
 * The caller owns the timing: `'succeeded'` — the `ready_for_test` park — is
 * passed only after the execution's session has ended (see
 * `HostExecutionRunner.inspect`), never on an intermediate turn boundary of a
 * session that is still working.
 *
 * A clarification run is the exception: its outcome is recorded, but the card
 * keeps its column. Settling a chat must never park the card in
 * `ready_for_test`/`failed`; it waits in `todo` for the human to pull it on.
 */
export function settleExecution(
  task: TaskRecord,
  executionId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  now: number,
  error: string | undefined,
): TaskRecord {
  const index = task.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return task
  const execution = task.executions[index]
  if (execution.endedAt !== undefined) return task
  const settled: ExecutionRecord = { ...execution, endedAt: now, result: outcome, error }
  const executions = [...task.executions]
  executions[index] = settled
  const status: TaskStatus = execution.kind === 'clarify'
    ? task.status
    : outcome === 'succeeded'
      ? 'ready_for_test'
      : outcome === 'failed' ? 'failed'
        : task.status === 'running' ? 'todo' : task.status
  return { ...task, status, updatedAt: now, pausedAt: undefined, executions }
}

/** Whether the card's open run is paused (still `running`, but not worked on). */
export function isTaskPaused(task: TaskRecord): boolean {
  return task.pausedAt !== undefined
}

/**
 * The card's open (unsettled) run, or undefined when the newest execution has
 * already settled. At most one run is open at a time: the ledger refuses a new
 * run while one is open.
 */
export function openExecution(task: TaskRecord): ExecutionRecord | undefined {
  const latest = task.executions[task.executions.length - 1]
  return latest !== undefined && latest.endedAt === undefined ? latest : undefined
}

/**
 * Whether the card carries an open *run* (a real execution, not one of its
 * clarification runs). A clarification deliberately does not block: the human
 * keeps the card draggable while the chat is still going, and pulls it on to
 * the run column without waiting for it to come to rest.
 */
export function hasOpenRun(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined && execution.kind !== 'clarify')
}

/**
 * Pause or resume the card's open run: stamp {@link TaskRecord.pausedAt} or
 * clear it. The status column is deliberately not touched — a paused card stays
 * in "In progress" so it can be resumed later. Pausing an already-paused card
 * keeps the original stamp (idempotent); resuming a running card is a no-op.
 */
export function withPause(task: TaskRecord, paused: boolean, now: number): TaskRecord {
  if (paused) return { ...task, pausedAt: task.pausedAt ?? now, updatedAt: now }
  if (task.pausedAt === undefined) return task
  return { ...task, pausedAt: undefined, updatedAt: now }
}

/**
 * Whether a task is being executed right now: its latest run is still open,
 * has already attached its dsh session, and the card is not paused. A card that
 * sits in a runner-owned column with an open run but no session yet is only
 * waiting for a free WIP slot (queued) — the board marks "running now" and
 * "waiting" differently, so this predicate is the single answer to which is
 * which. A `todo` clarification run never waits for a slot, so it is only
 * session-less for the moment its launch takes. A paused card keeps its open run and its column, but it is neither
 * running now nor waiting for a slot: its session was stopped.
 */
export function isTaskExecuting(task: TaskRecord): boolean {
  const latest = task.executions[task.executions.length - 1]
  return latest !== undefined && latest.endedAt === undefined && latest.sessionId !== undefined && task.pausedAt === undefined
}

/**
 * When the task's current run was opened (ms epoch): the arrival key of the
 * runner-owned column's FIFO order. Falls back to the last mutation for a card
 * that carries no execution record at all.
 */
export function runArrivalAt(task: TaskRecord): number {
  return task.executions[task.executions.length - 1]?.startedAt ?? task.updatedAt
}

/**
 * Order a runner-owned (WIP) column: the card being executed now comes first —
 * the user must see what is running without hunting for it — then the queued
 * cards in arrival order, so a card dragged in later sits below the ones that
 * were already waiting and the newest arrival lands at the bottom.
 */
export function compareWipOrder(left: TaskRecord, right: TaskRecord): number {
  const rank = (isTaskExecuting(right) ? 1 : 0) - (isTaskExecuting(left) ? 1 : 0)
  return rank !== 0 ? rank : runArrivalAt(left) - runArrivalAt(right)
}

/**
 * Why a card is waiting for its lane's WIP slot, or undefined when it is not
 * waiting at all. A card waits when it carries an open *implementation*
 * execution that has not attached a session yet, while another card of the same
 * lane holds the lane's slot — the state the Host's launch queue leaves it in.
 *
 * This is presentation data for the board's waiting badge; the Host remains the
 * authority on whether a launch starts. The strings are task titles: resolving
 * the workspace's display name is the caller's business.
 */
export interface WaitingReason {
  /** Title of the card that holds the lane's slot. */
  blockerTitle: string
  /** The lane in question ('' for cards without a pinned workspace). */
  lane: string
}

/**
 * Whether one card holds the given lane's WIP slot: an open implementation
 * execution that already attached its session, on a card that is not paused.
 * That is exactly the state the Host's launch queue counts, so the board's
 * explanation and the Host's gate agree.
 */
function holdsLaneSlot(task: TaskRecord): boolean {
  if (task.archivedAt !== undefined || task.pausedAt !== undefined) return false
  const latest = task.executions[task.executions.length - 1]
  if (latest === undefined || latest.endedAt !== undefined) return false
  return latest.kind !== 'clarify' && latest.sessionId !== undefined
}

/**
 * The cards that hold a lane's WIP slots, in board order: an open
 * implementation execution that already attached its session, on a card that is
 * not paused. That is exactly the state the Host's launch queue counts, so the
 * board's explanation and the Host's gate agree.
 */
function laneSlotHolders(lane: string, allTasks: readonly TaskRecord[]): TaskRecord[] {
  const holders: TaskRecord[] = []
  for (const other of allTasks) {
    if (other.archivedAt !== undefined || other.pausedAt !== undefined) continue
    if (taskLane(other) !== lane || !holdsLaneSlot(other)) continue
    holders.push(other)
  }
  return holders
}

/**
 * The waiting reason of one card, or undefined when its lane has room. Mirrors
 * the Host's slot accounting: a clarification run is WIP-free, a paused card
 * released its slot, and a settled execution holds nothing. The lane is
 * saturated when as many cards hold its slot as the limit allows; the card that
 * blocks is the first holder found.
 *
 * Deliberately says nothing about the card's own execution record: a card that
 * was just dropped has none yet, while a card already in the queue has one — in
 * both cases the reason is the lane, not the card.
 *
 * @param task - the card to explain (its lane is what matters).
 * @param allTasks - every board card (the holders are looked up here).
 * @param maxConcurrentRuns - the enforced per-lane limit (>= 1).
 */
export function waitingReasonFor(
  task: TaskRecord,
  allTasks: readonly TaskRecord[],
  maxConcurrentRuns: number,
): WaitingReason | undefined {
  const lane = taskLane(task)
  const holders = laneSlotHolders(lane, allTasks).filter(holder => holder.id !== task.id)
  if (holders.length < Math.max(1, maxConcurrentRuns)) return undefined
  const blocker = holders[0]
  return blocker === undefined ? undefined : { blockerTitle: blocker.title, lane }
}

/** A settled-execution summary string for the detail view. */
export function executionLabel(execution: ExecutionRecord): string {
  if (execution.result === 'succeeded') return 'succeeded'
  if (execution.result === 'failed') return 'failed'
  if (execution.result === 'cancelled') return 'cancelled'
  return 'running'
}
