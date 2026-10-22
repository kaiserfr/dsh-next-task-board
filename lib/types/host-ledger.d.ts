import type { TaskCompose, TaskReview } from './core/tasks.ts';
import { type ExecutionRecord, type TaskRecord } from './core/tasks.ts';
import { type StateMachine } from './core/state-machine.ts';
import { type TaskBoardAction, type TaskBoardNotice, type TaskBoardSchedulerSnapshot } from './protocol.ts';
import { type TaskPermission } from './core/handover.ts';
import { type GitWorkflow } from './git-workflow.ts';
export interface LedgerState {
    revision: number;
    tasks: TaskRecord[];
    scheduler: TaskBoardSchedulerSnapshot;
}
/**
 * A card whose execution the Host still has to start. The execution is either
 * the card's run (`execution.kind` undefined — the `run` action, cron) or its
 * clarification run (`execution.kind === 'clarify'`, the `backlog →
 * clarification` step): the two share the launch queue, but only the
 * implementation run obeys the lane WIP limit — the clarification column is
 * WIP-free; they also differ in the prompt and in whether settling moves the
 * card.
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
/**
 * A review action the Host service has to carry out: the ledger validates it
 * (the card exists, is not archived and stands in the review column) and hands
 * the intent back instead of doing the work itself. Starting or stopping a
 * version can take minutes — compose builds images, a start script runs — so the
 * service runs it off the ledger write and writes the outcome back with
 * {@link HostTaskLedger.noteReview}; nothing about the in-flight action is
 * persisted, which is exactly why a Host restart cannot leave a card claiming a
 * start it never finished.
 */
export interface ReviewIntent {
    taskId: string;
    intent: 'start' | 'stop' | 'restart';
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
    readonly kind: 'clarify' | 'merge' | undefined;
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
    /**
     * Per-card work chain: every heavy git job (branch/worktree creation, commit,
     * merge, worktree removal) runs here, off the action request and strictly in
     * order for one card. The action path therefore stays synchronous and fast;
     * an action that needs the result of earlier work awaits the chain first
     * ({@link awaitCard}), which the service does before applying it.
     */
    private readonly cardWork;
    /** Last background git failure per card (branch/worktree creation). */
    private readonly gitFailures;
    /** Cards whose merge release is running right now (derived, never persisted). */
    private readonly releases;
    /** Recent derived messages for the board's toast area. */
    private readonly noticeList;
    /** Runs opened by a background job (conflict resolution); the service takes them. */
    private pendingRuns;
    private disposed;
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
     * One card as a live ledger reference (no clone), for Host-side bookkeeping
     * that must not pay for a whole-ledger copy — a review action resolving its
     * card, or a cleanup notice after the card is gone.
     */
    task(taskId: string): TaskRecord | undefined;
    /**
     * Wait until every background git job queued for one card has finished.
     *
     * The action path calls this before applying an action that depends on the
     * card's git state (a commit must be stamped before the card can be released,
     * a branch must exist before a run starts). It never blocks the browser: the
     * UI has already accepted the action into its outbox, and the event loop keeps
     * serving `/state`, `/parse` and SSE while this promise waits.
     */
    awaitCard(taskId: string): Promise<void>;
    /** Merge releases currently running, as the derived snapshot marker. */
    pendingReleases(): Record<string, {
        startedAt: number;
    }>;
    /** Recent derived Host messages (git failures, refused releases), newest last. */
    notices(): TaskBoardNotice[];
    /** Runs opened by a background job; the service schedules them and calls this again. */
    takeRuns(): OpenedRun[];
    /**
     * Make sure the card stands on its feature branch and worktree before a run
     * starts. Awaits earlier background work first, then creates the branch when
     * the card has a repository but no branch yet. Fails closed: a git error is
     * thrown to the caller (which fails the run visibly), never silently ignored.
     */
    ensureBranch(taskId: string): Promise<TaskRecord | undefined>;
    /**
     * Queue one heavy job on a card's chain. Jobs never reject the chain (their
     * own errors become notices/card records), so one failure cannot wedge the
     * card's later work; the chain resolves when the job has written its outcome.
     */
    private enqueueCardWork;
    /**
     * Patch one card in place and persist when it really changed. Background jobs
     * use this so a card moved/deleted while the job ran is not resurrected and
     * an untouched document is not rewritten.
     */
    private patchTask;
    /** Record one derived user-facing message (kept short-lived; never persisted). */
    private pushNotice;
    private notify;
    /**
     * Cheap projection for the review plan map: the cards standing in the review
     * column. The derived plans are recomputed on every ledger change, so this
     * path must not clone the ledger ({@link HostTaskLedger.state}); the planner
     * only reads each card and the filesystem behind it.
     */
    reviewCandidates(): readonly TaskRecord[];
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
     * on). And a `clarification` card that already ran its clarification round:
     * that run settles without moving the card, so the questions it asked are
     * still unanswered in the very conversation the card keeps. Paused cards are
     * left out — their session was stopped deliberately, which is not a wait.
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
     * Ensure the card has a feature branch before it starts. The backlog →
     * clarification pull normally opens it; a cron trigger or the detail Run
     * button may bypass that, and those runs must not land on the base branch.
     * The branch is created on the card's work chain (off the action request);
     * the run waits for it in `HostTaskBoardService.launch`, which calls
     * {@link ensureBranch}.
     */
    private ensureFeatureBranchLater;
    /** Queue `git.openBranch` for one card (no-op when a branch already exists). */
    private enqueueOpenBranch;
    /**
     * The card after a transition's git hooks were **scheduled**. Only the first
     * git action of a transition applies; `"git": false` skips them entirely;
     * without a repository the hooks are no-ops. The hooks run on the card's work
     * chain instead of inside the action, so a commit or worktree creation never
     * blocks the event loop or the user. Shared by the single-card and the batch
     * move so a group drop fires exactly the hooks a single drop would.
     */
    private transitionGit;
    /**
     * Queue a commit of the card's worktree onto its feature branch. A git failure
     * never fails the move or the settle — the worktree is the human's to repair —
     * so the error is appended to the card's newest *settled* execution `error`
     * and surfaced as a notice. A card without a settled execution has nothing to
     * carry it and only gets the Host warning + notice.
     */
    private enqueueCommit;
    private recordCommitError;
    /**
     * Commit the work an implementation run left behind as it settles, so the
     * worktree never keeps uncommitted card work — not even when the run failed
     * or was cancelled, and not after a restart reconciled an interrupted start.
     * A clarification run implements nothing and checks no branch out, so it
     * never mints a commit of whatever the worktree happens to hold.
     */
    private commitSettledWork;
    /**
     * Drop the previous release record: the card is back in the review column for
     * a new review. Called from the park hooks (the `git.commitBranch` action and
     * a settling run), so the next release starts from a clean slate instead of
     * showing the state of the review before it.
     */
    private clearRelease;
    /** The merge record a release starts from (destructured out of the current card). */
    private releaseBase;
    /**
     * Release the worktrees of cards that just became archived — the explicit
     * archive action and the Done-column limit alike. Archiving is the last board
     * state a card reaches, so no later run needs the directory; the branch, its
     * commits and the review stamp stay in the repository. A git that refuses
     * (a locked worktree, an open file) never fails the archive: the Host poll
     * retries it on the archived card ({@link HostTaskLedger.archivedWorktrees}).
     * @param ids - cards that the archive just took off the board.
     */
    private releaseArchivedWorktrees;
    /**
     * Archived cards whose own worktree directory still exists, so the Host poll
     * can retry releasing it: git may have refused at archive time, or the card
     * was archived before archiving released the worktree. A runtime projection on
     * the hot poll path — it never clones the document.
     */
    archivedWorktrees(): TaskRecord[];
    /**
     * The merge release of one card: replay its feature branch onto the base
     * branch as that stands now and merge it back. The git work is queued on the
     * card's work chain and the action returns at once with `pending: true`: the
     * card stays in `ready_for_test` (a derived "release running" marker explains
     * the wait) until the outcome is written back. Nothing optimistic ever claims
     * a column the Host has not written.
     *
     * The decision table (the human's "Freigeben (Merge)"):
     *
     * - no branch at all (no repository, or a workspace outside git): the release
     *   is the plain move to `done`, recorded as skipped so the card says "no
     *   branch" instead of pretending it merged something,
     * - merge succeeds: `done`, `TaskGit.mergedAt` and {@link TaskMerge.mergedAt}
     *   stamped,
     * - merge refused (dirty worktree, moved branch, no reviewed commit) or fails:
     *   the card goes to `failed` with the reason,
     * - the replay conflicts: the half-done rebase is left in the card's own
     *   worktree and the card goes to `running` on a `merge` run; one automatic
     *   resolution run per release, whose settle retries the release.
     */
    private beginRelease;
    private enqueueRelease;
    /**
     * The background half of a release: check the card is still the card the
     * human approved, then run the merge and write the outcome back. A card that
     * left the review column meanwhile is never moved by a late release.
     */
    private runRelease;
    /** Write a finished release back to the ledger (the only place a release moves a card). */
    private finishRelease;
    /** Persist one release result and keep the Done-column limit converged. */
    private applyReleaseResult;
    /**
     * Hand the release's conflict to the card's agent. The replay onto the base is
     * already sitting in the card's own worktree — conflict markers, a rebase
     * waiting for `git rebase --continue` — so nothing has to be started here: the
     * run sees exactly that state and finishes it.
     *
     * Exactly one resolution run per release (`MERGE_RESOLVE_ATTEMPTS`): a second
     * conflict aborts the half-done replay and fails the release, so the release
     * can never become a loop. Aborting puts the branch back onto the commit the
     * human reviewed, which is what a later release starts from again.
     */
    private resolveConflict;
    /**
     * What happens once a conflict-resolution run settled. A run that did not
     * succeed (or one that ended with the replay still unfinished) leaves the
     * conflict unresolved: the worktree is put back into a clean state, the card
     * says why, and the release ends in `failed` — the second attempt the decision
     * allows is used up. A run that did resolve it queues the release retry after
     * that run's settle commit, which either finishes the release (`done`) or
     * fails it.
     */
    private onMergeRunSettled;
    dispose(): void;
    applyRequest(requestId: string, action: TaskBoardAction, initiator?: string): {
        state: LedgerState;
        run?: OpenedRun;
        clarification?: OpenedRun;
        paused?: PausedRun[];
        resumed?: ResumedRun[];
        review?: ReviewIntent[];
    };
    openScheduled(taskId: string, nextRunAt: number | undefined, triggeredAt: number): OpenedRun | undefined;
    skipMissed(now: number): void;
    setScheduler(patch: Partial<TaskBoardSchedulerSnapshot>): void;
    attachSession(taskId: string, executionId: string, sessionId: string): void;
    /**
     * Record the card's Docker Compose environment (or clear it with `undefined`).
     * Like {@link HostTaskLedger.attachSession} this is a Host-side write, not a
     * browser action: the service owns the lifecycle, and the record only makes
     * the state — project, ports, failure — visible on the card.
     */
    noteCompose(taskId: string, compose: TaskCompose | undefined): void;
    /**
     * Record the card's review environment (or clear it with `undefined`). Like
     * {@link HostTaskLedger.noteCompose} this is a Host-side write, not a browser
     * action: the service owns the lifecycle, and the record only makes the state
     * — how it runs, where, which URLs answer, what failed — visible on the card.
     * A card that left the review column in the meantime keeps no record.
     */
    noteReview(taskId: string, review: TaskReview | undefined): void;
    settle(taskId: string, executionId: string, outcome: 'succeeded' | 'failed' | 'cancelled', error?: string): void;
    private apply;
    private repairSchedules;
    private reconcileInterruptedStarts;
    /**
     * Field-preserving v2 to v3 migration. The migration reuses the v3
     * normalization, but it first proves every task row is structurally valid: a
     * v2 document that would silently drop or coerce rows fails loudly instead
     * (no quarantined-empty restart). The retired `todo` column is mapped to
     * `clarification` before that check, because its role — the waiting column
     * before implementation — moved there.
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
    private acquireLock;
}
