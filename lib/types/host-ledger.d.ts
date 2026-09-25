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
export interface OpenedRun {
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
    /** Count armed, non-archived schedules without cloning task histories. */
    armedScheduleCount(): number;
    /** Return value-only references for schedules due at the supplied Host time. */
    dueSchedules(now: number): DueScheduleReference[];
    subscribe(listener: () => void): () => void;
    /**
     * Ensure the card has a feature branch before it starts. The backlog → todo
     * pull normally opens it; a cron trigger, a drag straight to "In progress",
     * or the detail Run button may bypass that, and those runs must not land on
     * the base branch. No-op without a repository or when a branch already exists.
     */
    private withFeatureBranch;
    /**
     * The card's `git` after a transition's git hooks ran, in configured order.
     * `"git": false` on the transition skips them entirely; without a repository
     * the hooks are no-ops. Shared by the single-card and the batch move so a
     * group drop fires exactly the hooks a single drop of the same card would.
     */
    private transitionGit;
    dispose(): void;
    applyRequest(requestId: string, action: TaskBoardAction, initiator?: string): {
        state: LedgerState;
        run?: OpenedRun;
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
