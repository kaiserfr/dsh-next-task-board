/**
 * Board controller: the single owner of task-ledger state and view state.
 *
 * In production it projects the Host ledger and submits confirmed actions;
 * the legacy store seam remains for v1 migration tests. The board closes
 * only on explicit user navigation, never implicitly on session-list churn.
 * Framework-free (structural runtime faces) so the whole orchestration is
 * unit-testable with fakes.
 *
 * The per use-case domain transitions (create/update/delete/schedule) live in
 * dedicated modules under core/use-cases and are applied here; the controller
 * owns only the orchestration seam (state, persistence, notify, navigation).
 */
import type { TaskStore } from './store.ts'
import { resolveStateMachine } from './state-machine.ts'
import { withStatus, type NewTaskInput, type TaskRecord, type TaskStatus } from './tasks.ts'
import {
  transitionBlockerOf,
  type QueuedTransition,
  type TransitionBlocker,
  type TransitionError,
} from './transitions.ts'
import { applyArchiveTask, applyRestoreTask } from './use-cases/task-archive.ts'
import { applyCreateTask } from './use-cases/task-create.ts'
import { applyDeleteTask } from './use-cases/task-delete.ts'
import { applyScheduleNextRun as applyScheduleRollForward, applySetSchedule } from './use-cases/task-schedule.ts'
import { applyUpdateTask, type TaskUpdatePatch } from './use-cases/task-update.ts'
import type {
  TaskBoardAction,
  TaskBoardEventPayload,
  TaskBoardNotice,
  TaskBoardParseDraft,
  TaskBoardParseRequest,
  TaskBoardReviewRequest,
  TaskBoardReviewResponse,
  TaskBoardSnapshot,
} from '../protocol.ts'

export interface TaskBoardTransport {
  bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>
  state(): Promise<TaskBoardSnapshot>
  /**
   * Submit one action; the optional initiator is the current DSH session id
   * (issue #6 audit origin), asserted by the client and recorded by the Host.
   * The optional requestId makes a retry idempotent: the outbox reuses the id
   * when it resends an action after a connection failure, and the ledger's
   * persisted request cache then returns the already-applied result instead of
   * applying it twice.
   */
  action(action: TaskBoardAction, initiator?: string, requestId?: string): Promise<TaskBoardSnapshot>
  subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void
  /**
   * One-shot model parse of pasted text (issue #1540). Optional: a deployment
   * that cannot parse simply omits it, and the form hides the section.
   */
  parseDraft?(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>
  /**
   * One review read (open the worktree, snapshot the logs, diff the reviewed
   * commit). Optional like {@link TaskBoardTransport.parseDraft}: a Host that
   * predates the review block omits it, and the panel then only shows what it
   * can derive from the snapshot itself.
   */
  reviewOp?(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse>
}

/** The sessions face the controller needs for navigation awareness. */
export interface SessionsControllerFace {
  list: {
    getSnapshot(): { current: string | undefined }
    subscribe(fn: () => void): () => void
  }
  /** Select a session as current (navigates the conversation view). */
  open(id: string): void
  /**
   * Re-pull the host-authoritative session roster. Used to reach an inactive
   * session the local roster has not pulled yet; absent in the legacy/test
   * face, where a failed open is reported instead.
   */
  refresh?: () => Promise<void>
}

function currentOf(sessions: SessionsControllerFace | undefined): string | undefined {
  return sessions?.list.getSnapshot().current
}

/** Controller dependencies (all swappable in tests). */
export interface ControllerDeps {
  store: TaskStore
  sessions: SessionsControllerFace
  /** Clock; defaults to Date.now. */
  now?: () => number
  /** Id minting; defaults to a random-uuid. */
  uuid?: () => string
  /** Host-authoritative transport; absent keeps the legacy in-memory test path. */
  transport?: TaskBoardTransport
}

/**
 * Register one host directory as a DSH project (workspace). Wired by the
 * browser apply() to the runtime's workspace controller; without it the board
 * hides its "new project" action instead of offering a dead control (#1536).
 */
export type WorkspaceCreator = (path: string) => Promise<{ workspaceId: string }>

/** One workspace option the execution-target pickers offer. */
export interface ExecutionWorkspaceOption {
  workspaceId: string
  /** Display label (workspace title; the wiring falls back to the path). */
  title: string
}

/** One agent-preset option the execution-target pickers offer. */
export interface ExecutionPresetOption {
  id: string
  name?: string
  description?: string
  /** Why this preset cannot compose a session; the pickers disable it. */
  broken?: string
  isDefault: boolean
}

/** One model option the execution-target pickers offer. */
export interface ExecutionModelOption {
  id: string
  name?: string
  label?: string
  provider?: string
}

/** The execution-target option sets the UI feeds into the controller. */
export interface ExecutionOptionsSnapshot {
  workspaces: readonly ExecutionWorkspaceOption[]
  presets: readonly ExecutionPresetOption[]
  models?: readonly ExecutionModelOption[]
}

/**
 * One user-facing message the board renders as a toast: a status refusal
 * (a move the state machine does not allow, an archived/running card), a Host
 * rejection returned by the ledger, or a derived Host notice (a background git
 * failure). Messages are generated where the knowledge lives; the board only
 * displays and dismisses them.
 */
export interface BoardNotice {
  id: string
  kind: 'refused' | 'failed' | 'host'
  message: string
  taskId?: string
  at: number
}

/** The outbox's public face: how many actions wait, and why the last send failed. */
export interface OutboxSnapshot {
  /** Actions accepted by the UI but not yet confirmed by the Host. */
  pending: number
  /** Last transport failure; the outbox keeps retrying and the banner explains it. */
  error?: string
}

/** Immutable controller snapshot for UI subscriptions. */
export interface ControllerSnapshot {
  tasks: readonly TaskRecord[]
  boardOpen: boolean
  /** True when the board shows the archive view instead of the columns. */
  archiveView: boolean
  selectedTaskId: string | undefined
  /** Picker option sets (workspace list + agent-preset roster). */
  executionOptions: ExecutionOptionsSnapshot
  pendingTaskIds: readonly string[]
  /** Actions accepted locally and still waiting for the Host, plus the last transport error. */
  outbox?: OutboxSnapshot
  /** Recent user-facing messages (refusals, Host rejections, background failures). */
  notices?: readonly BoardNotice[]
  /**
   * Transition intents waiting for their turn (at most one per card; a newer
   * click replaces the older intent). Browser view state only, never ledger
   * state: the Host confirms the move before the card changes column.
   */
  pendingTransitions?: readonly QueuedTransition[]
  /** The last transition failure per card, cleared by the card's next action. */
  transitionErrors?: Readonly<Record<string, TransitionError>>
  /**
   * Keys of the modal form drafts the controller currently holds (see
   * {@link BoardController.saveFormDraft}). The board marks "new task" while
   * the blank form's draft waits, so a kept draft is visible before the popup
   * is opened again. Absent when nothing waits.
   */
  formDrafts?: readonly string[]
  /** Whether the board may offer "register a new project" (issue #1536). */
  canCreateWorkspace?: boolean
  /**
   * Whether this deployment can parse pasted text into task fields (issue #1540).
   */
  canParseTask?: boolean
  /** Whether this deployment serves the review reads (worktree, logs, diff). */
  canReviewRead?: boolean
  transportError?: string
  /**
   * A session jump that failed because the runtime does not know the id even
   * after a roster refresh (the session was deleted, or it is unaddressable).
   * Cleared by the next successful jump or by {@link BoardController.dismissSessionOpenError}.
   */
  sessionOpenError?: string
  host?: Pick<TaskBoardSnapshot, 'revision' | 'scheduler' | 'power' | 'sessionDefaultPermission' | 'stateMachine' | 'maxConcurrentRuns' | 'maxDoneTasks' | 'awaitingAnswer' | 'reviewPlans' | 'pendingReleases'>
}

/** The selected task (resolved from the ledger), or undefined. */
export function selectedTaskOf(snapshot: ControllerSnapshot): TaskRecord | undefined {
  if (snapshot.selectedTaskId === undefined) return undefined
  return snapshot.tasks.find(task => task.id === snapshot.selectedTaskId)
}

function randomUuid(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID !== undefined) {
    return randomUUID.call(globalThis.crypto!)
  }
  const bytes = globalThis.crypto?.getRandomValues(new Uint8Array(16))
  if (bytes === undefined) {
    // Non-secure fallback (tests, odd environments).
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** First retry delay of a failed outbox send; doubles up to the cap. */
const OUTBOX_RETRY_BASE_MS = 1_000
/** Longest delay between two outbox retries. */
const OUTBOX_RETRY_MAX_MS = 30_000
/** How many notices the board keeps for its toast area. */
const NOTICE_LIMIT = 12

/**
 * One action the UI accepted from the user and still owes the Host. It carries
 * its own idempotency key (`requestId`), so a resend after a connection loss can
 * never apply the action twice; the ledger's persisted request cache answers
 * the retry with the already-applied state.
 */
interface OutboxEntry {
  requestId: string
  action: TaskBoardAction
  taskId?: string
  initiator?: string
  attempts: number
  state: 'queued' | 'sending' | 'waiting'
  error?: string
  createdAt: number
  /** Identity for duplicate suppression (double click, repeated drop). */
  fingerprint: string
  onAccepted?: () => void
  onRejected?: (message: string) => void
}

/** Transport failures worth retrying: the action did not reach a decision. */
function isRetryable(failure: string): boolean {
  return failure === 'unreachable' || failure === 'locked' || failure === 'timeout'
}

/**
 * Board controller (see module doc). All mutations bump the snapshot and
 * persist through the store; UI and DOM mounts subscribe and re-render.
 */
export class BoardController {
  private tasks: TaskRecord[] = []
  private boardOpen = false
  private archiveView = false
  private selectedTaskId: string | undefined
  private executionOptions: ExecutionOptionsSnapshot = { workspaces: [], presets: [], models: [] }
  private workspaceCreator: WorkspaceCreator | undefined
  private listeners = new Set<() => void>()
  private disposers: Array<() => void> = []
  private readonly now: () => number
  private readonly uuid: () => string
  /**
   * The outbox: user actions accepted immediately and handed to the Host in the
   * background. This is what makes every UI action possible while the backend is
   * busy — the board never waits on a request, never disables a control because
   * of one, and never turns a slow Host into a "timeout" for the user.
   */
  private readonly outbox: OutboxEntry[] = []
  /** One FIFO drain per card (and one global drain for multi-card actions). */
  private readonly outboxDrains = new Map<string, Promise<void>>()
  private readonly outboxDraining = new Set<string>()
  /** A kick arrived while the same card's loop was still finishing. */
  private readonly outboxKickPending = new Set<string>()
  /** Per-entry retry timers (keyed by requestId). */
  private readonly outboxTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private outboxError: string | undefined
  private readonly noticeList: BoardNotice[] = []
  private readonly seenHostNotices = new Set<string>()
  /**
   * Transition intents (a status move that starts a run/clarify included).
   * One per card: a newer click replaces the older intent. They wait outside
   * the outbox until no action for the card is in flight, then enter it; the
   * outbox owns retries and request-id idempotency.
   */
  private readonly transitionQueue = new Map<string, QueuedTransition>()
  /** Last transition failure per card; cleared by the card's next action. */
  private readonly transitionErrors = new Map<string, TransitionError>()
  private transitionPumpQueued = false
  private pumpingTransitions = false
  /**
   * Modal form drafts, keyed per modal (the client owns the key vocabulary).
   * They live here — not in the popup components — so closing a popup by an
   * accidental click next to it, by Escape, or by Cancel never throws typed
   * input away: the modal's next mount reads its draft back. In memory only,
   * so a page reload is a clean start.
   */
  private readonly formDrafts = new Map<string, unknown>()
  private transportError: string | undefined
  private sessionOpenError: string | undefined
  private hostState: Pick<TaskBoardSnapshot, 'revision' | 'scheduler' | 'power' | 'sessionDefaultPermission' | 'stateMachine' | 'maxConcurrentRuns' | 'maxDoneTasks' | 'awaitingAnswer' | 'reviewPlans' | 'pendingReleases'> | undefined
  private remoteSubscribed = false
  private remoteInitialization: Promise<boolean> | undefined

  /** @param deps - store and the sessions navigation face. */
  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.uuid = deps.uuid ?? randomUuid
  }

  // --- lifecycle -------------------------------------------------------------

  /** Load the persisted ledger and start the navigation/status subscriptions. */
  start(): void {
    this.tasks = this.deps.store.load()
    if (this.deps.transport !== undefined) void this.initializeRemote()
    // A sibling tab may have edited or deleted the ledger (same origin,
    // storage events). Reload on external change so a task deleted in
    // another tab stops firing here — and is never written back by this
    // tab's stale copy (scheduler roll-forward, execution settlement).
    const unsubscribeExternal = this.deps.transport === undefined ? this.deps.store.subscribeExternal?.(() => {
      this.tasks = this.deps.store.load()
      this.notify()
    }) : undefined
    if (unsubscribeExternal !== undefined) this.disposers.push(unsubscribeExternal)
    this.disposers.push(this.deps.sessions.list.subscribe(() => {
      this.onSessionsChanged()
    }))
    this.notify()
  }

  /** Stop all subscriptions and drop retained state (idempotent). */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.outboxTimers.values()) clearTimeout(timer)
    this.outboxTimers.clear()
    this.outboxDrains.clear()
    this.outboxDraining.clear()
    this.outboxKickPending.clear()
    this.outbox.length = 0
    this.transitionPumpQueued = false
    this.transitionQueue.clear()
    this.transitionErrors.clear()
    this.listeners.clear()
  }

  // --- snapshot / subscription ------------------------------------------------

  getSnapshot(): ControllerSnapshot {
    const pendingTaskIds = [...new Set(this.outbox.flatMap(entry => entry.taskId === undefined ? [] : [entry.taskId]))]
    return {
      tasks: this.tasks,
      boardOpen: this.boardOpen,
      archiveView: this.archiveView,
      selectedTaskId: this.selectedTaskId,
      executionOptions: this.executionOptions,
      pendingTaskIds,
      outbox: {
        pending: this.outbox.length,
        ...(this.outboxError === undefined ? {} : { error: this.outboxError }),
      },
      notices: [...this.noticeList],
      ...(this.transitionQueue.size === 0 ? {} : { pendingTransitions: [...this.transitionQueue.values()] }),
      ...(this.transitionErrors.size === 0 ? {} : { transitionErrors: Object.fromEntries(this.transitionErrors) }),
      ...(this.formDrafts.size === 0 ? {} : { formDrafts: this.formDraftKeys() }),
      ...(this.workspaceCreator === undefined ? {} : { canCreateWorkspace: true }),
      ...(typeof this.deps.transport?.parseDraft === 'function' ? { canParseTask: true } : {}),
      ...(typeof this.deps.transport?.reviewOp === 'function' ? { canReviewRead: true } : {}),
      ...(this.transportError === undefined ? {} : { transportError: this.transportError }),
      ...(this.sessionOpenError === undefined ? {} : { sessionOpenError: this.sessionOpenError }),
      ...(this.hostState === undefined ? {} : { host: this.hostState }),
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Whether production mutations are confirmed by the Host transport. */
  isHostBacked(): boolean {
    return this.deps.transport !== undefined
  }

  /**
   * Wait until every queued outbox chain has finished its current send. Waiting
   * entries (a broken connection) are not awaited: they retry on their own.
   * Tests and the host-sync retry use this instead of polling.
   */
  async whenIdle(): Promise<void> {
    // Let a ready transition intent enter the outbox before waiting on it.
    await Promise.resolve()
    while (this.outboxDrains.size > 0) {
      await Promise.all([...this.outboxDrains.values()].map(drain => drain.catch(() => {})))
    }
  }

  /** Retry initial migration/state synchronization after an explicit Host error. */
  async retryHostSync(): Promise<boolean> {
    return await this.initializeRemote()
  }

  // --- view state -------------------------------------------------------------

  openBoard(): void {
    if (this.boardOpen) return
    this.boardOpen = true
    this.notify()
  }

  closeBoard(): void {
    this.boardOpen = false
    this.notify()
  }

  toggleBoard(): void {
    if (this.boardOpen) this.closeBoard()
    else this.openBoard()
  }

  /**
   * Switch between the kanban columns and the archive view. Leaving the
   * archive view with an archived task still selected closes the selection —
   * the detail overlay must not linger over a task that is off-board.
   */
  toggleArchiveView(): void {
    this.archiveView = !this.archiveView
    if (!this.archiveView && this.selectedTaskId !== undefined) {
      const selected = this.tasks.find(task => task.id === this.selectedTaskId)
      if (selected?.archivedAt !== undefined) this.selectedTaskId = undefined
    }
    this.notify()
  }

  openTask(id: string): void {
    if (this.tasks.some(task => task.id === id)) {
      this.selectedTaskId = id
      this.notify()
    }
  }

  closeTask(): void {
    if (this.selectedTaskId === undefined) return
    this.selectedTaskId = undefined
    this.notify()
  }

  // --- modal form drafts -------------------------------------------------------

  /**
   * The draft one modal left behind, or undefined when nothing waits under that
   * key. The caller owns the key vocabulary (one key per modal instance), so a
   * draft for one card never reappears while a different card is being edited.
   */
  getFormDraft<T>(key: string): T | undefined {
    return this.formDrafts.get(key) as T | undefined
  }

  /** Keys of the drafts currently held (the board's "new task" mark reads this). */
  formDraftKeys(): readonly string[] {
    return [...this.formDrafts.keys()]
  }

  /** Keep one modal's field values after its popup closed. */
  saveFormDraft(key: string, value: unknown): void {
    this.formDrafts.set(key, value)
    this.notify()
  }

  /** Drop one modal's draft: an explicit discard, or a form nobody touched. */
  discardFormDraft(key: string): void {
    if (!this.formDrafts.delete(key)) return
    this.notify()
  }

  // --- task mutations (use-case transitions in core/use-cases) -----------------

  createTask(input: NewTaskInput): TaskRecord | undefined {
    const id = this.uuid()
    const { task, tasks } = applyCreateTask(this.tasks, input, this.now(), id)
    if (task === undefined) return undefined
    this.tasks = [...tasks]
    this.persistAndNotify()
    return task
  }

  /** Create through the Host and expose the task only after confirmation. */
  async createTaskConfirmed(input: NewTaskInput): Promise<TaskRecord | undefined> {
    if (this.deps.transport === undefined) return this.createTask(input)
    const id = this.uuid()
    const preview = applyCreateTask(this.tasks, input, this.now(), id).task
    if (preview === undefined) return undefined
    return await this.enqueueConfirmed({ kind: 'create', id, input }, id)
      ? this.tasks.find(task => task.id === id)
      : undefined
  }

  /**
   * Accept a new task immediately and hand it to the Host in the background.
   * The card appears when the Host confirms it; a rejection restores the caller's
   * draft through `onRejected`. The dialog can close at once — the user is never
   * blocked by the round trip.
   * @returns the id the card will have.
   */
  queueCreateTask(input: NewTaskInput, hooks: { onAccepted?: () => void; onRejected?: (message: string) => void } = {}): string {
    const id = this.uuid()
    if (this.deps.transport === undefined) {
      const task = this.createTask(input)
      if (task === undefined) hooks.onRejected?.('the task could not be created')
      else hooks.onAccepted?.()
      return id
    }
    this.enqueue({ kind: 'create', id, input }, id, hooks)
    return id
  }

  /**
   * Apply an editable-field patch (task content + execution targets).
   * Host-backed: the Host ledger owns the fail-closed checks (the content of
   * an executed task is read-only) and confirms the mutation, so the resolved
   * value reflects whether the Host accepted it; the legacy in-memory path
   * applies and persists synchronously.
   * @returns true when the patch was accepted by the authority.
   */
  async updateTask(id: string, patch: TaskUpdatePatch): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.enqueueConfirmed({ kind: 'update', taskId: id, patch }, id)
    }
    this.tasks = [...applyUpdateTask(this.tasks, id, patch, this.now())]
    this.persistAndNotify()
    return true
  }

  /**
   * Accept an edit immediately and hand it to the Host in the background. The
   * modal closes at once; a rejection restores the draft through `onRejected`.
   */
  queueUpdateTask(id: string, patch: TaskUpdatePatch, hooks: { onAccepted?: () => void; onRejected?: (message: string) => void } = {}): void {
    if (this.deps.transport === undefined) {
      this.tasks = [...applyUpdateTask(this.tasks, id, patch, this.now())]
      this.persistAndNotify()
      hooks.onAccepted?.()
      return
    }
    this.enqueue({ kind: 'update', taskId: id, patch }, id, hooks)
  }

  /**
   * Replace (a part of) the picker option sets the UI feeds (workspace list
   * and agent-preset roster come from the runtime, not the ledger).
   */
  setExecutionOptions(patch: Partial<ExecutionOptionsSnapshot>): void {
    this.executionOptions = { ...this.executionOptions, ...patch }
    this.notify()
  }

  /** Wire (or clear) the runtime's project registration face (issue #1536). */
  setWorkspaceCreator(creator: WorkspaceCreator | undefined): void {
    this.workspaceCreator = creator
    this.notify()
  }

  /**
   * Register an existing host directory as a DSH project, exactly as the GUI's
   * own "add project" does; the runtime's failure message surfaces unchanged.
   */
  async createWorkspace(path: string): Promise<{ workspaceId: string }> {
    if (this.workspaceCreator === undefined) throw new Error('workspace creation is unavailable')
    return await this.workspaceCreator(path)
  }

  /** Whether this deployment can parse pasted text into task fields (issue #1540). */
  canParseTask(): boolean {
    return typeof this.deps.transport?.parseDraft === 'function'
  }

  /**
   * Parse pasted text into task fields through the Host. The transport already
   * phrases every failure for the user, so its message surfaces unchanged.
   */
  async parseTaskDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft> {
    const transport = this.deps.transport
    const parse = transport?.parseDraft
    if (transport === undefined || parse === undefined) throw new Error('task parsing is unavailable')
    return await parse.call(transport, request, signal)
  }

  /**
   * Ask for a manual status move. Host-backed this only enqueues the intent:
   * the controller sends it (through the outbox) when no other action for the
   * card is in flight and the machine/preconditions allow it, then waits for
   * the confirmed snapshot. The legacy in-memory path still applies the move
   * synchronously.
   */
  moveTask(id: string, status: TaskStatus): void {
    if (this.deps.transport !== undefined) {
      this.enqueueTransition(id, status)
      return
    }
    this.tasks = this.tasks.map(task => task.id === id ? withStatus(task, status, this.now()) : task)
    this.persistAndNotify()
  }

  /**
   * Move a group of cards to one status. Host-backed each card gets its own
   * queued intent (the "last click wins" rule is per card), so one card's
   * blocker never holds back the others; the legacy path keeps the single
   * in-memory write.
   * @param ids - the dragged cards; duplicates are ignored.
   * @param status - the target column.
   * @returns whether the intents were accepted into the queue (always true on
   * the legacy path); the board clears its selection on success only.
   */
  async moveTasks(ids: readonly string[], status: TaskStatus): Promise<boolean> {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return true
    if (this.deps.transport !== undefined) {
      for (const id of unique) this.enqueueTransition(id, status)
      return true
    }
    if (unique.length === 1) {
      this.moveTask(unique[0]!, status)
      return true
    }
    const moving = new Set(unique)
    this.tasks = this.tasks.map(task => moving.has(task.id) ? withStatus(task, status, this.now()) : task)
    this.persistAndNotify()
    return true
  }

  /**
   * Drop the card's waiting transition intent. A move already handed to the
   * outbox is not retracted (the intent leaves the queue before that), so the
   * cancel control only exists while the card is actually waiting.
   */
  cancelTransition(taskId: string): void {
    if (!this.transitionQueue.delete(taskId)) return
    this.notify()
  }

  /**
   * Record why a drop/click could not even be queued (hard blocker). The card
   * shows a badge and the detail the reason until its next action.
   */
  noteTransitionBlocked(taskId: string, blocker: TransitionBlocker, to?: TaskStatus): void {
    const task = this.tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) return
    this.transitionErrors.set(taskId, {
      code: blocker,
      from: task.status,
      ...(to === undefined ? {} : { to }),
      at: this.now(),
    })
    this.notify()
  }

  deleteTask(id: string): void {
    if (this.deps.transport !== undefined) {
      this.enqueue({ kind: 'delete', taskId: id }, id)
      return
    }
    const { tasks, selectionCleared } = applyDeleteTask(this.tasks, this.selectedTaskId, id)
    this.tasks = [...tasks]
    if (selectionCleared) this.selectedTaskId = undefined
    this.persistAndNotify()
  }

  /**
   * Archive a task from any status but `running`, whose lifecycle the runner
   * keeps exclusive ownership of until it settles.
   * @returns true when applied.
   */
  archiveTask(id: string): boolean {
    const { tasks, archived } = applyArchiveTask(this.tasks, id, this.now())
    if (!archived) {
      this.refuse('this card cannot be archived (it is running or already archived)', id)
      return false
    }
    if (this.deps.transport !== undefined) {
      this.enqueue({ kind: 'archive', taskId: id }, id)
      return true
    }
    this.tasks = [...tasks]
    this.persistAndNotify()
    return true
  }

  /** Restore an archived task back onto the board (same status column). */
  restoreTask(id: string): boolean {
    const { tasks, archived } = applyRestoreTask(this.tasks, id, this.now())
    if (!archived) return false
    if (this.deps.transport !== undefined) {
      this.enqueue({ kind: 'restore', taskId: id }, id, {
        onAccepted: () => { if (this.selectedTaskId === id) this.closeTask() },
      })
      return true
    }
    this.tasks = [...tasks]
    if (this.selectedTaskId === id) this.selectedTaskId = undefined
    this.persistAndNotify()
    return true
  }

  // --- scheduling ---------------------------------------------------------------

  /**
   * Update a task's schedule rule. A blank or invalid cron expression is
   * rejected (returns false, state untouched). When the rule ends up enabled
   * the next run instant is computed immediately; a disabled rule carries no
   * next-run instant. Delegates the domain transition to the schedule use case.
   * @param id - the task to schedule.
   * @param patch - fields to change (absent fields keep their current value).
   * @returns true when applied, false when rejected (invalid cron / unknown task).
   */
  setSchedule(id: string, patch: { enabled?: boolean; cron?: string }): boolean {
    const { tasks, applied } = applySetSchedule(this.tasks, id, patch, this.now())
    if (!applied) return false
    if (this.deps.transport !== undefined) {
      this.enqueue({ kind: 'set-schedule', taskId: id, patch }, id)
      return true
    }
    this.tasks = [...tasks]
    this.persistAndNotify()
    return true
  }

  /**
   * Legacy pure-controller seam retained for migration-focused tests. The
   * production browser never rolls schedules; the Host ledger owns them.
   */
  applyScheduleNextRun(id: string, nextRunAt: number | undefined, lastTriggeredAt: number | undefined): void {
    const next = applyScheduleRollForward(this.tasks, id, nextRunAt, lastTriggeredAt, this.now())
    this.tasks = [...next]
    this.persistAndNotify()
  }

  /**
   * Reload the legacy v1 store without notifying subscribers. Production v2
   * reads Host snapshots instead; this remains only for isolated legacy tests.
   */
  reloadFromStore(): void {
    this.tasks = this.deps.store.load()
  }

  /**
   * Jump to an execution's session transcript — a live (running) session and
   * an inactive (settled) one alike. Selecting the session changes `current`,
   * which closes the board (the conversation view takes over).
   *
   * The runtime's `open` refuses any id the local session roster has not
   * pulled (`sessions.select: unknown session …`) — the normal state of an
   * older execution in a fresh tab or right after a host restart. The jump
   * therefore refreshes the host-authoritative roster once and retries before
   * it reports a failure, so an inactive session's link is never a dead
   * control just because the list was stale.
   * @param sessionId - the execution session to open.
   * @returns true when the session was selected synchronously.
   */
  openSession(sessionId: string): boolean {
    if (this.selectSession(sessionId)) return true
    void this.refreshAndSelectSession(sessionId)
    return false
  }

  /** Clear a failed session-jump notice. */
  dismissSessionOpenError(): void {
    if (this.sessionOpenError === undefined) return
    this.sessionOpenError = undefined
    this.notify()
  }

  /** Select and close the board; false when the runtime refuses the id. */
  private selectSession(sessionId: string): boolean {
    try {
      this.deps.sessions.open(sessionId)
    } catch {
      return false
    }
    this.sessionOpenError = undefined
    this.closeBoard()
    return true
  }

  /** Second chance for an unlisted session: refresh the roster, then retry. */
  private async refreshAndSelectSession(sessionId: string): Promise<void> {
    const refresh = this.deps.sessions.refresh
    if (refresh !== undefined) {
      // A failed refresh is not fatal on its own: the roster may already hold
      // the id, so the retry below stays the decider.
      try { await refresh() } catch { /* fall through to the retry */ }
    }
    if (this.selectSession(sessionId)) return
    this.sessionOpenError = `the runtime does not know ${sessionId} (id not in the session list after a refresh)`
    this.notify()
  }

  // --- execution ---------------------------------------------------------------

  /**
   * Request a Host execution for a task: the Host ledger owns the running
   * transition, the execution record, and the settlement. The action is
   * accepted immediately (queued per card); a status that forbids it is
   * reported as a notice instead of silently doing nothing.
   */
  async runTask(id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status === 'running') {
      this.refuse(this.taskRefusal(id, 'run'), id)
      return false
    }
    if (this.deps.transport === undefined) return false
    this.enqueue({ kind: 'run', taskId: id }, id, {}, currentOf(this.deps.sessions))
    return true
  }

  /**
   * Confirm a card's above-default permission binding through the Host
   * (resolves the pending-confirmation transaction; no-op otherwise).
   */
  async confirmPermission(id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined) return false
    if (this.deps.transport === undefined) {
      this.tasks = this.tasks.map(candidate => candidate.id === id
        ? { ...candidate, permissionConfirmedAt: this.now(), updatedAt: this.now() }
        : candidate)
      this.persistAndNotify()
      return true
    }
    this.enqueue({ kind: 'confirm-permission', taskId: id }, id)
    return true
  }

  /** Re-run a settled task through the Host (the Host replans and executes). */
  async rerunTask(id: string): Promise<void> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status === 'running') {
      this.refuse(this.taskRefusal(id, 'run'), id)
      return
    }
    if (this.deps.transport === undefined) return
    this.enqueue({ kind: 'rerun', taskId: id }, id, {}, currentOf(this.deps.sessions))
  }

  // --- review environments -------------------------------------------------------

  /**
   * Start the card's version for the manual review. Only a card standing in the
   * review column may ask: the Host refuses anything else, and the board hides
   * the controls everywhere else anyway.
   * @returns whether the action was accepted locally.
   */
  async reviewStart(id: string): Promise<boolean> {
    return await this.reviewAction('review-start', id)
  }

  /** Stop the card's review version again (compose project or configured command). */
  async reviewStop(id: string): Promise<boolean> {
    return await this.reviewAction('review-stop', id)
  }

  /**
   * Restart the card's review version: the Host stops a running environment
   * first and starts it again, so a rebuilt image or a changed config takes
   * effect without two clicks.
   */
  async reviewRestart(id: string): Promise<boolean> {
    return await this.reviewAction('review-restart', id)
  }

  private async reviewAction(kind: 'review-start' | 'review-stop' | 'review-restart', id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status !== 'ready_for_test') {
      this.refuse('the review environment can only be controlled from the review column', id)
      return false
    }
    if (this.deps.transport === undefined) return false
    this.enqueue({ kind, taskId: id }, id)
    return true
  }

  /**
   * Release the card for the merge (the board's "Freigeben (Merge)"): the Host
   * merges the card's feature branch into its base branch and the card moves on
   * to `done`. A conflict is not the human's problem — the Host starts that merge
   * in the card's own worktree and lets the card's agent resolve it — while every
   * other failure lands in `failed` with the reason (and a notice).
   *
   * Only a card standing in the review column may ask; the Host is the authority
   * for that and refuses anything else.
   * @returns whether the action was accepted locally.
   */
  async approveMerge(id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status !== 'ready_for_test') {
      this.refuse('the merge can only be released from the review column', id)
      return false
    }
    if (this.deps.transport === undefined) return false
    // The release may open the conflict-resolution run, so the asking session
    // travels with it the way it does for `run`.
    this.enqueue({ kind: 'approve-merge', taskId: id }, id, {}, currentOf(this.deps.sessions))
    return true
  }

  /**
   * Open the card's version in the configured editor (or the `*.code-workspace`
   * it carries). The Host launches the editor on its own machine, so this is a
   * read-only Host call rather than an action: nothing about the ledger changes.
   */
  async openWorktree(id: string): Promise<TaskBoardReviewResponse> {
    return await this.reviewRead({ kind: 'open', taskId: id })
  }

  /** Snapshot of the card's container/application logs, for the detail modal. */
  async loadReviewLogs(id: string): Promise<TaskBoardReviewResponse> {
    return await this.reviewRead({ kind: 'logs', taskId: id })
  }

  /** `git diff --stat` of the reviewed commit against the card's base branch. */
  async loadReviewDiff(id: string): Promise<TaskBoardReviewResponse> {
    return await this.reviewRead({ kind: 'diff', taskId: id })
  }

  /**
   * One review read against the Host. A deployment without that route answers
   * with its reason instead of throwing, so the panel can show what happened.
   */
  private async reviewRead(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse> {
    const reviewOp = this.deps.transport?.reviewOp
    if (reviewOp === undefined) return { ok: false, error: 'this Host serves no review operations' }
    try {
      return await reviewOp.call(this.deps.transport, request)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * Pause the in-progress runs of `ids` in one Host action: each card keeps its
   * column and its execution record, the Host stops the run's session. The
   * board's bulk button sends every in-progress card at once, so one click
   * suspends the whole column in a single ledger write.
   * @returns whether the action was accepted locally.
   */
  async pauseTasks(ids: readonly string[]): Promise<boolean> {
    const unique = [...new Set(ids)]
    if (unique.length === 0 || this.deps.transport === undefined) return false
    this.enqueue({ kind: 'pause', taskIds: unique })
    return true
  }

  /**
   * Resume paused runs: the Host clears the pause and writes the "continue"
   * turn into each run's own conversation (a run that never got a session goes
   * back into the launch queue).
   * @returns whether the action was accepted locally.
   */
  async resumeTasks(ids: readonly string[]): Promise<boolean> {
    const unique = [...new Set(ids)]
    if (unique.length === 0 || this.deps.transport === undefined) return false
    this.enqueue({ kind: 'resume', taskIds: unique })
    return true
  }

  // --- internals ---------------------------------------------------------------

  /**
   * Session-list notifications fire for all kinds of incidental churn
   * (background navigation, the Host runner creating and selecting a fresh
   * execution session, settlement, other plugins), so closing on `current`
   * changes would evict the board without the user asking. The board closes
   * only on explicit user navigation: a sidebar session/workspace row click
   * (board-mount onClickSidebarRow) or the board's own actions
   * (openSession / close). Keeping the hook preserves the subscription
   * contract for future listeners.
   */
  private onSessionsChanged(): void {
    // Intentionally empty: never close the board implicitly.
  }

  private persistAndNotify(): void {
    if (this.deps.transport === undefined) this.deps.store.save(this.tasks)
    this.notify()
  }

  // --- transition intent queue -------------------------------------------------

  /** The machine the Host currently enforces (the shipped one as fallback). */
  private transitionMachine(): ReturnType<typeof resolveStateMachine>['machine'] {
    return resolveStateMachine(this.hostState?.stateMachine).machine
  }

  /**
   * Queue one manual move for the card. Hard blockers are refused at once (the
   * button is disabled for them anyway) and recorded so the popup/card can say
   * why; a valid intent replaces any older waiting intent for the same card.
   */
  private enqueueTransition(taskId: string, to: TaskStatus): boolean {
    const task = this.tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) return false
    if (task.status === to) {
      // The desired column is already reached: the intent is complete.
      this.transitionQueue.delete(taskId)
      this.transitionErrors.delete(taskId)
      this.notify()
      return true
    }
    // A move already on the wire will change the source column; the follow-up
    // transition is validated by the Host against the state the first action
    // leaves behind. Otherwise the current column decides right away.
    const pendingMove = this.outbox.some(candidate =>
      candidate.taskId === taskId && candidate.action.kind === 'move')
    if (!pendingMove) {
      const blocker = transitionBlockerOf(task, this.transitionMachine(), to, this.hostState?.sessionDefaultPermission)
      if (blocker !== undefined) {
        this.noteTransitionBlocked(taskId, blocker, to)
        return false
      }
    }
    this.transitionQueue.set(taskId, { taskId, from: task.status, to, requestedAt: this.now() })
    this.transitionErrors.delete(taskId)
    this.notify()
    this.pumpTransitionQueue()
    return true
  }

  private failTransition(
    taskId: string,
    code: TransitionError['code'],
    message?: string,
    from?: TaskStatus,
    to?: TaskStatus,
  ): void {
    this.transitionErrors.set(taskId, {
      code,
      ...(message === undefined || message === '' ? {} : { message }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      at: this.now(),
    })
    this.notify()
  }

  /** Schedule a pump after the current microtask queue (deduped). */
  private scheduleTransitionPump(): void {
    if (this.transitionPumpQueued) return
    this.transitionPumpQueued = true
    queueMicrotask(() => {
      this.transitionPumpQueued = false
      this.pumpTransitionQueue()
    })
  }

  /**
   * Send every intent whose card is free. A card with an outbox action is
   * skipped (the outbox hooks pump again when that action settles); a card
   * whose source column changed, or that hit a hard blocker in the meantime,
   * loses its intent with a recorded reason.
   */
  private pumpTransitionQueue(): void {
    if (this.pumpingTransitions) return
    if (this.deps.transport === undefined) {
      this.transitionQueue.clear()
      return
    }
    if (this.transitionQueue.size === 0) return
    this.pumpingTransitions = true
    let changed = false
    try {
      for (const [taskId, entry] of [...this.transitionQueue]) {
        const task = this.tasks.find(candidate => candidate.id === taskId)
        // A deleted/archived card has nothing left to move.
        if (task === undefined || task.archivedAt !== undefined) {
          this.transitionQueue.delete(taskId)
          changed = true
          continue
        }
        // The outbox owns the card until its action is confirmed or rejected.
        const pendingForCard = this.outbox.filter(candidate => candidate.taskId === taskId)
        if (pendingForCard.length > 0) {
          // A transition behind another transition keeps the outbox's per-card
          // FIFO (a second click while the first move is on the wire). Behind a
          // non-transition action the intent still waits for that action to
          // settle, so its source-column precheck remains meaningful.
          const pendingMove = pendingForCard.some(candidate => candidate.action.kind === 'move')
          if (!pendingMove) continue
          if (pendingForCard.some(candidate => candidate.action.kind === 'move'
            && candidate.action.taskId === taskId && candidate.action.status === entry.to)) {
            this.transitionQueue.delete(taskId)
            changed = true
            continue
          }
          this.transitionQueue.delete(taskId)
          this.sendQueuedTransition(entry)
          continue
        }
        if (task.status === entry.to) {
          this.transitionQueue.delete(taskId)
          this.transitionErrors.delete(taskId)
          changed = true
          continue
        }
        if (task.status !== entry.from) {
          this.transitionQueue.delete(taskId)
          this.failTransition(taskId, 'source-changed', undefined, entry.from, entry.to)
          continue
        }
        const blocker = transitionBlockerOf(
          task,
          this.transitionMachine(),
          entry.to,
          this.hostState?.sessionDefaultPermission,
        )
        if (blocker !== undefined) {
          this.transitionQueue.delete(taskId)
          this.failTransition(taskId, blocker, undefined, entry.from, entry.to)
          continue
        }
        this.transitionQueue.delete(taskId)
        this.sendQueuedTransition(entry)
      }
    } finally {
      this.pumpingTransitions = false
      // A silently completed/dropped intent still has to disappear from the
      // card badge; the snapshot that triggered the pump may predate this pass.
      if (changed) this.notify()
    }
  }

  /**
   * Hand one intent to the outbox. The outbox serialises per card, retries a
   * broken connection with the same request id and reports a definitive
   * rejection through the hook, so the intent queue never duplicates that work.
   */
  private sendQueuedTransition(entry: QueuedTransition): void {
    this.enqueue(
      { kind: 'move', taskId: entry.taskId, status: entry.to },
      entry.taskId,
      {
        onAccepted: () => {
          this.transitionErrors.delete(entry.taskId)
          this.scheduleTransitionPump()
        },
        onRejected: (message) => {
          this.failTransition(entry.taskId, 'rejected', message, entry.from, entry.to)
          this.scheduleTransitionPump()
        },
      },
      currentOf(this.deps.sessions),
      false,
    )
  }

  // --- outbox ------------------------------------------------------------------

  /**
   * Accept one action and hand it to the Host in the background. The UI is
   * acknowledged immediately; the card's FIFO chain keeps actions in order and
   * the same requestId is reused on retries, so a connection loss can never
   * apply an action twice.
   *
   * A queued action never blocks the user: it does not disable any control, and
   * a slow or unreachable Host only makes the banner count it. A repeated
   * identical action is dropped (a double click expresses one intent).
   */
  private enqueue(
    action: TaskBoardAction,
    taskId?: string,
    hooks: { onAccepted?: () => void; onRejected?: (message: string) => void } = {},
    initiator?: string,
    dedupe = true,
  ): void {
    if (this.deps.transport === undefined) return
    const fingerprint = `${taskId ?? '*'}:${JSON.stringify(action)}`
    if (dedupe && this.outbox.some(entry => entry.fingerprint === fingerprint)) return
    const entry: OutboxEntry = {
      requestId: this.uuid(),
      action,
      ...(taskId === undefined ? {} : { taskId }),
      ...(initiator === undefined || initiator === '' ? {} : { initiator }),
      attempts: 0,
      state: 'queued',
      createdAt: this.now(),
      fingerprint,
      ...(hooks.onAccepted === undefined ? {} : { onAccepted: hooks.onAccepted }),
      ...(hooks.onRejected === undefined ? {} : { onRejected: hooks.onRejected }),
    }
    this.outbox.push(entry)
    this.notify()
    this.kick(entry.taskId ?? '*')
  }

  /** Await the Host's verdict for one action (compatibility seams and tests). */
  private enqueueConfirmed(action: TaskBoardAction, taskId?: string, initiator?: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      this.enqueue(action, taskId, {
        onAccepted: () => resolve(true),
        onRejected: () => resolve(false),
      }, initiator, false)
    })
  }

  /**
   * Start draining one card's queue. The loop is intentionally **head-of-line
   * blocking**: an action that is waiting for a retry keeps the later actions of
   * the same card queued (otherwise a second move could overtake the first),
   * while every other card keeps its own loop. A waiting head ends the loop; its
   * retry timer starts it again.
   */
  private kick(key: string): void {
    if (this.outboxDraining.has(key)) {
      // The loop is between two sends; remember to look again once it ends,
      // otherwise an entry pushed in that window would sit forever.
      this.outboxKickPending.add(key)
      return
    }
    this.outboxDraining.add(key)
    const operation = this.drainKey(key).catch(() => {}).finally(() => {
      this.outboxDraining.delete(key)
      this.outboxDrains.delete(key)
      if (this.outboxKickPending.delete(key)) this.kick(key)
    })
    this.outboxDrains.set(key, operation)
  }

  private async drainKey(key: string): Promise<void> {
    for (;;) {
      // Head-of-line: the first entry of this card decides. A waiting head stops
      // the loop, so later actions of the same card can never overtake it.
      const entry = this.outbox.find(candidate => (candidate.taskId ?? '*') === key)
      if (entry === undefined || entry.state === 'waiting') return
      const outcome = await this.send(entry)
      if (outcome === 'waiting') return
    }
  }

  private async send(entry: OutboxEntry): Promise<'done' | 'waiting'> {
    if (!this.outbox.includes(entry)) return 'done'
    const transport = this.deps.transport
    if (transport === undefined) return 'done'
    entry.state = 'sending'
    this.notify()
    try {
      const snapshot = await transport.action(entry.action, entry.initiator, entry.requestId)
      const accepted = this.acceptRemote(snapshot)
      this.removeEntry(entry)
      this.outboxError = undefined
      this.transportError = undefined
      entry.onAccepted?.()
      this.notify()
      // A stale response (an older revision than the board already applies) is
      // not an error: read the authoritative state instead of applying it.
      if (!accepted) await this.refreshRemote()
      return 'done'
    } catch (error) {
      const failure = typeof (error as { failure?: unknown }).failure === 'string'
        ? (error as { failure: string }).failure
        : 'unexpected'
      const message = messageOf(error)
      if (isRetryable(failure)) {
        entry.state = 'waiting'
        entry.error = message
        entry.attempts += 1
        this.outboxError = message
        this.notify()
        this.scheduleRetry(entry)
        return 'waiting'
      }
      // A definitive refusal (status forbidden, validation, authentication):
      // tell the user, drop the entry and re-read the authority's state.
      this.removeEntry(entry)
      this.pushNotice('failed', `${this.actionLabel(entry)}: ${message}`, entry.taskId)
      // A broken transport is also the board's global error; a status refusal
      // is not (it belongs to the card's action, not to the connection).
      if (failure !== 'rejected' && failure !== 'unauthorized') this.transportError = message
      entry.onRejected?.(message)
      this.notify()
      return 'done'
    }
  }

  private scheduleRetry(entry: OutboxEntry): void {
    const delay = Math.min(OUTBOX_RETRY_BASE_MS * 2 ** Math.min(Math.max(entry.attempts - 1, 0), 6), OUTBOX_RETRY_MAX_MS)
    const timer = setTimeout(() => {
      this.outboxTimers.delete(entry.requestId)
      if (!this.outbox.includes(entry)) return
      entry.state = 'queued'
      this.kick(entry.taskId ?? '*')
    }, delay)
    this.outboxTimers.set(entry.requestId, timer)
  }

  private removeEntry(entry: OutboxEntry): void {
    const index = this.outbox.indexOf(entry)
    if (index !== -1) this.outbox.splice(index, 1)
    const timer = this.outboxTimers.get(entry.requestId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.outboxTimers.delete(entry.requestId)
    }
    this.notify()
  }

  /** Re-send every waiting action now (the banner's retry button). */
  retryOutbox(): void {
    this.outboxError = undefined
    for (const entry of [...this.outbox]) {
      const timer = this.outboxTimers.get(entry.requestId)
      if (timer !== undefined) {
        clearTimeout(timer)
        this.outboxTimers.delete(entry.requestId)
      }
      if (entry.state !== 'waiting') continue
      entry.state = 'queued'
      entry.attempts = 0
      this.kick(entry.taskId ?? '*')
    }
    this.notify()
  }

  /** Drop every waiting action (the banner's discard button). */
  discardOutbox(): void {
    // Only actions that are waiting for a retry can be discarded without
    // losing one that is already on the wire. The next action of the same card
    // (if any) starts again after its blocked head is gone.
    const keys = new Set<string>()
    for (const entry of [...this.outbox]) {
      if (entry.state !== 'waiting') continue
      keys.add(entry.taskId ?? '*')
      this.removeEntry(entry)
    }
    this.outboxError = undefined
    for (const key of keys) this.kick(key)
    this.notify()
  }

  /** Report a locally refused action (status-forbidden) as a notice. */
  refuse(message: string, taskId?: string): void {
    this.pushNotice('refused', message, taskId)
  }

  dismissNotice(id: string): void {
    const index = this.noticeList.findIndex(notice => notice.id === id)
    if (index === -1) return
    this.noticeList.splice(index, 1)
    this.notify()
  }

  private pushNotice(kind: BoardNotice['kind'], message: string, taskId?: string): void {
    this.noticeList.push({
      id: this.uuid(),
      kind,
      message,
      ...(taskId === undefined ? {} : { taskId }),
      at: this.now(),
    })
    while (this.noticeList.length > NOTICE_LIMIT) this.noticeList.shift()
    this.notify()
  }

  private taskRefusal(id: string, verb: 'run'): string {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined) return 'the card no longer exists'
    if (task.archivedAt !== undefined) return `the card is archived, so it cannot ${verb}`
    if (task.status === 'running') return 'the card is already running'
    return `the card cannot ${verb} in status "${task.status}"`
  }

  private actionLabel(entry: OutboxEntry): string {
    switch (entry.action.kind) {
      case 'create': return 'create task'
      case 'update': return 'save task'
      case 'move': return 'move task'
      case 'move-many': return 'move tasks'
      case 'delete': return 'delete task'
      case 'archive': return 'archive task'
      case 'restore': return 'restore task'
      case 'run': return 'start task'
      case 'rerun': return 'start task'
      case 'pause': return 'pause run'
      case 'resume': return 'resume run'
      case 'approve-merge': return 'release merge'
      case 'review-start': return 'start review environment'
      case 'review-stop': return 'stop review environment'
      case 'review-restart': return 'restart review environment'
      case 'set-schedule': return 'save schedule'
      case 'confirm-permission': return 'confirm permission'
      case 'import': return 'import tasks'
    }
  }

  /** Show Host-derived notices once (deduped by their Host-generated id). */
  private ingestHostNotices(notices: readonly TaskBoardNotice[] | undefined): void {
    if (notices === undefined) return
    for (const notice of notices) {
      if (this.seenHostNotices.has(notice.id)) continue
      if (this.seenHostNotices.size > 200) this.seenHostNotices.clear()
      this.seenHostNotices.add(notice.id)
      this.noticeList.push({
        id: notice.id,
        kind: 'host',
        message: notice.message,
        ...(notice.taskId === undefined ? {} : { taskId: notice.taskId }),
        at: notice.at,
      })
    }
    while (this.noticeList.length > NOTICE_LIMIT) this.noticeList.shift()
  }

  private async initializeRemote(): Promise<boolean> {
    if (this.remoteInitialization !== undefined) return await this.remoteInitialization
    const initialization = this.doInitializeRemote()
    this.remoteInitialization = initialization
    try {
      return await initialization
    } finally {
      if (this.remoteInitialization === initialization) this.remoteInitialization = undefined
    }
  }

  private async doInitializeRemote(): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    try {
      this.acceptRemote(await transport.bootstrap(this.tasks))
      if (!this.remoteSubscribed) {
        this.remoteSubscribed = true
        this.disposers.push(transport.subscribe((event) => { this.onRemoteEvent(event) }))
      }
      return true
    } catch (error) {
      this.transportError = messageOf(error)
      this.notify()
      return false
    }
  }

  /**
   * SSE frames carry revision/scheduler/power. When the revision matches the
   * one already applied, apply the frame's scheduler/power in place and skip
   * the full /state fetch; otherwise the 5 s heartbeat would re-clone and
   * re-serialize the whole ledger per tab even while nothing changes.
   */
  private onRemoteEvent(event: TaskBoardEventPayload | undefined): void {
    if (event !== undefined && this.hostState !== undefined && event.revision === this.hostState.revision
      && typeof event.scheduler === 'object' && event.scheduler !== null
      && typeof event.power === 'object' && event.power !== null) {
      // The event frame carries revision/scheduler/power plus the enforced
      // limits and the waiting questions; the machine (configuration, not state)
      // is kept from the last full snapshot. Limits and questions travel on the
      // frame because neither bumps the ledger revision.
      this.hostState = {
        ...this.hostState,
        revision: event.revision,
        scheduler: event.scheduler,
        power: event.power,
        ...(event.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: event.maxConcurrentRuns }),
        ...(event.maxDoneTasks === undefined ? {} : { maxDoneTasks: event.maxDoneTasks }),
        ...(event.awaitingAnswer === undefined ? {} : { awaitingAnswer: event.awaitingAnswer }),
        ...(event.reviewPlans === undefined ? {} : { reviewPlans: event.reviewPlans }),
        ...(event.pendingReleases === undefined ? {} : { pendingReleases: event.pendingReleases }),
      }
      this.ingestHostNotices(event.notices)
      this.notify()
      // A ready transition intent can enter the outbox now; the outbox itself
      // keeps the retry backoff for a temporarily unreachable Host.
      this.scheduleTransitionPump()
      return
    }
    void this.refreshRemote()
  }

  private async refreshRemote(preserveError?: string): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    try {
      this.acceptRemote(await transport.state())
      if (preserveError !== undefined) {
        this.transportError = preserveError
        this.notify()
      }
      return true
    } catch (error) {
      this.transportError = preserveError ?? messageOf(error)
      this.notify()
      return false
    }
  }

  private acceptRemote(snapshot: TaskBoardSnapshot): boolean {
    const currentLedgerId = this.hostState?.scheduler.ledgerId
    const nextLedgerId = snapshot.scheduler.ledgerId
    const sameGeneration = currentLedgerId === nextLedgerId
    if (sameGeneration && this.hostState !== undefined && snapshot.revision < this.hostState.revision) return false
    const previousStatuses = new Map(this.tasks.map(task => [task.id, task.status]))
    this.tasks = [...snapshot.tasks]
    this.hostState = {
      ...this.hostState,
      revision: snapshot.revision,
      scheduler: snapshot.scheduler,
      power: snapshot.power,
      // A Host that predates the state machine sends none: keep the machine
      // already in force (the shipped one) instead of clearing it.
      ...(snapshot.stateMachine === undefined ? {} : { stateMachine: snapshot.stateMachine }),
      // Same for the enforced limits: an older Host sends none, and the board
      // keeps explaining waiting cards with what it already has.
      ...(snapshot.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: snapshot.maxConcurrentRuns }),
      ...(snapshot.maxDoneTasks === undefined ? {} : { maxDoneTasks: snapshot.maxDoneTasks }),
      // Waiting questions: an older Host sends none, and the board keeps what it
      // has; the current Host always sends the map, so an empty one clears it.
      ...(snapshot.awaitingAnswer === undefined ? {} : { awaitingAnswer: snapshot.awaitingAnswer }),
      // The review plans are derived per read like the waiting questions: an
      // older Host sends none, and the board then simply offers no review block.
      ...(snapshot.reviewPlans === undefined ? {} : { reviewPlans: snapshot.reviewPlans }),
      ...(snapshot.pendingReleases === undefined ? {} : { pendingReleases: snapshot.pendingReleases }),
    }
    this.ingestHostNotices(snapshot.notices)
    this.transportError = undefined
    // The queue is browser view state: drop intents for cards the snapshot no
    // longer has or has archived, and let a status change clear the old error
    // badge (the pump records a fresh source-changed reason for a stale intent).
    const live = new Set(this.tasks.map(task => task.id))
    for (const id of [...this.transitionQueue.keys()]) {
      if (!live.has(id)) this.transitionQueue.delete(id)
    }
    for (const id of [...this.transitionErrors.keys()]) {
      if (!live.has(id)) this.transitionErrors.delete(id)
    }
    for (const task of this.tasks) {
      if (task.archivedAt !== undefined) {
        this.transitionQueue.delete(task.id)
        this.transitionErrors.delete(task.id)
        continue
      }
      const previous = previousStatuses.get(task.id)
      if (previous !== undefined && previous !== task.status) this.transitionErrors.delete(task.id)
    }
    if (this.selectedTaskId !== undefined && !this.tasks.some(task => task.id === this.selectedTaskId)) {
      this.selectedTaskId = undefined
    }
    if (!this.archiveView && this.selectedTaskId !== undefined
      && this.tasks.find(task => task.id === this.selectedTaskId)?.archivedAt !== undefined) {
      this.selectedTaskId = undefined
    }
    this.notify()
    this.scheduleTransitionPump()
    return true
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
