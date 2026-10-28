/**
 * Transition readiness: why a manual status move from the card's current
 * column is blocked right now, and the plain-data shapes the controller keeps
 * for its in-memory transition queue.
 *
 * Framework-free (and free of Host/runtime imports) so the Host-backed
 * controller, the browser's disabled-button reasons and the tests share one
 * judgement. The Host stays the authority: this only explains/pre-checks what
 * the state machine and the card record already say, and a Host rejection is
 * still respected.
 */
import { type TaskPermission } from './handover.ts';
import type { StateMachine } from './state-machine.ts';
import { type TaskRecord, type TaskStatus } from './tasks.ts';
/**
 * Why a card cannot take a manual transition right now:
 *
 * - `archived`  — archived cards are read-only
 * - `running`   — the runner owns the card while an implementation run is open
 * - `paused`    — the open run is paused; it has to be resumed first
 * - `permission`— the transition starts a run whose permission binding is not
 *                 confirmed yet
 * - `invalid`   — the machine has no such manual transition from this column
 */
export type TransitionBlocker = 'archived' | 'running' | 'paused' | 'permission' | 'invalid';
/** A queued intent that did not go through (or was dropped later). */
export type TransitionErrorCode = TransitionBlocker | 'source-changed' | 'rejected';
/**
 * One queued transition: the card's source column at click time and the target
 * column. `from` is part of the intent — when the card left that column before
 * the queue could run it, the intent is stale and is discarded with a reason
 * (the side effects of a transition belong to its source, e.g. Done-from-review
 * merges while Done-from-clarification does not).
 */
export interface QueuedTransition {
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    requestedAt: number;
}
/** The last transition failure shown on a card/detail, until the next action. */
export interface TransitionError {
    code: TransitionErrorCode;
    /** Host-provided reason for `rejected`; absent for the local blocker codes. */
    message?: string;
    from?: TaskStatus;
    to?: TaskStatus;
    at: number;
}
/**
 * The blocker that currently prevents `to`, or undefined when the transition is
 * ready. `to === task.status` is not a transition: callers handle "already
 * there" as a successful no-op before asking.
 */
export declare function transitionBlockerOf(task: TaskRecord, machine: StateMachine, to: TaskStatus, sessionDefaultPermission?: TaskPermission): TransitionBlocker | undefined;
/** Whether firing this transition starts an execution (clarify or run). */
export declare function transitionStartsExecution(machine: StateMachine, from: TaskStatus, to: TaskStatus): boolean;
/** Direction of a card's one-column step on the board. */
export type ColumnStep = 'left' | 'right';
/**
 * Why a card cannot step one column in a direction: `edge` when the board has
 * no column there, otherwise the ordinary blocker of the neighbor transition.
 */
export type StepBlocker = TransitionBlocker | 'edge';
/** One resolved column step: the neighbor and why the step is unavailable. */
export interface ColumnStepInfo {
    /** The neighboring column in board order; undefined at the board's edge. */
    target?: TaskStatus;
    /** Why the arrow must be disabled; absent when the step is ready. */
    blocker?: StepBlocker;
}
/**
 * Resolve the card's step to the directly adjacent configured column — never a
 * longer jump: a neighbor the machine accepts no manual transition to is a
 * disabled arrow, not a skip to the next allowed column. Readiness uses the
 * same judgement as a drag/detail transition ({@link transitionBlockerOf}), so
 * a running/paused card, an unconfirmed elevated permission, an archived card
 * and a missing transition all disable the arrow identically.
 * @param task - the card in its current state.
 * @param machine - the machine the Host enforces.
 * @param direction - one column left or right in board order.
 * @param sessionDefaultPermission - the session's default permission for the
 *   run-start confirmation gate.
 */
export declare function columnStepOf(task: TaskRecord, machine: StateMachine, direction: ColumnStep, sessionDefaultPermission?: TaskPermission): ColumnStepInfo;
