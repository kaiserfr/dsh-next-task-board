/**
 * Session-reuse rule (issue #1419): decides which task runs continue in the
 * previous execution's conversation. Pure, so the fail-closed conditions stay
 * unit-testable without a gateway.
 */
import type { TaskRecord } from './tasks.ts';
/**
 * Pick the session a new execution of this task may continue in, or undefined
 * to mint a fresh conversation. Two sources, in this order:
 *
 * 1. the newest SETTLED execution's session, when the task opted in
 *    (`reuseSession === true`) or this run works off a rework
 *    (`options.rework`: the human's correction was typed into that
 *    conversation, so a fresh session would lose it);
 * 2. the card's clarification session (`clarificationSessionId`), always: the
 *    questions were settled there with the human, so the run that starts
 *    the work continues exactly that conversation instead of asking again in a
 *    fresh one — the board opens no second session for it.
 *
 * Every candidate must be present and idle in the roster (issue #1587: the
 * launch path calls this after `startExecution` appended this run's own open
 * record, so reading the array tail always found an unsettled row and reuse
 * never happened); an unknown roster (session/list unavailable) never reuses,
 * because minting a fresh conversation is always safe while prompting into a
 * session we cannot see is not.
 * @param task - the task about to run.
 * @param idleSessionIds - ids the last roster saw as present and not running;
 *   undefined when that roster is unknown.
 * @param options - `rework: true` for a run that works off a send-back.
 * @returns the session id to continue in, or undefined for a fresh session.
 */
export declare function reusableSessionId(task: TaskRecord, idleSessionIds: ReadonlySet<string> | undefined, options?: {
    rework?: boolean;
}): string | undefined;
