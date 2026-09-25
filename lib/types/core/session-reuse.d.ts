/**
 * Session-reuse rule (issue #1419): decides which task runs continue in the
 * previous execution's conversation. Pure, so the fail-closed conditions stay
 * unit-testable without a gateway.
 */
import type { TaskRecord } from './tasks.ts';
/**
 * Pick the session a new execution of this task may continue in, or undefined
 * to mint a fresh conversation. Reuse requires ALL of:
 * - the task opted in (`reuseSession === true`), or this run is a rework round
 *   (`options.rework`: a correction note is only meaningful in the conversation
 *   it corrects, so a rework continues that conversation even on a card that
 *   never opted in — the note alone, as its own turn, is what the agent gets);
 * - the task's newest SETTLED execution carries a session id (issue #1587: the
 *   launch path calls this after `startExecution` appended this run's own open
 *   record, so reading the array tail always found an unsettled row and reuse
 *   never happened);
 * - the roster is known and that session is present and idle.
 *
 * An unknown roster (session/list unavailable) never reuses: minting a fresh
 * conversation is always safe, prompting into a session we cannot see is not.
 * The caller therefore has to carry the correction note on the fresh prompt
 * when this returns undefined, or the remark would be lost silently.
 * @param task - the task about to run.
 * @param idleSessionIds - ids the last roster saw as present and not running;
 *   undefined when that roster is unknown.
 * @param options - `rework: true` for a run started from a correction note.
 * @returns the session id to continue in, or undefined for a fresh session.
 */
export declare function reusableSessionId(task: TaskRecord, idleSessionIds: ReadonlySet<string> | undefined, options?: {
    rework?: boolean;
}): string | undefined;
