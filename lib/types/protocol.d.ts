import type { TaskUpdatePatch } from './core/use-cases/task-update.ts';
import { type NewTaskInput, type TaskPermission, type TaskRecord, type TaskStatus } from './core/tasks.ts';
import type { StateMachineConfig } from './core/state-machine.ts';
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
/**
 * One derived, user-facing message the Host wants the board to show as a toast
 * (a background git failure, a refused release, a branch that could not be
 * created). Never ledger state: the Host keeps the last few for a short while
 * and the browser dedupes them by id.
 */
export interface TaskBoardNotice {
    id: string;
    taskId?: string;
    message: string;
    at: number;
}
/**
 * Card id → the started merge release the Host is carrying out in the
 * background. Derived from the service's in-memory work queue, like the review
 * plans: it is not ledger state, and a Host restart simply lets the card show
 * its review column again (the human can release again).
 */
export type TaskBoardPendingReleases = Record<string, {
    startedAt: number;
}>;
/**
 * Outcome of one accepted action, delivered over the event stream (the action
 * route itself answers `202` and never waits for the ledger). The outbox
 * resolves its entry by `requestId`; a refusal carries the human-readable
 * reason the card shows.
 */
export interface TaskBoardActionResult {
    requestId: string;
    ok: boolean;
    error?: string;
    at: number;
}
/**
 * Work the Host is carrying out for one card right now: a merge release, a
 * review environment command, or any command in the card's scope (commit,
 * worktree, merge). The card renders its "Abbrechen" control from this; it is
 * derived, in memory, and never ledger state.
 */
export interface TaskBoardPendingWork {
    kind: 'release' | 'review' | 'command';
    startedAt: number;
}
export interface TaskBoardSnapshot {
    schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION;
    revision: number;
    tasks: TaskRecord[];
    scheduler: TaskBoardSchedulerSnapshot;
    power: TaskBoardPowerSnapshot;
    /** Session-default permission the confirmation gate compares against. */
    sessionDefaultPermission?: TaskPermission;
    /**
     * The state machine the Host is enforcing: the columns the board renders and
     * the transitions (with their actions) a drag & drop is validated against.
     * Absent on a snapshot from an older Host; the browser then falls back to the
     * shipped machine.
     */
    stateMachine?: StateMachineConfig;
    /**
     * The enforced WIP limit per workspace/lane (`maxConcurrentRuns`). Only used
     * to explain a waiting card ("one run per workspace"); the Host stays the
     * authority on whether a launch starts. Absent on an older Host.
     */
    maxConcurrentRuns?: number;
    /** The enforced Done-column limit (`maxDoneTasks`). Absent on an older Host. */
    maxDoneTasks?: number;
    /**
     * Task id → the session waiting for the human's answer, for every card whose
     * conversation holds a question the agent asked and stopped on. The card shows
     * its question symbol and jumps there. Derived from the conversations on each
     * poll, so it is no ledger state; absent on an older Host.
     */
    awaitingAnswer?: Record<string, string>;
    /**
     * Task id → what the review step offers the card (see
     * {@link TaskBoardReviewPlan}). Only cards in the review column appear, and
     * the map is derived on every read (directories, compose files, settings), so
     * it is never ledger state; absent on an older Host.
     */
    reviewPlans?: Record<string, TaskBoardReviewPlan>;
    /**
     * Review-column cards whose merge release the Host is carrying out right now
     * (see {@link TaskBoardPendingReleases}). The card stays in `ready_for_test`
     * until the merge settles; this marker explains the wait and never claims a
     * column the Host has not written. Absent on an older Host.
     */
    pendingReleases?: TaskBoardPendingReleases;
    /**
     * Recent derived messages for the board's toast area (background git
     * failures, refused releases). Kept short-lived on the Host and deduped by
     * the browser; absent on an older Host.
     */
    notices?: TaskBoardNotice[];
    /** Work in flight per card (release, review, command); see {@link TaskBoardPendingWork}. */
    pendingWork?: Record<string, TaskBoardPendingWork>;
}
/** SSE event frame: revision/scheduler/power only, never the task list. */
export interface TaskBoardEventPayload {
    revision: number;
    scheduler: TaskBoardSchedulerSnapshot;
    power: TaskBoardPowerSnapshot;
    /** Enforced limits, so a settings change reaches every open board. */
    maxConcurrentRuns?: number;
    maxDoneTasks?: number;
    /**
     * Waiting questions, carried on the frame like the limits because the map is
     * derived: it never bumps the revision the frame is gated on.
     */
    awaitingAnswer?: Record<string, string>;
    /**
     * What the review step offers, carried on the frame for the same reason as
     * `awaitingAnswer`: the plan is derived from the filesystem and the settings,
     * so editing `reviewEnvironments` must reach an open board without a ledger
     * revision change.
     */
    reviewPlans?: Record<string, TaskBoardReviewPlan>;
    /** Merge releases the Host is carrying out right now, derived on every frame. */
    pendingReleases?: TaskBoardPendingReleases;
    /** Recent derived messages; see {@link TaskBoardNotice}. */
    notices?: TaskBoardNotice[];
    /**
     * Tasks that changed since the previous frame, and the ids that left the
     * board. The first frame after a connection is a full snapshot instead (see
     * {@link TaskBoardEventFrame}); everything after it is a delta, so a board with
     * hundreds of cards never resends the whole ledger on a heartbeat.
     */
    tasks?: TaskRecord[];
    removedTaskIds?: string[];
    /** Outcomes of actions accepted by the `202` action route, since the last frame. */
    actionResults?: TaskBoardActionResult[];
    /** Work in flight per card; derived, never ledger state. */
    pendingWork?: Record<string, TaskBoardPendingWork>;
}
/**
 * One frame on `GET {TASK_BOARD_API_PREFIX}/events`: a full snapshot when the
 * stream opens (the browser has no state yet, or reconnected), then deltas.
 */
export type TaskBoardEventFrame = {
    type: 'snapshot';
    snapshot: TaskBoardSnapshot;
} | {
    type: 'delta';
    payload: TaskBoardEventPayload;
};
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
    kind: 'move-many';
    taskIds: string[];
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
    kind: 'pause';
    taskIds: string[];
} | {
    kind: 'resume';
    taskIds: string[];
} | {
    kind: 'confirm-permission';
    taskId: string;
} | {
    kind: 'approve-merge';
    taskId: string;
} | {
    kind: 'review-start';
    taskId: string;
} | {
    kind: 'review-stop';
    taskId: string;
} | {
    kind: 'review-restart';
    taskId: string;
}
/**
 * Abort the card's running work: the merge release, the review command, and
 * every command the Host runs in the card's scope (commit, worktree, merge).
 * Cancellation is a Host capability, not a state transition.
 */
 | {
    kind: 'cancel-work';
    taskId: string;
}
/**
 * Stop the card's conversation for good: cancel, kill its jobs, drop the
 * queue, and force the agent to rest even if the runtime still reports it as
 * running. The open run is settled as cancelled, so the card leaves the run
 * column (unlike `cancel-work`, which may restart a failing action).
 */
 | {
    kind: 'hard-stop';
    taskId: string;
};
/**
 * What the review step offers one card, derived by the Host from the filesystem
 * and the settings on every snapshot (never ledger state). Only cards in the
 * review column receive one, so the browser can render the whole block —
 * worktree link, app links, container controls — from this plus the card's own
 * `review` record.
 */
export interface TaskBoardReviewPlan {
    /** Directory the card's version runs in: its worktree, else its main checkout. */
    dir?: string;
    /** Whether `dir` is the card's own worktree (false = the main checkout). */
    worktree?: boolean;
    /** `*.code-workspace` the editor should open instead of the directory. */
    workspaceFile?: string;
    /** Whether there is something to start (a compose file or configured commands). */
    available: boolean;
    /**
     * Whether the Host can read logs for this card (a compose file, or a
     * configured `logs` command). Without it the panel shows no logs control
     * instead of one that always fails.
     */
    logs?: boolean;
    /**
     * Action the Host is carrying out for this card right now. In-flight work is
     * deliberately not ledger state (a Host restart must not leave a card
     * claiming a start it never finished), so it rides this derived plan.
     */
    pending?: 'start' | 'stop' | 'restart';
}
/** Read-only review operations the browser asks for (never ledger writes). */
export type TaskBoardReviewRequest = {
    kind: 'open';
    taskId: string;
} | {
    kind: 'logs';
    taskId: string;
} | {
    kind: 'diff';
    taskId: string;
};
/** Answer of one review operation; `text` carries logs or a diff stat. */
export interface TaskBoardReviewResponse {
    ok: boolean;
    /** What the answer carries: the opened path, a log/diff snapshot, or an error. */
    text?: string;
    error?: string;
}
/** Strict parse of one review request body; undefined rejects the request. */
export declare function parseTaskBoardReviewRequest(value: unknown): TaskBoardReviewRequest | undefined;
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
/**
 * Upper bound on one `move-many` batch. The board's group drag submits at most
 * every on-board card at once; the cap keeps a hand-crafted request from
 * making the Host do unbounded work in a single ledger write.
 */
export declare const MAX_BATCH_MOVE = 500;
export declare function parseActionEnvelope(value: unknown): TaskBoardActionEnvelope | undefined;
