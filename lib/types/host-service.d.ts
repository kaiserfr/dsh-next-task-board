import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway';
import { HostTaskLedger } from './host-ledger.ts';
import { type TaskComposeController } from './compose-workflow.ts';
import { ReviewWorkflow } from './review-workflow.ts';
import { HostExecutionRunner, type GatewayPeer, type SessionCommandDispatcher, type TaskBoardWorkspaceRegistry } from './host-runner.ts';
import { GitWorkflow } from './git-workflow.ts';
import { PowerInhibitor } from './power-inhibitor.ts';
import { type TaskBoardAction, type TaskBoardEventPayload, type TaskBoardReviewRequest, type TaskBoardReviewResponse, type TaskBoardSnapshot } from './protocol.ts';
import type { TaskPermission } from './core/handover.ts';
export declare class TaskBoardHostService {
    readonly ledger: HostTaskLedger;
    readonly runner: HostExecutionRunner;
    readonly power: PowerInhibitor;
    /** Shared git integration: branch hooks in the ledger, checkout before a run. */
    readonly git: GitWorkflow;
    /** Task-scoped Docker Compose environments: up before a run, down afterwards. */
    readonly compose: TaskComposeController;
    /** Review environments: the card's version, started and stopped from the review column. */
    readonly review: ReviewWorkflow;
    private readonly listeners;
    private timers;
    private lastScheduleTick;
    private disposed;
    private pollInFlight;
    private tickInFlight;
    private active;
    /**
     * Ids the last roster poll saw as present and idle; undefined while the
     * roster is unknown. Session reuse (issue #1419) requires this positive
     * evidence, so a launch before the first successful poll mints a fresh
     * conversation instead of prompting into a session it cannot see.
     *
     * Deliberately *not* an input to the WIP accounting: the roster only knows
     * whether a turn is running right now, which is not the same as "the run is
     * over". An implementation run whose agent ended its turn (mid-task question,
     * partial answer) is idle in the roster while its worktree, branch and card
     * are still owned by it — letting the lane's next card start there is exactly
     * the parallel work the WIP limit exists to prevent.
     */
    private idleSessionIds;
    private preventIdleSleep;
    /** Runs waiting for a free WIP slot, in arrival order. */
    private launchQueue;
    /** Per-lane launches already started whose session is not attached yet (invisible to the ledger). */
    private readonly launchesInFlight;
    /**
     * WIP limit per workspace/lane: how many implementation runs may hold a
     * session at once (always >= 1). Clarification runs are exempt.
     */
    private maxConcurrentRuns;
    /**
     * Rework watch: per card in a settled column (`ready_for_test`/`failed`), the
     * `updatedAt` its conversation had when it was last read. An unchanged chat
     * costs no history RPC; the entry is dropped as soon as the card leaves the
     * watched columns. See {@link watchReworkChats}.
     */
    private readonly reworkScans;
    /**
     * Card id → the conversation waiting for the human's answer. Derived from the
     * conversations on every poll and never written to the ledger: the question is
     * the chat's, the board only points at it. A card that is answered drops out
     * again, so the symbol appears with the question and leaves with the answer.
     */
    private awaitingAnswer;
    /**
     * Per conversation, the verdict of the last question read plus the roster row
     * it was read from. A chat only changes when an event lands, so an unchanged
     * row costs no history RPC. See {@link refreshAwaitingAnswers}.
     */
    private readonly answerWatches;
    private lastPowerJson;
    /**
     * Card environments the board brought up (card id → project), plus the
     * directory each project lives in. The ledger holds the same record on the
     * card; this map is what lets the Host tear a project down after the card is
     * gone (deleted, archived, or dropped from the ledger entirely).
     */
    private readonly composeProjects;
    private composeBusy;
    /**
     * Review environments the board started (card id → its record), plus the
     * action currently in flight per card. The map is what survives a card's
     * deletion — the record is gone, the environment it started is not — and it is
     * the only marker of "the board started this one", which is exactly what the
     * automatic cleanup is allowed to stop. The in-flight marker is deliberately
     * in memory: a Host restart must not leave a card claiming a start it never
     * finished, and the buttons are then simply enabled again.
     */
    private readonly reviewEnvs;
    private readonly reviewBusy;
    /**
     * Archived cards whose worktree removal failed once. The removal is retried
     * every poll; this set only keeps the warning from repeating alongside it
     * (the card stays in it until the directory is gone).
     */
    private readonly worktreeWarnings;
    /** Per-card review action chain: a second review click waits for the first. */
    private readonly reviewWork;
    /** Derived plan per review-column card (see {@link refreshReviewPlans}). */
    private reviewPlans;
    private readonly now;
    constructor(gateway: TypertGateway, options?: {
        ledger?: HostTaskLedger;
        power?: PowerInhibitor;
        now?: () => number;
        commandDispatcher?: SessionCommandDispatcher;
        workspaceRegistry?: TaskBoardWorkspaceRegistry;
        sessionDefaultPermission?: TaskPermission;
        git?: GitWorkflow;
        /** Docker Compose environments per card; omit for the default workflow. */
        compose?: TaskComposeController;
        /** Compose file inside the card's worktree (settings `composeFile`). */
        composeFile?: string;
        /** Review environments of the cards; omit for the default workflow. */
        review?: ReviewWorkflow;
        /** Machine config applied to a freshly built ledger (settings `stateMachine`). */
        stateMachine?: unknown;
        /** Operator Peer the gateway calls speak for; dsh 0.2.1 requires one. */
        peer?: GatewayPeer;
    });
    start(): void;
    setConfiguration(active: boolean, preventIdleSleep: boolean): void;
    /**
     * Apply the board's WIP limit (settings namespace `task-board`,
     * `maxConcurrentRuns`) per workspace/lane. Lowering the limit never aborts a
     * running task: the surplus slots drain as their executions settle while the
     * queue holds the remaining launches back.
     * @param limit - configured maximum per lane; values below 1 or non-finite mean 1.
     */
    setMaxConcurrentRuns(limit: number): void;
    /**
     * Apply the board's Done-column limit (settings namespace `task-board`,
     * `maxDoneTasks`). The ledger trims an over-limit `done` column right away
     * and keeps enforcing it on every later move into `done` (oldest cards first,
     * FIFO).
     * @param limit - configured maximum; values below 1 or non-finite keep the default.
     */
    /**
     * Point the compose integration at another file (settings `composeFile`); an
     * empty value disables task environments. Projects already running keep their
     * file — the setting decides what new runs bring up.
     */
    setComposeFile(file: string): void;
    /**
     * Point the compose integration at another environment template (settings
     * `composeEnv`): `KEY=VALUE` pairs, `{port}` for a free per-card host port and
     * `{task}` for the card id.
     */
    setComposeEnv(env: string): void;
    /**
     * Apply the review setups (settings `reviewEnvironments`): one entry per
     * workspace directory, with the start/stop/restart/logs commands, the optional
     * URL template, docker context and environment. An invalid document is
     * reported as a whole — the entries that parse stay in force, so one typo does
     * not silently disable every other workspace — and the derived plans are
     * re-published, because a workspace that just gained a start command must show
     * its buttons without a ledger change.
     * @param value - raw setting (JSON text or the parsed array).
     * @returns the reasons of every entry that was refused (empty when all parsed).
     */
    setReviewEnvironments(value: unknown): string[];
    /** Point the worktree link at another editor binary (settings `editorCommand`). */
    setEditorCommand(command: string): void;
    /**
     * Apply the `repoSubpath` setting (one entry per workspace directory, naming
     * the repository inside it) to the git workflow. Invalid entries are reported
     * as a whole — the entries that parse stay in force — and the review plans are
     * re-published, because a workspace that just gained a repository must show its
     * worktree link without a ledger change.
     * @param value - raw setting (JSON text or the parsed array).
     * @returns the reasons of every entry that was refused (empty when all parsed).
     */
    setRepoSubpaths(value: unknown): string[];
    /**
     * Recompute the derived review plans: what the review column offers each card
     * (directory, worktree or main-checkout fallback, editor target, whether there
     * is anything to start) plus the action currently in flight. Called on every
     * ledger change and on every settings change, and never persisted — the plan
     * is a projection of the filesystem and the settings, not of the ledger.
     */
    private refreshReviewPlans;
    /**
     * Seed the review bookkeeping from the ledger: a record with a `startedAt`
     * stamp is a version the board started, so a Host restart re-attaches it
     * (the very thing the automatic cleanup has to be able to stop later) instead
     * of forgetting an environment the human can still see on the card.
     */
    private seedReviewEnvironments;
    setMaxDoneTasks(limit: number): void;
    /**
     * Apply the board's state machine (settings namespace `task-board`, field
     * `stateMachine`). The ledger enforces the very machine the browser renders
     * drop targets from; an invalid config keeps the machine in force.
     * @param config - raw config; undefined keeps the shipped machine.
     * @returns the refusals of an invalid config (empty when it was applied).
     */
    setStateMachine(config: unknown): string[];
    snapshot(): TaskBoardSnapshot;
    /**
     * Build the wire snapshot from an already-read ledger state, so a caller that
     * has one (the action path) never pays for a second whole-ledger clone.
     */
    private snapshotWith;
    /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
    eventPayload(): TaskBoardEventPayload;
    subscribe(listener: () => void): () => void;
    apply(requestId: string, action: TaskBoardAction, initiator?: string): Promise<TaskBoardSnapshot>;
    /**
     * Queue one review action on the card's review chain: a second click on the
     * same card waits for the first action instead of being refused. The card's
     * derived plan shows `pending` while anything is queued, and the buttons stay
     * usable (`reviewBusy` is only the UI's in-flight explanation, never a fence).
     */
    private scheduleReview;
    /**
     * Carry out one review action and write its outcome back to the card. The
     * record is always written — a failure keeps the environment's identity and
     * the reason, so the card can explain itself instead of silently doing
     * nothing. `restart` is a stop (when something runs) followed by a start;
     * `stop` on a card that never started is a no-op the Host still reports as
     * stopped.
     */
    private runReviewIntent;
    /**
     * Drop the run environment's record when it names the very project the review
     * just took down: the stack is gone, and the card must not keep showing "up
     * since …" for it.
     */
    private forgetComposeRecord;
    /**
     * Read-only review work the browser asks for (open the worktree, read logs,
     * diff the reviewed commit). Every one of them is scoped to the named card —
     * its own directory, its own project — and every one answers with text or a
     * reason, so the panel never renders a raw exception.
     */
    reviewOperation(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse>;
    dispose(): void;
    private launch;
    /**
     * Stop one paused run's session. The ledger pause is already written, so the
     * monitor has let the run go; the only job here is to end the agent's turn.
     * A session without a live agent (the run already finished, or the Host
     * restarted) is not an error worth freezing the card for: the pause is undone
     * and the normal monitor settles the run on its own.
     */
    private stopPausedRun;
    /**
     * Continue a resumed run: write the "continue" turn into the run's own
     * conversation. A run that never got a session (it was still queued for a WIP
     * slot) goes back through the normal launch queue instead — there is no
     * conversation to continue, so it starts like any other run.
     */
    private resumePausedRun;
    /** Re-attach the projects recorded in the ledger (they outlive a Host restart). */
    private seedComposeProjects;
    /**
     * Bring the card's Docker Compose environment up before its run starts, and
     * record project, ports and failures on the card. A card whose worktree holds
     * no compose file has no environment: that is the normal case, not an error.
     * The failure of a *configured* environment is not swallowed — the run fails,
     * because implementing against an environment that did not come up is worse
     * than not starting.
     */
    private ensureCompose;
    /**
     * Tear down every card environment that is no longer wanted: the stack lives
     * while the card runs or waits for the review, and stops as soon as it leaves
     * those columns, is archived, or disappears from the ledger (deleted). The map
     * is what covers the deleted card — its record is gone, the project name is
     * not. Nothing here blocks a ledger write: compose runs in the background.
     */
    private reconcileCompose;
    /**
     * Tear down the review environments whose card left the review column, was
     * archived or disappeared from the ledger — but only what the board itself
     * started: a version the human brought up by hand is not the board's to kill,
     * which is why the record's `startedAt` (and this map) is the marker. The card
     * keeps its record, marked stopped, so a re-parked card starts its next review
     * on the very port the human already knows.
     *
     * A stop that fails stays visible on the card instead of being retried every
     * five seconds: the environment may still be running, and hammering a broken
     * stop command would not help.
     */
    private reconcileReview;
    /**
     * Retry releasing the worktree of an archived card. Archiving releases it
     * right away; this covers the git that refused then (a locked worktree, an
     * open file) and cards archived before archiving owned that job. A failure is
     * logged once per card and retried silently on every poll until the directory
     * is gone — a locked worktree is never unlocked behind the human's back.
     */
    private reconcileArchivedWorktrees;
    private pollSessions;
    /**
     * Recompute which cards wait for the human's answer and publish the change.
     *
     * The read is gated on the conversation's `updatedAt` (and the roster's
     * running flag): an unchanged chat cannot have produced or answered a
     * question, so a card that simply keeps waiting costs no history RPC on the
     * 5 s poll. The verdict is what the *conversation* says — the symbol is not a
     * ledger state and must not survive the answer.
     *
     * Failure policy: a history read that fails keeps the last verdict and retries
     * on the next poll (a question the human owes an answer to is never dropped
     * because the Host had one bad read), while a session missing from the roster
     * is no evidence at all and contributes nothing.
     * @param sessions - the roster the poll already fetched.
     */
    private refreshAwaitingAnswers;
    /**
     * Send settled cards back for rework when their human wrote in the card's own
     * conversation. The correction is never copied into a board field: the human
     * typed it into the chat the run lives in, so the card only moves and gets
     * its {@link TaskRecord.reworkAt} stamp. The move is an ordinary ledger move,
     * so the state machine still decides whether the column pair exists at all.
     *
     * Reading is gated twice on purpose: a conversation whose `updatedAt` did not
     * change since the last poll costs no history RPC, and an unreadable history
     * (`known: false`) is never treated as "no human turn" — it is simply retried
     * on the next poll.
     * @param sessions - the roster the poll already fetched.
     */
    private watchReworkChats;
    /** Reuse the session list this poll already fetched: one list RPC per tick, not 1 + E. */
    /**
     * Settle every open execution whose session has finished. This is the only
     * automatic path into `ready_for_test`: the runner reports 'succeeded' only
     * once the session has come to rest (no running turn, nothing queued, no
     * live job), so the column change is always the session's last action — an
     * agent's own `FERTIG:` report never moves the card while its session runs.
     * Drag & drop cannot race it — the ledger refuses to move a card that is
     * running or still carries an open execution.
     */
    private reconcileExecutions;
    private tickSchedule;
    private armedSchedules;
    private scheduleLaunch;
    /**
     * Start queued runs while their lane (workspace) holds fewer than
     * `maxConcurrentRuns` sessions. Lanes are independent: a saturated lane never
     * blocks another lane's queue entry, which is scanned in arrival order so
     * runs within one lane still start FIFO. A run above its lane's limit stays
     * queued: its ledger execution is already open without a session, so the card
     * reads as waiting and cannot be opened twice. A clarification run is never
     * held back — the clarification column has no WIP limit. Called on enqueue, on every ledger
     * change (a settle frees a slot), after a launch attaches a session or fails,
     * and when the limit changes.
     */
    private pumpLaunchQueue;
    private schedulePoll;
    private scheduleTick;
    private syncPowerReasons;
    private emit;
}
/**
 * Install stream error listeners on process.stderr and process.stdout so that
 * transient write failures (e.g. ENOSPC when the disk is full, or EPIPE on a
 * closed pipe) never emit unhandled 'error' events that kill the Node.js host process.
 */
export declare function installStreamErrorGuards(): void;
/**
 * Defensively log to console.error without letting stderr write failures
 * (e.g. ENOSPC from SyncWriteStream on redirected logs) crash the host process.
 */
export declare function safeConsoleError(message: string, ...args: unknown[]): void;
