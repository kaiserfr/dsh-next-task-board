import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import type { CommandResult } from '@deepseek-ai/dsh-commands/types';
import type { Workspace } from '@deepseek-ai/dsh-workspace/types';
import type { TaskRecord } from './core/tasks.ts';
/** Host services needed to validate a task's workspace before creating a session. */
export interface TaskBoardWorkspaceRegistry {
    list(): readonly Workspace[];
}
interface GatewayRequest {
    namespace: string;
    method: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
}
interface SessionGateway {
    invoke(request: GatewayRequest): Promise<unknown>;
    stream?(request: GatewayRequest): Promise<AsyncIterable<unknown>>;
}
/** One session-list row consumed by task-board reconciliation. */
export type { SessionSummary };
type ExecutionSessionId = SessionSummary['sessionId'];
export interface SessionCommandDispatcher {
    execute(sessionId: ExecutionSessionId, line: string, signal: AbortSignal): Promise<CommandResult | undefined>;
}
export type ExecutionInspection = {
    outcome: 'pending';
} | {
    outcome: 'succeeded';
} | {
    outcome: 'failed';
    error: string;
} | {
    outcome: 'cancelled';
    error: string;
};
/** A post-create launch failure that still identifies the session to the ledger. */
export declare class SessionLaunchError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string, cause: unknown);
}
/**
 * How one run's prompt is composed beyond the card body itself.
 */
export interface PromptTextOptions {
    /**
     * The run continues the previous execution's conversation. Set exactly when
     * the launch reuses a session: the note then replaces the card body, because
     * the conversation already holds the original instruction and everything the
     * agent did after it.
     */
    continued?: boolean;
    /** Correction note this run was started with (a rework round's remark). */
    reworkNote?: string;
}
/**
 * Compose the execution prompt (issue #6): a continuation card (one carrying
 * a frozen snapshot) has its instruction mandatorily wrapped in a source
 * declaration (freeze instant, source session, unreviewed-content warning)
 * templated by the board, so the picking-up agent stays wary of stored
 * prompt-instruction injection in card text (adversarial scenario c). The
 * wrap composes with the T4 handover preamble: the reference preamble comes
 * first, the provenance wrap then encloses the instruction. Plain tasks (no
 * freeze) keep the bare handover preamble + prompt.
 *
 * A rework round is composed differently on purpose (see
 * {@link PromptTextOptions.continued}): the correction note is the new user
 * turn, and it never rewrites the card's `prompt`, which stays the record of
 * what was originally asked.
 * @param task - the card being run.
 * @param options - continuation flag plus the round's correction note.
 */
export declare function promptText(task: TaskRecord, options?: PromptTextOptions): string;
export declare class HostExecutionRunner {
    private readonly gateway;
    private readonly commands?;
    private readonly workspaceRegistry?;
    /** Newest scanned event sequence per session with no matching execution end. */
    private readonly scanMemos;
    private readonly unavailableAttempts;
    private readonly unavailableBackoffMs;
    private unsupportedSessionListWarned;
    /** Warn once when the runtime predates the live session control endpoint. */
    private unsupportedSessionControlWarned;
    constructor(gateway: SessionGateway | TypertGateway, commands?: SessionCommandDispatcher | undefined, workspaceRegistry?: TaskBoardWorkspaceRegistry | undefined, unavailableRetry?: {
        attempts?: number;
        backoffMs?: number;
    });
    private invoke;
    private stream;
    /**
     * Launch one execution. Without `options.reuseSessionId` a fresh session is
     * created, renamed, pinned, and prompted (the historical contract). With it,
     * the run continues in that existing session (issue #1419): the conversation
     * keeps its title and history, the pinned permission/model are re-asserted so
     * the task's execution contract still holds, and the prompt is queued.
     * @param task - the task to run.
     * @param options - optional session to continue in, plus the correction note
     *   this run was started with (`reworkNote`, copied off the card by the
     *   ledger when the run opened).
     * @returns the session id the execution runs in.
     */
    launch(task: TaskRecord, options?: {
        reuseSessionId?: string;
        reworkNote?: string;
    }): Promise<string>;
    /**
     * Re-assert the pinned execution contract on a session and queue the run's
     * prompt. Shared by the fresh-session and reuse paths so both apply exactly
     * the same permission/model pins before the prompt.
     */
    private pinAndPrompt;
    listRunning(): Promise<{
        known: true;
        count: number;
        items: SessionSummary[];
    } | {
        known: false;
    }>;
    /** Resolve an execution outcome from the session list and bounded history pages. */
    inspect(sessionId: string, startedAt?: number, sessions?: readonly SessionSummary[]): Promise<ExecutionInspection>;
    /**
     * Whether the session has stopped working on this execution: its prompt
     * inbox holds nothing pending, no background job of it is in flight (a
     * finished job wakes the session for another turn under the default
     * `wakeup` delivery), and it is not running right now.
     *
     * The two reads happen in this order on purpose: the live inbox/job
     * baseline answers "is there work left at all", and the roster read that
     * follows is the freshest observation, so a turn that started while the
     * baseline was being fetched still keeps the outcome pending.
     *
     * Both reads fail closed: an unreadable state is not evidence of a finished
     * session, so the outcome stays pending and the next poll retries.
     * @param sessionId - the execution's session.
     * @returns true only on confirmed silence.
     */
    private sessionEnded;
    /**
     * Read the Host-wide live control baseline and report whether this session
     * still owns pending work. Every other outcome is deliberately not "none":
     * a frame that is not the baseline or a failed stream leaves the state
     * unknown, which keeps the execution pending.
     * @param sessionId - the execution's session.
     * @returns 'some' when the session has queued prompts or a live job,
     * 'none' when it has neither, 'unsupported' when the runtime has no such
     * endpoint, 'unknown' when the read failed.
     */
    private pendingWork;
    /**
     * Re-read the roster and confirm the session is listed as not running right
     * now. The poll's earlier list predates the history scan, so a turn that
     * started in between would otherwise be invisible.
     * @param sessionId - the execution's session.
     * @returns true only when a fresh roster row reports it idle.
     */
    private sessionIdleNow;
}
