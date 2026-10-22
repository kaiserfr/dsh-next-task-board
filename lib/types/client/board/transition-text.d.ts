/**
 * Wording for the transition buttons, their disabled reasons and the queued /
 * failed badges. Kept in one module so the detail popup, the card badge and the
 * board's drop notice explain the same state with the same sentence.
 */
import type { TaskStatus } from '../../core/state-machine.ts';
import type { QueuedTransition, TransitionBlocker, TransitionError } from '../../core/transitions.ts';
/** Label of a manual-move chip. A custom machine may name a target the shipped
 * dictionary has no wording for; the column's own label is then better than a
 * missing-key artifact. */
export declare function moveLabel(status: TaskStatus): string;
/** Short column label, as used on the board and in queue badges. */
export declare function statusLabel(status: TaskStatus): string;
/** Why a transition button is disabled right now. */
export declare function blockerText(blocker: TransitionBlocker): string;
/** The last transition failure (queued intent discarded, Host rejection). */
export declare function transitionErrorText(error: TransitionError): string;
/** Sentence for a waiting transition, naming the target column. */
export declare function queuedTransitionText(entry: QueuedTransition): string;
