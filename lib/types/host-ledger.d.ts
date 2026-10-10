import { type ExecutionRecord, type TaskRecord } from './core/tasks.ts';
import { type StateMachine } from './core/state-machine.ts';
import { type TaskBoardAction, type TaskBoardSchedulerSnapshot } from './protocol.ts';
import { type TaskPermission } from './core/handover.ts';
import type { GitWorkflow } from './git-workflow.ts';
export interface LedgerState {
    revision: number;
    tasks: TaskRecord[];
    scheduler: TaskBoardSchedulerSnapshot;
}
/**
 * A card whose execution the Host still has to start. The execution is either
 * the card's run (`execution.kind` undefined — the `run` action, cron) or its
 * clarification run (`execution.kind === 'clarify'`, the `backlog → todo`
 * step): the two share the launch queue, but only the implementation run obeys
 * the lane WIP limit — `todo` is WIP-free; they also differ in the prompt and
 * in whether settling moves the card.
 */
export interface OpenedRun {
    task: TaskRecord;
    execution: ExecutionRecord;
}
/**
 * A run the `pause` action suspended: the Host service stops `sessionId` (when
 * the run had already attached one) so the agent stops working. The card keeps
 * its column and its open execution; only the session's active turn is ended.
 */
export interface PausedRun {
    taskId: string;
    sessionId: string | undefined;
}
/**
 * A run the `resume` action released: the Host service continues the run's own
 * conversation with a "continue" turn (`sessionId`), or — for a run that was
 * still waiting for a WIP slot and never got one — hands it back to the launch
 * queue.
 */
export interface ResumedRun {
    task: TaskRecord;
    execution: ExecutionRecord;
}
/** Minimal value copy used by the Host session monitor. */
export interface OpenExecutionReference {
    readonly taskId: string;
    readonly executionId: string;
    readonly sessionId: string | undefined;
    readonly startedAt: number;
    /** WIP lane (effective workspace id) the run counts against; '' when unpinned. */
    readonly lane: string;
    /** `'clarify'` for the card's clarification round; a real run otherwise. */
    readonly kind: 'clarify' | undefined;
}
/**
 * One card the rework watch follows (see {@link HostTaskLedger.reworkWatch}): a
 * settled card plus the conversation a human turn would arrive in.
 */
export interface ReworkWatchEntry {
    readonly taskId: string;
    readonly sessionId: string;
    /** When the card parked; older turns belong to the run that settled. */
    readonly since: number;
}
/**
 * One card the question watch follows (see
 * {@link HostTaskLedger.awaitingAnswerWatch}): a card plus the conversation a
 * question of the agent would be waiting in.
 */
export interface AnswerWatchEntry {
    readonly taskId: string;
    readonly sessionId: string;
}
/** Minimal value copy used by the Host scheduler. */
export interface DueScheduleReference {
    readonly taskId: string;
    readonly cron: string;
    readonly nextRunAt: number;
}
/** Derived runtime data for one session-poll pass. */
export interface LedgerRuntimeView {
    readonly armedSchedules: number;
    readonly openExecutions: readonly OpenExecutionReference[];
}
/**
 * Best-effort single-letter process state ('R','S','D','Z',...) or undefined
 * when no probe is available on this platform. Linux reads /proc/<pid>/stat
 * directly (no subprocess); other POSIX shells out to `ps -o stat=`; Windows
 * has no zombie state, so it returns undefined and the kill(0) probe alone
 * is authoritative there.
 */
export declare function processState(pid: number): string | undefined;
export declare function processIsAlive(pid: number): boolean;
export declare class HostTaskLedger {
    private readonly now;
    private document;
    private readonly listeners;
    private readonly requestCache;
    private readonly lockToken;
    private lockFd;
    readonly file: string;
    readonly lockFile: string;
    /** Small sidecar for the 30 s scheduler heartbeat (lastTickAt only). */
    readonly schedulerFile: string;
    /** Session-default permission the confirmation gate compares against. */
    readonly sessionDefaultPermission: TaskPermission;
    /** Optional git integration; undefined disables the branch/merge hooks. */
    private readonly git;
    /** Done-column limit: on-board `done` cards allowed before FIFO displacement. */
    private maxDoneTasks;
    /**
     * The Done-column limit in force. Read-only accessor for the Host snapshot,
     * which reports the configuration to the browser alongside the state.
     */
    get maxDoneTasksLimit(): number;
    /** The configurable state machine that validates every move and names its actions. */
    private machine;
    constructor(dir?: string, now?: () => number, options?: {
        sessionDefaultPermission?: TaskPermission;
        git?: GitWorkflow;
        maxDoneTasks?: number;
        stateMachine?: unknown;
    });
    /** Remove leftover *.tmp-* files from previous crashes or interrupted writes. */
    private cleanStaleTemporaryFiles;
    /** Revision + scheduler without any task cloning; feeds the SSE event frame. */
    summary(): {
        revision: number;
        scheduler: TaskBoardSchedulerSnapshot;
    };
    state(): LedgerState;
    /**
     * The state machine currently in force, i.e. what the Host validates moves
     * against and what the browser renders its columns and drop targets from.
     */
    get stateMachine(): StateMachine;
    /**
     * Apply the board's state machine (settings namespace `task-board`, field
     * `stateMachine`). Takes effect on the next move; an invalid config is
     * ignored by the resolver, which keeps the machine already in force.
     * @param config - raw machine config; undefined keeps the shipped machine.
     * @returns the refusals of an invalid config (empty when it was applied).
     */
    setStateMachine(config: unknown): string[];
    /**
     * Apply the board's Done-column limit (settings namespace `task-board`,
     * `maxDoneTasks`) and converge the column immediately: an already over-limit
     * `done` column (a lowered limit, restored cards, a freshly imported ledger)
     * is trimmed right here, so the board never keeps showing more than N cards
     * until the next move. Displacement keeps the FIFO order and archives (never
     * deletes) exactly the surplus.
     * @param limit - configured maximum; values below 1 or non-finite keep the default.
     */
    setMaxDoneTasks(limit: number): void;
    /**
     * Runtime-only projection for the 5 s Host poll. It copies just primitive
     * identifiers and timestamps, never the complete task/execution history or
     * an authoritative mutable object from the ledger.
     */
    runtimeView(): LedgerRuntimeView;
    /**
     * The cards the rework watch follows: every settled card in `ready_for_test`
     * or `failed`, with the conversation the human would write the correction
     * into. A cheap projection on purpose — the watch runs on the hot poll path,
     * which must not clone the whole document.
     */
    reworkWatch(): ReworkWatchEntry[];
    /**
     * The cards the question watch follows: every card that can currently be
     * waiting for the human's answer, with the conversation that answer would go
     * into. Cheap on purpose — the watch runs on the hot poll path, which must not
     * clone the whole document.
     *
     * Two kinds qualify. A card with an open, unsettled run: the agent may ask
     * inside it (a blocking `ask_user_question`, or a prose question it stopped
     * on). And a `todo` card that already ran its clarification round: that run
     * settles without moving the card, so the questions it asked are still
     * unanswered in the very conversation the card keeps. Paused cards are left
     * out — their session was stopped deliberately, which is not a wait.
     */
    awaitingAnswerWatch(): AnswerWatchEntry[];
    /** Whether the card's open run is currently suspended by a pause. */
    isPaused(taskId: string): boolean;
    /**
     * Whether `executionId` of `taskId` is still unsettled. A queued launch asks
     * this right before it starts: the go-ahead of a card whose clarification run
     * was still waiting closes that execution, and starting its session anyway
     * would mint the second conversation the card must never have.
     */
    isOpenExecution(taskId: string, executionId: string): boolean;
    /**
     * Clear a pause stamp without resuming the run. Used when stopping the paused
     * session failed (no live agent to stop): the card goes back to the normal
     * monitor, which settles the run on its own instead of leaving it frozen.
     */
    clearPause(taskId: string): void;
    /** Count armed, non-archived schedules without cloning task histories. */
    armedScheduleCount(): number;
    /** Return value-only references for schedules due at the supplied Host time. */
    dueSchedules(now: number): DueScheduleReference[];
    subscribe(listener: () => void): () => void;
    /**
     * Close the card's open clarification round, if it has one, because the human
     * pulled the card on to the run column: the implementation takes over that
     * conversation, and the card must never hold two open executions (or two
     * conversations). The round is recorded as cancelled — it was neither
     * completed by the agent nor failed — and a launch not started yet is dropped
     * by the pump.
     */
    private supersedeClarification;
    /**
     * Ensure the card has a feature branch before it starts. The backlog → todo
     * pull normally opens it; a cron trigger or the detail Run button may bypass
     * that, and those runs must not land on the base branch. No-op without a
     * repository or when a branch already exists.
     */
    private withFeatureBranch;
    /**
     * The card after a transition's git hooks ran, in configured order. Only the
     * first git action of a transition applies; `"git": false` skips them
     * entirely; without a repository the hooks are no-ops. Shared by the
     * single-card and the batch move so a group drop fires exactly the hooks a
     * single drop of the same card would.
     */
    private transitionGit;
    /**
     * Commit the card's worktree onto its feature branch, stamping `committedAt`.
     * A git failure never fails the move or the settle — the worktree is the
     * human's to repair — so the error is appended to the card's newest *settled*
     * execution `error`, which its execution history shows. A card without one
     * (never ran, or only a clarification round is open) has nothing to carry it
     * and only gets a Host warning.
     */
    private commitWork;
    /**
     * Commit the work an implementation run left behind as it settles, so the
     * worktree never keeps uncommitted card work — not even when the run failed
     * or was cancelled, and not after a restart reconciled an interrupted start.
     * A clarification run implements nothing and checks no branch out, so it
     * never mints a commit of whatever the worktree happens to hold.
     */
    private commitSettledWork;
    dispose(): void;
    applyRequest(requestId: string, action: TaskBoardAction, initiator?: string): {
        state: LedgerState;
        run?: OpenedRun;
        clarification?: OpenedRun;
        paused?: PausedRun[];
        resumed?: ResumedRun[];
    };
    openScheduled(taskId: string, nextRunAt: number | undefined, triggeredAt: number): OpenedRun | undefined;
    skipMissed(now: number): void;
    setScheduler(patch: Partial<TaskBoardSchedulerSnapshot>): void;
    attachSession(taskId: string, executionId: string, sessionId: string): void;
    settle(taskId: string, executionId: string, outcome: 'succeeded' | 'failed' | 'cancelled', error?: string): void;
    private apply;
    private repairSchedules;
    private reconcileInterruptedStarts;
    /**
     * Field-preserving v2 to v3 migration. v3 adds no fields yet, so the
     * migration reuses the v3 normalization, but it first proves every task
     * row is structurally valid: a v2 document that would silently drop or
     * coerce rows fails loudly instead (no quarantined-empty restart).
     */
    private migrateLegacyDocument;
    private load;
    private normalizeDocument;
    /** Quarantine an unreadable document and start from an empty ledger. */
    private recoverCorrupt;
    private syncRecentRequests;
    private readSchedulerSidecar;
    /** Atomic write of the scheduler heartbeat sidecar (0600, tmp + rename + fsync). */
    private writeSchedulerSidecar;
    private commit;
    private notify;
    private acquireLock;
}
