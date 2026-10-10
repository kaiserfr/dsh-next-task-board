import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway';
import { HostTaskLedger } from './host-ledger.ts';
import { HostExecutionRunner, type SessionCommandDispatcher, type TaskBoardWorkspaceRegistry } from './host-runner.ts';
import { GitWorkflow } from './git-workflow.ts';
import { PowerInhibitor } from './power-inhibitor.ts';
import { type TaskBoardAction, type TaskBoardEventPayload, type TaskBoardSnapshot } from './protocol.ts';
import type { TaskPermission } from './core/handover.ts';
export declare class TaskBoardHostService {
    readonly ledger: HostTaskLedger;
    readonly runner: HostExecutionRunner;
    readonly power: PowerInhibitor;
    /** Shared git integration: branch hooks in the ledger, checkout before a run. */
    readonly git: GitWorkflow;
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
     * session at once (always >= 1). Clarification runs (`todo`) are exempt.
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
    private readonly now;
    constructor(gateway: TypertGateway, options?: {
        ledger?: HostTaskLedger;
        power?: PowerInhibitor;
        now?: () => number;
        commandDispatcher?: SessionCommandDispatcher;
        workspaceRegistry?: TaskBoardWorkspaceRegistry;
        sessionDefaultPermission?: TaskPermission;
        git?: GitWorkflow;
        /** Machine config applied to a freshly built ledger (settings `stateMachine`). */
        stateMachine?: unknown;
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
    /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
    eventPayload(): TaskBoardEventPayload;
    subscribe(listener: () => void): () => void;
    apply(requestId: string, action: TaskBoardAction, initiator?: string): TaskBoardSnapshot;
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
     * held back — `todo` has no WIP limit. Called on enqueue, on every ledger
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
