import type { TaskRecord } from '../core/tasks.ts';
import { type TaskBoardAction, type TaskBoardEventFrame, type TaskBoardParseDraft, type TaskBoardParseRequest, type TaskBoardReviewRequest, type TaskBoardReviewResponse, type TaskBoardSnapshot } from '../protocol.ts';
/**
 * How long one action POST may stay unanswered before the outbox treats it as a
 * stalled request (a queued browser connection, a frozen Host) and retries it
 * with the same requestId. Not a user-visible deadline: the action stays in the
 * outbox, the banner explains it, and the first successful answer wins.
 */
export declare const ACTION_REQUEST_TIMEOUT_MS = 20000;
/**
 * Failure classes of the Host API, in the language the panel renders
 * (issue #1528). The Host is the only part that knows whether a task-board
 * route exists at all, so a raw fetch/parse error must never reach the user:
 * "Unexpected token 'o', \"not found\" is not valid JSON" is what a missing
 * Host half looks like today.
 */
export type HostApiFailure = 'not-mounted' | 'unauthorized' | 'locked' | 'rejected' | 'busy' | 'timeout' | 'unreachable' | 'unexpected';
/** Transport failure carrying a stable class next to its user-facing message. */
export declare class HostApiError extends Error {
    readonly failure: HostApiFailure;
    readonly status?: number | undefined;
    constructor(failure: HostApiFailure, message: string, status?: number | undefined);
}
export interface TaskBoardHostTransport {
    bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>;
    state(): Promise<TaskBoardSnapshot>;
    /**
     * Submit one action. The Host answers `202 accepted` immediately; the outcome
     * arrives as an `action-result` event (the controller resolves its outbox from
     * it). The requestId is the idempotency key: a resend after a connection loss
     * gets the same outcome instead of applying the action twice.
     */
    action(action: TaskBoardAction, initiator?: string, requestId?: string): Promise<{
        requestId: string;
    }>;
    subscribe(listener: (frame?: TaskBoardEventFrame) => void): () => void;
    /** One-shot model parse of pasted text (issue #1540). */
    parseDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>;
    /** One review read: open the worktree, snapshot logs, diff the reviewed commit. */
    reviewOp(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse>;
}
export declare class HttpTaskBoardHostTransport implements TaskBoardHostTransport {
    private readonly storage;
    constructor(storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined);
    bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>;
    state(): Promise<TaskBoardSnapshot>;
    action(action: TaskBoardAction, initiator?: string, requestId?: string): Promise<{
        requestId: string;
    }>;
    private post;
    /**
     * One Host read. There is deliberately **no timeout**: a slow Host is not a
     * user-visible failure. The action outbox in the controller retries a broken
     * connection with the same requestId, and the board stays usable throughout.
     */
    private request;
    /**
     * Ask the Host to turn pasted text into task fields. The route answers a
     * typed failure (no model, timeout, unparseable reply) already phrased for
     * the form, so the UI never renders a raw status code (issue #1540).
     */
    parseDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>;
    /**
     * One review read. The Host answers every one of them with `{ ok, text?,
     * error? }` — including its own refusals — so a failed read stays a sentence
     * in the panel instead of a transport error. Only a Host that never mounted
     * the route (404) and an authentication refusal are reported as such, because
     * those are not about the card.
     */
    reviewOp(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse>;
    subscribe(listener: (frame?: TaskBoardEventFrame) => void): () => void;
    /** One event stream; separated so a hidden tab can drop and reopen it. */
    private openStream;
}
