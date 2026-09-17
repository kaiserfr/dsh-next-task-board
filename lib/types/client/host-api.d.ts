import type { TaskRecord } from '../core/tasks.ts';
import { type TaskBoardAction, type TaskBoardEventPayload, type TaskBoardParseDraft, type TaskBoardParseRequest, type TaskBoardSnapshot } from '../protocol.ts';
/**
 * Failure classes of the Host API, in the language the panel renders
 * (issue #1528). The Host is the only part that knows whether a task-board
 * route exists at all, so a raw fetch/parse error must never reach the user:
 * "Unexpected token 'o', \"not found\" is not valid JSON" is what a missing
 * Host half looks like today.
 */
export type HostApiFailure = 'not-mounted' | 'unauthorized' | 'locked' | 'rejected' | 'timeout' | 'unreachable' | 'unexpected';
/** Transport failure carrying a stable class next to its user-facing message. */
export declare class HostApiError extends Error {
    readonly failure: HostApiFailure;
    readonly status?: number | undefined;
    constructor(failure: HostApiFailure, message: string, status?: number | undefined);
}
export interface TaskBoardHostTransport {
    bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>;
    state(): Promise<TaskBoardSnapshot>;
    action(action: TaskBoardAction, initiator?: string): Promise<TaskBoardSnapshot>;
    subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void;
    /** One-shot model parse of pasted text (issue #1540). */
    parseDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>;
}
export declare class HttpTaskBoardHostTransport implements TaskBoardHostTransport {
    private readonly storage;
    constructor(storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined);
    bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>;
    state(): Promise<TaskBoardSnapshot>;
    action(action: TaskBoardAction, initiator?: string): Promise<TaskBoardSnapshot>;
    private post;
    private request;
    /**
     * Ask the Host to turn pasted text into task fields. The route answers a
     * typed failure (no model, timeout, unparseable reply) already phrased for
     * the form, so the UI never renders a raw status code (issue #1540).
     */
    parseDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>;
    subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void;
}
