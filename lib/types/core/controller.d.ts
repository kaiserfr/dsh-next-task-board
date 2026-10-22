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
import type { TaskStore } from './store.ts';
import { type NewTaskInput, type TaskRecord, type TaskStatus } from './tasks.ts';
import { type QueuedTransition, type TransitionBlocker, type TransitionError } from './transitions.ts';
import { type TaskUpdatePatch } from './use-cases/task-update.ts';
import type { TaskBoardAction, TaskBoardEventPayload, TaskBoardParseDraft, TaskBoardParseRequest, TaskBoardReviewRequest, TaskBoardReviewResponse, TaskBoardSnapshot } from '../protocol.ts';
export interface TaskBoardTransport {
    bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>;
    state(): Promise<TaskBoardSnapshot>;
    /**
     * Submit one action; the optional initiator is the current DSH session id
     * (issue #6 audit origin), asserted by the client and recorded by the Host.
     * The optional requestId makes a retry idempotent: the outbox reuses the id
     * when it resends an action after a connection failure, and the ledger's
     * persisted request cache then returns the already-applied result instead of
     * applying it twice.
     */
    action(action: TaskBoardAction, initiator?: string, requestId?: string): Promise<TaskBoardSnapshot>;
    subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void;
    /**
     * One-shot model parse of pasted text (issue #1540). Optional: a deployment
     * that cannot parse simply omits it, and the form hides the section.
     */
    parseDraft?(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>;
    /**
     * One review read (open the worktree, snapshot the logs, diff the reviewed
     * commit). Optional like {@link TaskBoardTransport.parseDraft}: a Host that
     * predates the review block omits it, and the panel then only shows what it
     * can derive from the snapshot itself.
     */
    reviewOp?(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse>;
}
/** The sessions face the controller needs for navigation awareness. */
export interface SessionsControllerFace {
    list: {
        getSnapshot(): {
            current: string | undefined;
        };
        subscribe(fn: () => void): () => void;
    };
    /** Select a session as current (navigates the conversation view). */
    open(id: string): void;
    /**
     * Re-pull the host-authoritative session roster. Used to reach an inactive
     * session the local roster has not pulled yet; absent in the legacy/test
     * face, where a failed open is reported instead.
     */
    refresh?: () => Promise<void>;
}
/** Controller dependencies (all swappable in tests). */
export interface ControllerDeps {
    store: TaskStore;
    sessions: SessionsControllerFace;
    /** Clock; defaults to Date.now. */
    now?: () => number;
    /** Id minting; defaults to a random-uuid. */
    uuid?: () => string;
    /** Host-authoritative transport; absent keeps the legacy in-memory test path. */
    transport?: TaskBoardTransport;
}
/**
 * Register one host directory as a DSH project (workspace). Wired by the
 * browser apply() to the runtime's workspace controller; without it the board
 * hides its "new project" action instead of offering a dead control (#1536).
 */
export type WorkspaceCreator = (path: string) => Promise<{
    workspaceId: string;
}>;
/** One workspace option the execution-target pickers offer. */
export interface ExecutionWorkspaceOption {
    workspaceId: string;
    /** Display label (workspace title; the wiring falls back to the path). */
    title: string;
}
/** One agent-preset option the execution-target pickers offer. */
export interface ExecutionPresetOption {
    id: string;
    name?: string;
    description?: string;
    /** Why this preset cannot compose a session; the pickers disable it. */
    broken?: string;
    isDefault: boolean;
}
/** One model option the execution-target pickers offer. */
export interface ExecutionModelOption {
    id: string;
    name?: string;
    label?: string;
    provider?: string;
}
/** The execution-target option sets the UI feeds into the controller. */
export interface ExecutionOptionsSnapshot {
    workspaces: readonly ExecutionWorkspaceOption[];
    presets: readonly ExecutionPresetOption[];
    models?: readonly ExecutionModelOption[];
}
/**
 * One user-facing message the board renders as a toast: a status refusal
 * (a move the state machine does not allow, an archived/running card), a Host
 * rejection returned by the ledger, or a derived Host notice (a background git
 * failure). Messages are generated where the knowledge lives; the board only
 * displays and dismisses them.
 */
export interface BoardNotice {
    id: string;
    kind: 'refused' | 'failed' | 'host';
    message: string;
    taskId?: string;
    at: number;
}
/** The outbox's public face: how many actions wait, and why the last send failed. */
export interface OutboxSnapshot {
    /** Actions accepted by the UI but not yet confirmed by the Host. */
    pending: number;
    /** Last transport failure; the outbox keeps retrying and the banner explains it. */
    error?: string;
}
/** Immutable controller snapshot for UI subscriptions. */
export interface ControllerSnapshot {
    tasks: readonly TaskRecord[];
    boardOpen: boolean;
    /** True when the board shows the archive view instead of the columns. */
    archiveView: boolean;
    selectedTaskId: string | undefined;
    /** Picker option sets (workspace list + agent-preset roster). */
    executionOptions: ExecutionOptionsSnapshot;
    pendingTaskIds: readonly string[];
    /** Actions accepted locally and still waiting for the Host, plus the last transport error. */
    outbox?: OutboxSnapshot;
    /** Recent user-facing messages (refusals, Host rejections, background failures). */
    notices?: readonly BoardNotice[];
    /**
     * Transition intents waiting for their turn (at most one per card; a newer
     * click replaces the older intent). Browser view state only, never ledger
     * state: the Host confirms the move before the card changes column.
     */
    pendingTransitions?: readonly QueuedTransition[];
    /** The last transition failure per card, cleared by the card's next action. */
    transitionErrors?: Readonly<Record<string, TransitionError>>;
    /**
     * Keys of the modal form drafts the controller currently holds (see
     * {@link BoardController.saveFormDraft}). The board marks "new task" while
     * the blank form's draft waits, so a kept draft is visible before the popup
     * is opened again. Absent when nothing waits.
     */
    formDrafts?: readonly string[];
    /** Whether the board may offer "register a new project" (issue #1536). */
    canCreateWorkspace?: boolean;
    /**
     * Whether this deployment can parse pasted text into task fields (issue #1540).
     */
    canParseTask?: boolean;
    /** Whether this deployment serves the review reads (worktree, logs, diff). */
    canReviewRead?: boolean;
    transportError?: string;
    /**
     * A session jump that failed because the runtime does not know the id even
     * after a roster refresh (the session was deleted, or it is unaddressable).
     * Cleared by the next successful jump or by {@link BoardController.dismissSessionOpenError}.
     */
    sessionOpenError?: string;
    host?: Pick<TaskBoardSnapshot, 'revision' | 'scheduler' | 'power' | 'sessionDefaultPermission' | 'stateMachine' | 'maxConcurrentRuns' | 'maxDoneTasks' | 'awaitingAnswer' | 'reviewPlans' | 'pendingReleases'>;
}
/** The selected task (resolved from the ledger), or undefined. */
export declare function selectedTaskOf(snapshot: ControllerSnapshot): TaskRecord | undefined;
/**
 * Board controller (see module doc). All mutations bump the snapshot and
 * persist through the store; UI and DOM mounts subscribe and re-render.
 */
export declare class BoardController {
    private readonly deps;
    private tasks;
    private boardOpen;
    private archiveView;
    private selectedTaskId;
    private executionOptions;
    private workspaceCreator;
    private listeners;
    private disposers;
    private readonly now;
    private readonly uuid;
    /**
     * The outbox: user actions accepted immediately and handed to the Host in the
     * background. This is what makes every UI action possible while the backend is
     * busy — the board never waits on a request, never disables a control because
     * of one, and never turns a slow Host into a "timeout" for the user.
     */
    private readonly outbox;
    /** One FIFO drain per card (and one global drain for multi-card actions). */
    private readonly outboxDrains;
    private readonly outboxDraining;
    /** A kick arrived while the same card's loop was still finishing. */
    private readonly outboxKickPending;
    /** Per-entry retry timers (keyed by requestId). */
    private readonly outboxTimers;
    private outboxError;
    private readonly noticeList;
    private readonly seenHostNotices;
    /**
     * Transition intents (a status move that starts a run/clarify included).
     * One per card: a newer click replaces the older intent. They wait outside
     * the outbox until no action for the card is in flight, then enter it; the
     * outbox owns retries and request-id idempotency.
     */
    private readonly transitionQueue;
    /** Last transition failure per card; cleared by the card's next action. */
    private readonly transitionErrors;
    private transitionPumpQueued;
    private pumpingTransitions;
    /**
     * Modal form drafts, keyed per modal (the client owns the key vocabulary).
     * They live here — not in the popup components — so closing a popup by an
     * accidental click next to it, by Escape, or by Cancel never throws typed
     * input away: the modal's next mount reads its draft back. In memory only,
     * so a page reload is a clean start.
     */
    private readonly formDrafts;
    private transportError;
    private sessionOpenError;
    private hostState;
    private remoteSubscribed;
    private remoteInitialization;
    /** @param deps - store and the sessions navigation face. */
    constructor(deps: ControllerDeps);
    /** Load the persisted ledger and start the navigation/status subscriptions. */
    start(): void;
    /** Stop all subscriptions and drop retained state (idempotent). */
    dispose(): void;
    getSnapshot(): ControllerSnapshot;
    subscribe(fn: () => void): () => void;
    /** Whether production mutations are confirmed by the Host transport. */
    isHostBacked(): boolean;
    /**
     * Wait until every queued outbox chain has finished its current send. Waiting
     * entries (a broken connection) are not awaited: they retry on their own.
     * Tests and the host-sync retry use this instead of polling.
     */
    whenIdle(): Promise<void>;
    /** Retry initial migration/state synchronization after an explicit Host error. */
    retryHostSync(): Promise<boolean>;
    openBoard(): void;
    closeBoard(): void;
    toggleBoard(): void;
    /**
     * Switch between the kanban columns and the archive view. Leaving the
     * archive view with an archived task still selected closes the selection —
     * the detail overlay must not linger over a task that is off-board.
     */
    toggleArchiveView(): void;
    openTask(id: string): void;
    closeTask(): void;
    /**
     * The draft one modal left behind, or undefined when nothing waits under that
     * key. The caller owns the key vocabulary (one key per modal instance), so a
     * draft for one card never reappears while a different card is being edited.
     */
    getFormDraft<T>(key: string): T | undefined;
    /** Keys of the drafts currently held (the board's "new task" mark reads this). */
    formDraftKeys(): readonly string[];
    /** Keep one modal's field values after its popup closed. */
    saveFormDraft(key: string, value: unknown): void;
    /** Drop one modal's draft: an explicit discard, or a form nobody touched. */
    discardFormDraft(key: string): void;
    createTask(input: NewTaskInput): TaskRecord | undefined;
    /** Create through the Host and expose the task only after confirmation. */
    createTaskConfirmed(input: NewTaskInput): Promise<TaskRecord | undefined>;
    /**
     * Accept a new task immediately and hand it to the Host in the background.
     * The card appears when the Host confirms it; a rejection restores the caller's
     * draft through `onRejected`. The dialog can close at once — the user is never
     * blocked by the round trip.
     * @returns the id the card will have.
     */
    queueCreateTask(input: NewTaskInput, hooks?: {
        onAccepted?: () => void;
        onRejected?: (message: string) => void;
    }): string;
    /**
     * Apply an editable-field patch (task content + execution targets).
     * Host-backed: the Host ledger owns the fail-closed checks (the content of
     * an executed task is read-only) and confirms the mutation, so the resolved
     * value reflects whether the Host accepted it; the legacy in-memory path
     * applies and persists synchronously.
     * @returns true when the patch was accepted by the authority.
     */
    updateTask(id: string, patch: TaskUpdatePatch): Promise<boolean>;
    /**
     * Accept an edit immediately and hand it to the Host in the background. The
     * modal closes at once; a rejection restores the draft through `onRejected`.
     */
    queueUpdateTask(id: string, patch: TaskUpdatePatch, hooks?: {
        onAccepted?: () => void;
        onRejected?: (message: string) => void;
    }): void;
    /**
     * Replace (a part of) the picker option sets the UI feeds (workspace list
     * and agent-preset roster come from the runtime, not the ledger).
     */
    setExecutionOptions(patch: Partial<ExecutionOptionsSnapshot>): void;
    /** Wire (or clear) the runtime's project registration face (issue #1536). */
    setWorkspaceCreator(creator: WorkspaceCreator | undefined): void;
    /**
     * Register an existing host directory as a DSH project, exactly as the GUI's
     * own "add project" does; the runtime's failure message surfaces unchanged.
     */
    createWorkspace(path: string): Promise<{
        workspaceId: string;
    }>;
    /** Whether this deployment can parse pasted text into task fields (issue #1540). */
    canParseTask(): boolean;
    /**
     * Parse pasted text into task fields through the Host. The transport already
     * phrases every failure for the user, so its message surfaces unchanged.
     */
    parseTaskDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>;
    /**
     * Ask for a manual status move. Host-backed this only enqueues the intent:
     * the controller sends it (through the outbox) when no other action for the
     * card is in flight and the machine/preconditions allow it, then waits for
     * the confirmed snapshot. The legacy in-memory path still applies the move
     * synchronously.
     */
    moveTask(id: string, status: TaskStatus): void;
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
    moveTasks(ids: readonly string[], status: TaskStatus): Promise<boolean>;
    /**
     * Drop the card's waiting transition intent. A move already handed to the
     * outbox is not retracted (the intent leaves the queue before that), so the
     * cancel control only exists while the card is actually waiting.
     */
    cancelTransition(taskId: string): void;
    /**
     * Record why a drop/click could not even be queued (hard blocker). The card
     * shows a badge and the detail the reason until its next action.
     */
    noteTransitionBlocked(taskId: string, blocker: TransitionBlocker, to?: TaskStatus): void;
    deleteTask(id: string): void;
    /**
     * Archive a task from any status but `running`, whose lifecycle the runner
     * keeps exclusive ownership of until it settles.
     * @returns true when applied.
     */
    archiveTask(id: string): boolean;
    /** Restore an archived task back onto the board (same status column). */
    restoreTask(id: string): boolean;
    /**
     * Update a task's schedule rule. A blank or invalid cron expression is
     * rejected (returns false, state untouched). When the rule ends up enabled
     * the next run instant is computed immediately; a disabled rule carries no
     * next-run instant. Delegates the domain transition to the schedule use case.
     * @param id - the task to schedule.
     * @param patch - fields to change (absent fields keep their current value).
     * @returns true when applied, false when rejected (invalid cron / unknown task).
     */
    setSchedule(id: string, patch: {
        enabled?: boolean;
        cron?: string;
    }): boolean;
    /**
     * Legacy pure-controller seam retained for migration-focused tests. The
     * production browser never rolls schedules; the Host ledger owns them.
     */
    applyScheduleNextRun(id: string, nextRunAt: number | undefined, lastTriggeredAt: number | undefined): void;
    /**
     * Reload the legacy v1 store without notifying subscribers. Production v2
     * reads Host snapshots instead; this remains only for isolated legacy tests.
     */
    reloadFromStore(): void;
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
    openSession(sessionId: string): boolean;
    /** Clear a failed session-jump notice. */
    dismissSessionOpenError(): void;
    /** Select and close the board; false when the runtime refuses the id. */
    private selectSession;
    /** Second chance for an unlisted session: refresh the roster, then retry. */
    private refreshAndSelectSession;
    /**
     * Request a Host execution for a task: the Host ledger owns the running
     * transition, the execution record, and the settlement. The action is
     * accepted immediately (queued per card); a status that forbids it is
     * reported as a notice instead of silently doing nothing.
     */
    runTask(id: string): Promise<boolean>;
    /**
     * Confirm a card's above-default permission binding through the Host
     * (resolves the pending-confirmation transaction; no-op otherwise).
     */
    confirmPermission(id: string): Promise<boolean>;
    /** Re-run a settled task through the Host (the Host replans and executes). */
    rerunTask(id: string): Promise<void>;
    /**
     * Start the card's version for the manual review. Only a card standing in the
     * review column may ask: the Host refuses anything else, and the board hides
     * the controls everywhere else anyway.
     * @returns whether the action was accepted locally.
     */
    reviewStart(id: string): Promise<boolean>;
    /** Stop the card's review version again (compose project or configured command). */
    reviewStop(id: string): Promise<boolean>;
    /**
     * Restart the card's review version: the Host stops a running environment
     * first and starts it again, so a rebuilt image or a changed config takes
     * effect without two clicks.
     */
    reviewRestart(id: string): Promise<boolean>;
    private reviewAction;
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
    approveMerge(id: string): Promise<boolean>;
    /**
     * Open the card's version in the configured editor (or the `*.code-workspace`
     * it carries). The Host launches the editor on its own machine, so this is a
     * read-only Host call rather than an action: nothing about the ledger changes.
     */
    openWorktree(id: string): Promise<TaskBoardReviewResponse>;
    /** Snapshot of the card's container/application logs, for the detail modal. */
    loadReviewLogs(id: string): Promise<TaskBoardReviewResponse>;
    /** `git diff --stat` of the reviewed commit against the card's base branch. */
    loadReviewDiff(id: string): Promise<TaskBoardReviewResponse>;
    /**
     * One review read against the Host. A deployment without that route answers
     * with its reason instead of throwing, so the panel can show what happened.
     */
    private reviewRead;
    /**
     * Pause the in-progress runs of `ids` in one Host action: each card keeps its
     * column and its execution record, the Host stops the run's session. The
     * board's bulk button sends every in-progress card at once, so one click
     * suspends the whole column in a single ledger write.
     * @returns whether the action was accepted locally.
     */
    pauseTasks(ids: readonly string[]): Promise<boolean>;
    /**
     * Resume paused runs: the Host clears the pause and writes the "continue"
     * turn into each run's own conversation (a run that never got a session goes
     * back into the launch queue).
     * @returns whether the action was accepted locally.
     */
    resumeTasks(ids: readonly string[]): Promise<boolean>;
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
    private onSessionsChanged;
    private persistAndNotify;
    /** The machine the Host currently enforces (the shipped one as fallback). */
    private transitionMachine;
    /**
     * Queue one manual move for the card. Hard blockers are refused at once (the
     * button is disabled for them anyway) and recorded so the popup/card can say
     * why; a valid intent replaces any older waiting intent for the same card.
     */
    private enqueueTransition;
    private failTransition;
    /** Schedule a pump after the current microtask queue (deduped). */
    private scheduleTransitionPump;
    /**
     * Send every intent whose card is free. A card with an outbox action is
     * skipped (the outbox hooks pump again when that action settles); a card
     * whose source column changed, or that hit a hard blocker in the meantime,
     * loses its intent with a recorded reason.
     */
    private pumpTransitionQueue;
    /**
     * Hand one intent to the outbox. The outbox serialises per card, retries a
     * broken connection with the same request id and reports a definitive
     * rejection through the hook, so the intent queue never duplicates that work.
     */
    private sendQueuedTransition;
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
    private enqueue;
    /** Await the Host's verdict for one action (compatibility seams and tests). */
    private enqueueConfirmed;
    /**
     * Start draining one card's queue. The loop is intentionally **head-of-line
     * blocking**: an action that is waiting for a retry keeps the later actions of
     * the same card queued (otherwise a second move could overtake the first),
     * while every other card keeps its own loop. A waiting head ends the loop; its
     * retry timer starts it again.
     */
    private kick;
    private drainKey;
    private send;
    private scheduleRetry;
    private removeEntry;
    /** Re-send every waiting action now (the banner's retry button). */
    retryOutbox(): void;
    /** Drop every waiting action (the banner's discard button). */
    discardOutbox(): void;
    /** Report a locally refused action (status-forbidden) as a notice. */
    refuse(message: string, taskId?: string): void;
    dismissNotice(id: string): void;
    private pushNotice;
    private taskRefusal;
    private actionLabel;
    /** Show Host-derived notices once (deduped by their Host-generated id). */
    private ingestHostNotices;
    private initializeRemote;
    private doInitializeRemote;
    /**
     * SSE frames carry revision/scheduler/power. When the revision matches the
     * one already applied, apply the frame's scheduler/power in place and skip
     * the full /state fetch; otherwise the 5 s heartbeat would re-clone and
     * re-serialize the whole ledger per tab even while nothing changes.
     */
    private onRemoteEvent;
    private refreshRemote;
    private acceptRemote;
    private notify;
}
