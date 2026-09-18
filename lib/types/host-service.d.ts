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
     */
    private idleSessionIds;
    private preventIdleSleep;
    /** Runs waiting for a free WIP slot, in arrival order. */
    private launchQueue;
    /** Launches already started whose session is not attached yet (invisible to the ledger). */
    private launchesInFlight;
    /** WIP limit: how many runs may hold a session at once (always >= 1). */
    private maxConcurrentRuns;
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
    });
    start(): void;
    setConfiguration(active: boolean, preventIdleSleep: boolean): void;
    /**
     * Apply the board's WIP limit (settings namespace `task-board`,
     * `maxConcurrentRuns`). Lowering the limit never aborts a running task: the
     * surplus slots drain as their executions settle while the queue holds the
     * remaining launches back.
     * @param limit - configured maximum; values below 1 or non-finite mean 1.
     */
    setMaxConcurrentRuns(limit: number): void;
    snapshot(): TaskBoardSnapshot;
    /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
    eventPayload(): TaskBoardEventPayload;
    subscribe(listener: () => void): () => void;
    apply(requestId: string, action: TaskBoardAction, initiator?: string): TaskBoardSnapshot;
    dispose(): void;
    private launch;
    private pollSessions;
    /** Reuse the session list this poll already fetched: one list RPC per tick, not 1 + E. */
    private reconcileExecutions;
    private tickSchedule;
    private armedSchedules;
    private scheduleLaunch;
    /**
     * Start queued runs in arrival order while fewer than `maxConcurrentRuns`
     * executions hold a session. A run above the limit stays queued: its ledger
     * execution is already open without a session, so the card reads as running
     * and cannot be opened twice. Called on enqueue, on every ledger change (a
     * settle frees a slot), after a launch attaches a session or fails, and when
     * the limit changes.
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
