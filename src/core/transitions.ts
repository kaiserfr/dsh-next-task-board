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
import { requiresPermissionConfirmation, type TaskPermission } from './handover.ts'
import type { StateMachine } from './state-machine.ts'
import { hasOpenRun, isTaskPaused, type TaskRecord, type TaskStatus } from './tasks.ts'

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
export type TransitionBlocker = 'archived' | 'running' | 'paused' | 'permission' | 'invalid'

/** A queued intent that did not go through (or was dropped later). */
export type TransitionErrorCode = TransitionBlocker | 'source-changed' | 'rejected'

/**
 * One queued transition: the card's source column at click time and the target
 * column. `from` is part of the intent — when the card left that column before
 * the queue could run it, the intent is stale and is discarded with a reason
 * (the side effects of a transition belong to its source, e.g. Done-from-review
 * merges while Done-from-clarification does not).
 */
export interface QueuedTransition {
  taskId: string
  from: TaskStatus
  to: TaskStatus
  requestedAt: number
}

/** The last transition failure shown on a card/detail, until the next action. */
export interface TransitionError {
  code: TransitionErrorCode
  /** Host-provided reason for `rejected`; absent for the local blocker codes. */
  message?: string
  from?: TaskStatus
  to?: TaskStatus
  at: number
}

/**
 * The blocker that currently prevents `to`, or undefined when the transition is
 * ready. `to === task.status` is not a transition: callers handle "already
 * there" as a successful no-op before asking.
 */
export function transitionBlockerOf(
  task: TaskRecord,
  machine: StateMachine,
  to: TaskStatus,
  sessionDefaultPermission?: TaskPermission,
): TransitionBlocker | undefined {
  if (task.archivedAt !== undefined) return 'archived'
  if (task.status === to) return undefined
  if (task.status === 'running') return 'running'
  // A clarify run deliberately does not block moves: it owns no branch and the
  // Host lets the card move on while its round is open. Only an implementation
  // run does.
  if (hasOpenRun(task)) return isTaskPaused(task) ? 'paused' : 'running'
  const transition = machine.transition(task.status, to, 'manual')
  if (transition === undefined) return 'invalid'
  if ((transition.actions ?? []).includes('run') && requiresPermissionConfirmation(task, sessionDefaultPermission)) {
    return 'permission'
  }
  return undefined
}

/** Whether firing this transition starts an execution (clarify or run). */
export function transitionStartsExecution(machine: StateMachine, from: TaskStatus, to: TaskStatus): boolean {
  return machine.actionsFor(from, to).some(action => action === 'run' || action === 'clarify')
}
