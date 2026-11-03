import type { ExecutionRecord, TaskRecord } from './tasks.ts'

/**
 * Session-continuity rule (issue #1419): decides which task runs continue in the
 * card's previous conversation. Pure, so the candidates stay unit-testable
 * without a gateway.
 *
 * The **ledger** is the authority here, not a roster snapshot. A roster read is
 * a point-in-time view: a conversation that ended a second ago is still listed
 * as running, and one the runtime no longer enumerates is not gone — its history
 * lives on disk. Gating reuse on that snapshot minted a second session for the
 * same card: the automatic test run opens *inside* the settle of the
 * implementation run (before any poll could see that session at rest), and a
 * go-ahead pulled shortly after the clarification round ended hit the same stale
 * window. Both paid the whole card prompt again instead of continuing the
 * conversation the human was just reading (see `docs/session-reuse.md`).
 *
 * Sources, in this order:
 *
 * 1. the follow-up source conversation, while the follow-up framing has not been
 *    written yet (`followUp.injectedAt` absent): the whole point of a follow-up
 *    is to continue the previous task's conversation, so its first run must land
 *    there even before the card has an execution history of its own;
 * 2. the newest SETTLED execution's session, when the task opted in
 *    (`reuseSession === true`), this run works off a rework (`options.rework`:
 *    the human's correction was typed into that conversation, so a fresh
 *    session would lose it), or this is the card's test run (`options.test`:
 *    the tests belong to the implementation the agent just finished, so the run
 *    continues that very conversation);
 * 3. the card's clarification session (`clarificationSessionId`), always: the
 *    questions were settled there with the human, so the run that starts the
 *    work continues exactly that conversation instead of asking again in a fresh
 *    one — the board opens no second session for it.
 *
 * A busy conversation is not a reason to open a second one either: the runtime
 * queues the prompt into the running session, so the go-ahead lands after the
 * turn the human is watching instead of starting a parallel chat. A recorded
 * session the runtime cannot continue at all fails visibly on the card (the
 * session id is part of the error) rather than silently minting a second
 * conversation.
 * @param task - the task about to run.
 * @param options - `rework: true` for a run that works off a send-back,
 *   `test: true` for the card's test run.
 * @returns the session id to continue in, or undefined for a fresh session.
 */
export function reusableSessionId(
  task: TaskRecord,
  options: { rework?: boolean; test?: boolean } = {},
): string | undefined {
  const followUp = task.followUp
  if (followUp !== undefined && followUp.injectedAt === undefined && followUp.sessionId !== undefined) {
    return followUp.sessionId
  }
  if (task.reuseSession === true || options.rework === true || options.test === true) {
    let last: ExecutionRecord | undefined
    for (let index = task.executions.length - 1; index >= 0; index -= 1) {
      const candidate = task.executions[index]
      if (candidate.sessionId !== undefined && candidate.endedAt !== undefined) {
        last = candidate
        break
      }
    }
    if (last?.sessionId !== undefined) return last.sessionId
  }
  return task.clarificationSessionId
}
