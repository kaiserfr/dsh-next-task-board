import type { TaskUpdatePatch } from './core/use-cases/task-update.ts';
import { type NewTaskInput, type TaskPermission, type TaskRecord, type TaskStatus } from './core/tasks.ts';
export declare const TASK_BOARD_SCHEMA_VERSION: 3;
/** Ledger documents written before v3; loaded once and migrated on startup. */
export declare const TASK_BOARD_LEGACY_SCHEMA_VERSION: 2;
export declare const TASK_BOARD_API_PREFIX = "/api/task-board";
export type PowerPhase = 'disabled' | 'idle' | 'acquiring' | 'active' | 'error' | 'unsupported';
export interface TaskBoardPowerSnapshot {
    platform: string;
    phase: PowerPhase;
    enabled: boolean;
    runningSessions: number;
    armedSchedules: number;
    sessionStateKnown: boolean;
    lastError?: string;
}
export interface TaskBoardSchedulerSnapshot {
    timeZone: string;
    /** Opaque identity of the current Host ledger generation. */
    ledgerId?: string;
    lastTickAt?: number;
    error?: string;
}
export interface TaskBoardSnapshot {
    schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION;
    revision: number;
    tasks: TaskRecord[];
    scheduler: TaskBoardSchedulerSnapshot;
    power: TaskBoardPowerSnapshot;
    /** Session-default permission the confirmation gate compares against. */
    sessionDefaultPermission?: TaskPermission;
}
/** SSE event frame: revision/scheduler/power only, never the task list. */
export interface TaskBoardEventPayload {
    revision: number;
    scheduler: TaskBoardSchedulerSnapshot;
    power: TaskBoardPowerSnapshot;
}
/**
 * Request body of `POST {TASK_BOARD_API_PREFIX}/parse` (issue #1540): the text
 * the user pasted plus the `provider/model` route that should parse it.
 */
export interface TaskBoardParseRequest {
    text: string;
    /** Qualified route from the model picker; absent when no route was chosen. */
    model?: string;
}
/** Draft fields a parse returns; the user reviews them before creating the task. */
export interface TaskBoardParseDraft {
    title: string;
    description: string;
    prompt: string;
}
/** Strict parse of a `/parse` request body; undefined rejects the request. */
export declare function parseTaskParseRequest(value: unknown): TaskBoardParseRequest | undefined;
/** Whether a decoded reply carries the three draft strings the form accepts. */
export declare function isTaskParseDraft(value: unknown): value is TaskBoardParseDraft;
export type TaskBoardAction = {
    kind: 'import';
    sourceId: string;
    tasks: TaskRecord[];
} | {
    kind: 'create';
    id: string;
    input: NewTaskInput;
} | {
    kind: 'update';
    taskId: string;
    patch: TaskUpdatePatch;
} | {
    kind: 'delete';
    taskId: string;
} | {
    kind: 'move';
    taskId: string;
    status: TaskStatus;
} | {
    kind: 'archive';
    taskId: string;
} | {
    kind: 'restore';
    taskId: string;
} | {
    kind: 'set-schedule';
    taskId: string;
    patch: {
        enabled?: boolean;
        cron?: string;
    };
} | {
    kind: 'run';
    taskId: string;
} | {
    kind: 'rerun';
    taskId: string;
} | {
    kind: 'confirm-permission';
    taskId: string;
};
export interface TaskBoardActionEnvelope {
    requestId: string;
    action: TaskBoardAction;
    /**
     * Session id of the DSH session issuing the action, for the execution audit
     * trail (issue #6). Client-asserted, not a trust boundary; parsed only as a
     * bounded non-empty string and recorded on opened executions / freeze stamps.
     */
    initiator?: string;
}
export declare function parseActionEnvelope(value: unknown): TaskBoardActionEnvelope | undefined;
