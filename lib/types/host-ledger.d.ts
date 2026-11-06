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
 * the card's run (`execution.kind` undefined — the `run` action, cron) or one of
 * the rounds that keep the card's column (`execution.kind === 'clarify'` for the
 * `backlog → clarification` step, `'test'` for the `testing` column, `'merge'`
 * for the automatic conflict resolution): they share the launch queue, but the
 * lane gates differ — the implementation run and the test run each obey their
 * own per-lane limit, the clarification column is WIP-free; they also differ in
 * the prompt and in whether settling moves the card.
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
    /** `'clarify'`/`'test'`/`'merge'` for the column-keeping rounds; a real run otherwise. */
    readonly kind: 'clarify' | 'merge' | 'test' | undefined;
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
     * Live task references (no clone) for the Host's event projection: the delta
     * builder compares task objects by identity, which is exactly how the ledger
     * mutates them (a changed card is a new object in a new array). Never serialize
     * the returned array directly — it is the document's own state.
     */
    tasksReference(): readonly TaskRecord[];
    /** Publish one derived Host message (service-side actions: a refused stop, an abort). */
    note(taskId: string | undefined, message: string): void;
    /**
     * The card conversations the orphan watchdog follows, one row per card:
     * whether that conversation still backs an open run, whether the card is
     * paused, whether it was explicitly stopped, and when the run settled (the
     * human-turn check anchors there). Deliberately a cheap projection — it runs
     * on every poll.
     */
    sessionWatch(): Array<{
        taskId: string;
        sessionId: string;
        open: boolean;
        paused: boolean;
        pausedAt?: number;
        settledAt?: number;
        /** What the newest settled run on that conversation was. */
        kind?: ExecutionRecord['kind'];
        /** The conversation was stopped from the card and must not be adopted. */
        stopped: boolean;
        status: TaskRecord['status'];
        archived: boolean;
        /** Archived, but still inside the warm window: the conversation is kept. */
        warm: boolean;
    }>;
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
     * The cards the rework watch follows: every settled card in `testing`,
     * `tested` or `failed`, with the conversation the human would write the
     * correction into. A cheap projection on purpose — the watch runs on the hot poll path,
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
     * Close the test run of the `testing` column that is still waiting for the
     * lane's test slot, because the human moved the card on: the status change
     * wins over the queued test. A test run that already attached its session is
     * working and is never discarded here (the move refuses it, as before). A
     * launch not started yet is dropped by the pump's self-heal.
     */
    private supersedeQueuedTest;
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
     * Archived cards whose warm cache may be released now: the retention window
     * after the archive stamp has passed for every card sharing their checkout or
     * conversation, no card on the board references either resource, and no run of
     * theirs is still open. A cheap projection for the Host poll — it never clones
     * the document and is a pure read (`core/warm-cache.ts`).
     * @param now - the instant to judge the windows against.
     * @returns ids of the cards to stamp through {@link HostTaskLedger.markWarmReleased}.
     */
    expiredWarmTaskIds(now?: number): string[];
    /**
     * Stamp the warm-cache release on archived cards and persist it in one write.
     * The cards stay archived (their status, history and the recorded
     * `worktreePath`/session ids are untouched); the marker only says that the
     * retention expired, so the Host may remove the checkout and stop the session.
     * A card that was restored in between is left alone.
     * @param ids - ids from {@link HostTaskLedger.expiredWarmTaskIds}.
     * @param now - release instant (ms epoch).
     */
    markWarmReleased(ids: readonly string[], now?: number): void;
    /**
     * Sessions of released archived cards that still need stopping: the Host
     * stops them on the release, but a stop can fail (the runtime answers slowly
     * or not at all) and the card is long archived, so the poll retries until the
     * conversation is at rest. Sessions a card on the board references are left
     * out — a restored card (or a live follow-up) is using them again.
     */
    releasedWarmSessions(): string[];
    /**
     * Archived cards whose warm cache was released and whose worktree directory
     * still exists, so the Host poll can retry the removal: git may refuse (a
     * locked worktree, an open file) and the removal may have failed earlier. A
     * runtime projection on the hot poll path — it never clones the document.
     * Cards whose checkout is still named by a live card (a follow-up on the
     * source's worktree) are left out: their removal is not this card's to do,
     * and a warm card (no release stamp yet) is never touched.
     */
    archivedWorktrees(): TaskRecord[];
    /** Follow-up cards started from this card (archived ones included). */
    private followUpsOfTask;
    /**
     * Ids of cards whose conversation a follow-up owns. These cards are excluded
     * from every conversation watch (session adopt/stop, rework, awaiting answer):
     * the session's activity belongs to the follow-up now, and treating it as the
     * source's would stop or move the source while the follow-up works.
     */
    private followUpSourceIds;
    /**
     * The card is the source of a follow-up, so its conversation and branch are
     * the follow-up's now: it neither runs again nor releases that branch while
     * any follow-up card exists. The reverse direction is derived (no stamp on the
     * source), so deleting the follow-up card releases the source again.
     */
    private followUpLocked;
    /** Whether another live card still uses this checkout (source and follow-up share one). */
    private worktreeSharedByOther;
    /**
     * Resolve and validate the source card of a follow-up create. The checks are
     * the Host's answer to a stale browser dialog: the card must still be a
     * settled source with a free conversation, and it must not already have an
     * unfinished follow-up (one at a time; a follow-up that reached `done` or was
     * archived frees the source again).
     */
    private followUpSource;
    /**
     * Turn a freshly created card into a follow-up of `source`: freeze the
     * source's readable text, inherit the conversation and the branch/worktree
     * the follow-up continues, and force session reuse (a follow-up is a
     * continuation by definition). The review stamps of the source are
     * deliberately not copied — this card is reviewed on its own.
     */
    private withFollowUpLink;
    /**
     * The merge release of one card: replay its feature branch onto the base
     * branch as that stands now and merge it back. The git work is queued on the
     * card's work chain and the action returns at once with `pending: true`: the
     * card stays in `tested` (a derived "release running" marker explains the
     * wait) until the outcome is written back. Nothing optimistic ever claims
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
     *   the card goes to `clarification` with the reason, and the automatic
     *   clarification run asks how the problem should be fixed,
     * - the replay conflicts: the half-done rebase is left in the card's own
     *   worktree and the card goes to `running` on a `merge` run; one automatic
     *   resolution run per release, whose settle retries the release. If that
     *   retry fails too, the card goes to `clarification` as above; an aborted
     *   resolution run is a pause and leaves the card in `running`.
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
     * conflict aborts the half-done replay and ends the release in `clarification`,
     * so the release can never become a loop. Aborting puts the branch back onto
     * the commit the human reviewed, which is what a later release starts from
     * again; the question round then settles how to fix the conflict.
     */
    private resolveConflict;
    /**
     * Park a failed release in `clarification` and open the card's question round
     * there. The failure happened in the card's own conversation, so the round
     * continues the newest session it can find — the agent already knows the merge
     * it is asked about, and the run is WIP-free like every clarification run. The
     * human answers in the chat and pulls the card on to the run column; that
     * implementation turn carries the answer out.
     *
     * A card that already holds an open run is left alone: it must never carry two
     * open executions, and an open clarification round is already the round this
     * failure needs.
     */
    private clarifyAfterFailedRelease;
    /**
     * What happens once a conflict-resolution run settled. A run that did not
     * succeed (or one that ended with the replay still unfinished) leaves the
     * conflict unresolved: the worktree is put back into a clean state, the card
     * says why, and the release ends in `clarification`, where the automatic
     * question round asks how the problem should be fixed. A run that did resolve
     * it queues the release retry after that run's settle commit, which either
     * finishes the release (`done`) or sends the card to `clarification` as well.
     *
     * A cancelled run never reaches this path: the Host turns that abort into a
     * pause (see {@link settle}), so the card stays in `running` with the conflict
     * still in its worktree.
     */
    private onMergeRunSettled;
    dispose(): void;
    applyRequest(requestId: string, action: TaskBoardAction, initiator?: string): {
        state: LedgerState;
        run?: OpenedRun;
        clarification?: OpenedRun;
        paused?: PausedRun[];
        resumed?: ResumedRun[];
        stopped?: PausedRun[];
        review?: ReviewIntent[];
    };
    openScheduled(taskId: string, nextRunAt: number | undefined, triggeredAt: number): OpenedRun | undefined;
    skipMissed(now: number): void;
    setScheduler(patch: Partial<TaskBoardSchedulerSnapshot>): void;
    attachSession(taskId: string, executionId: string, sessionId: string): void;
    /**
     * Whether a follow-up owns this card's conversation. The board's stop
     * controls and the pause path consult this so a stale click on the source
     * card can never stop the follow-up's session.
     */
    isFollowUpSource(taskId: string): boolean;
    /**
     * Record that the follow-up framing was written into the source conversation.
     * Stamped by the Host service only after a launch actually prompted the card,
     * so a failed launch keeps the framing pending (the next run sends it again).
     * The reverse is deliberately not stamped: every run that has to start a fresh
     * conversation re-sends the frame together with the frozen source text, so the
     * link to the previous task can never be lost silently.
     */
    markFollowUpInjected(taskId: string): void;
    /**
     * Re-open a settled card for a conversation that is working again.
     *
     * The board is authoritative about columns, the session about whether work is
     * happening. Normally the session ends first and the settle follows; when a
     * job notice (or another wake-up) starts a new turn only after the card was
     * parked, the card would claim "finished" while its session keeps working.
     * This is the reverse direction of {@link HostTaskLedger.settle}: it opens a
     * new execution on the *running* conversation instead of launching anything —
     * no prompt, no queue slot, no git step. The ordinary inspection then settles
     * that execution when the session comes to rest again.
     *
     * Only cards in a settled column that does not already own a run are eligible;
     * paused, archived, done and open-run cards are refused, the session the human
     * stopped from the card is refused by its stop marker, and the service decides
     * *when* the conditions hold.
     * @param taskId - the card whose conversation runs again.
     * @param sessionId - the running conversation.
     * @param kind - the kind of the settled run (so a clarification stays in its
     *   column and a merge run keeps its conflict-resolution semantics).
     * @returns whether the card was re-opened.
     */
    adoptRunningSession(taskId: string, sessionId: string, kind: ExecutionRecord['kind']): boolean;
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
    /**
     * End the card's conversation from the card: stamp the explicit stop and
     * settle every open run as cancelled in the very same Host step.
     *
     * The settle is deliberately immediate. A stop is a human decision about the
     * run, and a session that was killed (or no longer answers) can never produce
     * the `turn/end` + `sessionEnded()` evidence `inspect()` waits for. Deferring
     * the settle to that evidence is exactly what left a deliberately stopped card
     * claiming `running` with an execution nothing would ever close.
     *
     * A conflict-resolution run keeps its exception: {@link settle} pauses it, so
     * the conflict stays in the worktree and the card remains resumable. The stop
     * marker is kept in either case; it refuses the adoption pass on exactly this
     * session until the card starts (or resumes) again.
     *
     * The marker is written even when the card owns no open run: a late
     * conversation of a settled card is still the session the human just stopped,
     * and adoption must not revive it.
     * @param taskId - the card.
     * @param sessionId - the conversation the human stopped, when it had one.
     * @param reason - the execution error shown in the card's history.
     */
    stopCard(taskId: string, sessionId: string | undefined, reason: string): void;
    /**
     * Clear an explicit stop marker after the human took the conversation back
     * (a message in a paused stopped card resumes it). A new run clears the
     * marker in {@link startExecution} instead.
     */
    clearStopMarker(taskId: string): void;
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
