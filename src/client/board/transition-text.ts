/**
 * Wording for the transition buttons, their disabled reasons and the queued /
 * failed badges. Kept in one module so the detail popup, the card badge and the
 * board's drop notice explain the same state with the same sentence.
 */
import type { TaskStatus } from '../../core/state-machine.ts'
import type { QueuedTransition, TransitionBlocker, TransitionError } from '../../core/transitions.ts'
import { dictionary, t, type TaskBoardKey } from '../locales.ts'
import { STATUS_KEY } from './status-key.ts'

/** Label of a manual-move chip. A custom machine may name a target the shipped
 * dictionary has no wording for; the column's own label is then better than a
 * missing-key artifact. */
export function moveLabel(status: TaskStatus): string {
  const key = `status.move.${status}` as TaskBoardKey
  return key in dictionary() ? t(key) : t(STATUS_KEY[status])
}

/** Short column label, as used on the board and in queue badges. */
export function statusLabel(status: TaskStatus): string {
  return t(STATUS_KEY[status])
}

/** Why a transition button is disabled right now. */
export function blockerText(blocker: TransitionBlocker): string {
  const key = `detail.transition.blocked.${blocker}` as TaskBoardKey
  return key in dictionary() ? t(key) : t('detail.transition.blocked.invalid')
}

/** The last transition failure (queued intent discarded, Host rejection). */
export function transitionErrorText(error: TransitionError): string {
  if (error.code === 'source-changed') {
    return t('detail.transition.blocked.sourceChanged', {
      from: error.from === undefined ? '—' : statusLabel(error.from),
      to: error.to === undefined ? '—' : statusLabel(error.to),
    })
  }
  if (error.code === 'rejected') {
    return error.message !== undefined && error.message !== ''
      ? t('detail.transition.blocked.rejectedWith', { error: error.message })
      : t('detail.transition.blocked.rejected')
  }
  return blockerText(error.code)
}

/** Sentence for a waiting transition, naming the target column. */
export function queuedTransitionText(entry: QueuedTransition): string {
  return t('detail.transition.waiting', { status: statusLabel(entry.to) })
}
