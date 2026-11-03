/**
 * Session-reuse rule (issue #1419): decides which task runs continue in the
 * previous execution's conversation. Pure, so the fail-closed conditions stay
 * unit-testable without a gateway.
 */
import type { TaskRecord } from './tasks.ts';
/**
 * Pick the session a new execution of this task may continue in, or undefined
 * to mint a fresh conversation. Sources, in this order:
 *
 * 1. the follow-up source conversation, while the follow-up framing has not been
 *    written yet (`followUp.injectedAt` absent): the whole point of a follow-up
 *    is to continue the previous task's conversation, so its first run must land
 *    there even before the card has an execution history of its own;
 * 2. the newest SETTLED execution's session, when the task opted in
 *    (`reuseSession === true`), this run works off a rework (`options.rework`:
 *    the human's correction was typed into that conversation, so a fresh
 *    session would lose it), or this is the card's test run (`options.test`:
 *    the tests belong to the implementation the agent just finished, so the
 *    run continues that very conversation);
 * 3. the card's clarification session (`clarificationSessionId`), always: the
 *    questions were settled there with the human, so the run that starts
 *    the work continues exactly that conversation instead of asking again in a
 *    fresh one — the board opens no second session for it.
 *
 * Every candidate must be present and idle in the roster (issue #1587: the
 * launch path calls this after `startExecution` appended this run's own open
 * record, so reading the array tail always found an unsettled row and reuse
 * never happened); an unknown roster (session/list unavailable) never reuses,
 * because minting a fresh conversation is always safe while prompting into a
 * session we cannot see is not. A busy/lost follow-up source conversation is
 * therefore not an error: the run starts fresh and the prompt carries the
 * frozen source text instead (see the runner's follow-up preamble).
 * @param task - the task about to run.
 * @param idleSessionIds - ids the last roster saw as present and not running;
 *   undefined when that roster is unknown.
 * @param options - `rework: true` for a run that works off a send-back,
 *   `test: true` for the card's test run.
 * @returns the session id to continue in, or undefined for a fresh session.
 */
export declare function reusableSessionId(task: TaskRecord, idleSessionIds: ReadonlySet<string> | undefined, options?: {
    rework?: boolean;
    test?: boolean;
}): string | undefined;
