import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway';
import type { SessionHistoryRecord, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import type { CommandResult } from '@deepseek-ai/dsh-commands/types';
import type { Workspace } from '@deepseek-ai/dsh-workspace/types';
import type { TaskRecord } from './core/tasks.ts';
/** Host services needed to validate a task's workspace before creating a session. */
export interface TaskBoardWorkspaceRegistry {
    list(): readonly Workspace[];
}
interface GatewayRequest {
    namespace: string;
    method: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
}
interface SessionGateway {
    invoke(request: GatewayRequest): Promise<unknown>;
    stream?(request: GatewayRequest): Promise<AsyncIterable<unknown>>;
}
/** What the newest events of one conversation say about an open question. */
export interface QuestionState {
    /** The newest thing that happened is an `ask_user_question` call nothing answered yet. */
    readonly openQuestion: boolean;
    /** The agent spoke last: the turn ended with a message of its own. */
    readonly yielded: boolean;
}
/**
 * Fold one history window into {@link QuestionState}: which of the two ways the
 * agent asks, if any.
 *
 * `openQuestion` is the blocking `ask_user_question` call (the schema the
 * shipped presets compose): the tool call is the newest surface event and no
 * `tool/result` answers it, while the turn — and the roster's `running` flag —
 * stays open. `yielded` is the other shape: the agent ended the turn with its
 * own message, which is how the board's clarification round stops after every
 * question round. A call the human already answered is no question any more,
 * and a tool result the agent left unanswered is a stalled run, not a question
 * to the human.
 * @param records - the conversation's newest history records, in any order.
 * @returns the folded state; both flags false when nothing speaks for a question.
 */
export declare function questionState(records: readonly SessionHistoryRecord[]): QuestionState;
/** One session-list row consumed by task-board reconciliation. */
export type { SessionSummary };
type ExecutionSessionId = SessionSummary['sessionId'];
export interface SessionCommandDispatcher {
    execute(sessionId: ExecutionSessionId, line: string, signal: AbortSignal): Promise<CommandResult | undefined>;
}
export type ExecutionInspection = {
    outcome: 'pending';
} | {
    outcome: 'succeeded';
} | {
    outcome: 'failed';
    error: string;
} | {
    outcome: 'cancelled';
    error: string;
};
/** A post-create launch failure that still identifies the session to the ledger. */
export declare class SessionLaunchError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string, cause: unknown);
}
/**
 * How one run's prompt is composed beyond the card body itself.
 */
export interface PromptTextOptions {
    /**
     * The run continues the previous execution's conversation. Set exactly when
     * the launch reuses a session: the note then replaces the card body, because
     * the conversation already holds the original instruction and everything the
     * agent did after it.
     */
    continued?: boolean;
    /**
     * This run works off a rework (see `ExecutionRecord.rework`): the human
     * reviewed the previous round and wrote the correction into the card's own
     * conversation. Only meaningful together with `continued` — the turn then
     * frames what is already in that chat instead of repeating the card body.
     */
    rework?: boolean;
    /**
     * Compose the card's clarification turn instead of the execution prompt: the
     * opening of the card's clarification session, whose only job is settling the
     * open questions with the human before anything is implemented. The agent
     * asks them in that chat; the human answers there.
     */
    clarification?: boolean;
    /**
     * This run resumes a paused execution: the turn is the short "continue" the
     * board writes into the run's own conversation (the agent already has the
     * card's instruction and everything it did so far in context).
     */
    resume?: boolean;
    /**
     * This run continues the card's clarification conversation: the human pulled
     * the card on to the run column, so the agent — which already holds the card's
     * instruction, the questions it asked and their answers from that same
     * conversation —
     * only needs the go-ahead to implement.
     */
    implement?: boolean;
}
/**
 * The clarification addendum: what the `backlog → todo` run tells the agent to
 * do *instead of* working. Exported because the board's system-prompt rule keys
 * off exactly this text (see `TASK_BOARD_GUIDANCE`).
 */
export declare const CLARIFICATION_ADDENDUM: readonly string[];
/**
 * The completion report a run's agent writes as the last line of its answer.
 * This is a report for the human reading the card's chat, **not** the run's
 * settlement: the Host advances the card to "待测试" (`ready_for_test`) only
 * once the execution's session has come to rest (see
 * {@link HostExecutionRunner.inspect}). A session that keeps its turn open
 * therefore keeps the card in "In Arbeit" — the report alone never moves it.
 *
 * The board's system-prompt rule (`TASK_BOARD_GUIDANCE`) interpolates this
 * constant and {@link COMPLETION_INSTRUCTION}, so the report the agent is asked
 * for reads the same everywhere.
 */
export declare const COMPLETION_MARKER = "FERTIG:";
/**
 * The instruction that teaches one run how to report completion. Kept in the
 * same language as the board's other injected preambles; the marker itself is
 * fixed by {@link COMPLETION_MARKER}.
 */
export declare const COMPLETION_INSTRUCTION: string;
/**
 * Compose the execution prompt (issue #6): a continuation card (one carrying
 * a frozen snapshot) has its instruction mandatorily wrapped in a source
 * declaration (freeze instant, source session, unreviewed-content warning)
 * templated by the board, so the picking-up agent stays wary of stored
 * prompt-instruction injection in card text (adversarial scenario c). The
 * wrap composes with the T4 handover preamble: the reference preamble comes
 * first, the provenance wrap then encloses the instruction. Plain tasks (no
 * freeze) keep the bare handover preamble + prompt.
 *
 * A rework round is composed differently on purpose (see
 * {@link PromptTextOptions.continued}): the correction lives in the continued
 * conversation, so the round's turn only frames it and never rewrites the
 * card's `prompt`, which stays the record of what was originally asked.
 *
 * Every implementation turn carries {@link COMPLETION_INSTRUCTION} as its last
 * block, so the run knows how to report itself done no matter which turn does
 * the work (full prompt, go-ahead, continue, rework) — the board's
 * `announceToAgent` system-prompt section is off by default and must not be the
 * only carrier of that report. The report is written for the human; it is not
 * what settles the execution. Only the clarification turn is exempt: it
 * implements nothing and must not report a finished card.
 * @param task - the card being run.
 * @param options - continuation flag plus the round's rework mark.
 */
export declare function promptText(task: TaskRecord, options?: PromptTextOptions): string;
export declare class HostExecutionRunner {
    private readonly gateway;
    private readonly commands?;
    private readonly workspaceRegistry?;
    /** Newest scanned event sequence per session with no matching execution end. */
    private readonly scanMemos;
    private readonly unavailableAttempts;
    private readonly unavailableBackoffMs;
    private unsupportedSessionListWarned;
    /** Warn once when the runtime predates the live session control endpoint. */
    private unsupportedSessionControlWarned;
    constructor(gateway: SessionGateway | TypertGateway, commands?: SessionCommandDispatcher | undefined, workspaceRegistry?: TaskBoardWorkspaceRegistry | undefined, unavailableRetry?: {
        attempts?: number;
        backoffMs?: number;
    });
    private invoke;
    private stream;
    /**
     * Launch one execution. Without `options.reuseSessionId` a fresh session is
     * created, renamed, pinned, and prompted (the historical contract). With it,
     * the run continues in that existing session (issue #1419): the conversation
     * keeps its title and history, the pinned permission/model are re-asserted so
     * the task's execution contract still holds, and the prompt is queued.
     * @param task - the task to run.
     * @param options - optional session to continue in, `rework: true` when this
     *   run works off a send-back (it then continues the corrected conversation
     *   with the rework framing instead of the whole card body),
     *   `clarification: true` to open the card's
     *   clarification run instead of a run prompt, `implement: true` to send only
     *   the go-ahead into the clarification conversation this run continues, or
     *   `resume: true` to write the "continue" turn of a resumed pause into the
     *   continued session.
     * @returns the session id the execution runs in.
     */
    launch(task: TaskRecord, options?: {
        reuseSessionId?: string;
        rework?: boolean;
        clarification?: boolean;
        implement?: boolean;
        resume?: boolean;
    }): Promise<string>;
    /**
     * Re-assert the pinned execution contract on a session and queue the run's
     * prompt. Shared by the fresh-session and reuse paths so both apply exactly
     * the same permission/model pins before the prompt.
     */
    private pinAndPrompt;
    /**
     * Stop the session's active turn without ending the session: the pause path.
     * The conversation (and the card's execution record) stays, so resuming it
     * later just queues the next turn. Rejects when the session has no live agent
     * (the run already finished, or the Host restarted); the caller decides what
     * that means for the card.
     * @param sessionId - the execution session to stop.
     */
    cancel(sessionId: string): Promise<void>;
    listRunning(): Promise<{
        known: true;
        count: number;
        items: SessionSummary[];
    } | {
        known: false;
    }>;
    /**
     * Resolve an execution outcome from the session list and bounded history pages.
     *
     * The session ending is a hard precondition for every non-pending outcome:
     * neither the agent's own `FERTIG:` report in the chat nor a finished turn is
     * evidence that the run is over, so a session the roster still reports as
     * running (or one that still owns queued prompts or a live job) keeps the
     * outcome `pending` and the card in "In Arbeit".
     * @param sessionId - the run's session.
     * @param startedAt - when the run opened; messages older than this belong to an
     * earlier run of the same conversation.
     * @param sessions - the roster the caller already fetched; a fresh read otherwise.
     */
    inspect(sessionId: string, startedAt?: number, sessions?: readonly SessionSummary[]): Promise<ExecutionInspection>;
    /**
     * Whether the human has written in a card's conversation since `since`, and
     * when. This is how the board notices a rework: the reviewed card sits in
     * `ready_for_test`, the human types the correction into that card's own chat,
     * and the Host sends the card back — the correction itself stays where it was
     * written, the ledger only keeps the stamp (there is no note field).
     *
     * Fail closed: an unreadable snapshot reports `known: false`, so a card is
     * never sent back on a guess and the next poll retries.
     * @param sessionId - the card's conversation.
     * @param since - when the card parked in its column; older turns belong to
     *   the run that just settled (including every prompt the board itself sent).
     * @returns whether the read succeeded, plus the newest human turn's instant.
     */
    newestHumanTurn(sessionId: string, since: number): Promise<{
        known: boolean;
        at?: number;
    }>;
    /**
     * Whether a card's conversation waits for the human's answer.
     *
     * Two shapes count, because the agent can ask in two ways: a blocking
     * `ask_user_question` call no result has answered yet (the turn stays open, so
     * the roster still reports the session as running), and the agent ending its
     * turn with a message of its own — the shape the board's clarification round
     * produces by stopping after every question round, which needs the session to
     * be at rest to mean "the human is next".
     *
     * The durable `userQuestions` projection answers for the timed
     * `ask_user_question` schema, whose foreground wait may end with a pending
     * result while the question stays answerable: that state is invisible in the
     * log, so the projection is read as a second source. It is absent on hosts and
     * presets that never used that schema, which is no evidence either way.
     * @param sessionId - the card's conversation.
     * @param running - whether the roster currently reports that session as running.
     * @returns whether the human owes an answer, or undefined when the history
     *   could not be read (the caller keeps the last verdict instead of guessing).
     */
    awaitingAnswer(sessionId: string, running: boolean): Promise<boolean | undefined>;
    /**
     * Whether the timed `ask_user_question` projection still offers an answerable
     * question. An absent projection (an older host, or a preset that asks in
     * blocking mode) is "no evidence", not an error; a failed read reports unknown
     * so the caller holds its last verdict instead of dropping the human's cue on
     * a hiccup.
     * @param sessionId - the card's conversation.
     */
    private pendingTimedQuestion;
    /**
     * Whether the session has stopped working on this execution: its prompt
     * inbox holds nothing pending, no background job of it is in flight (a
     * finished job wakes the session for another turn under the default
     * `wakeup` delivery), and it is not running right now.
     *
     * The two reads happen in this order on purpose: the live inbox/job
     * baseline answers "is there work left at all", and the roster read that
     * follows is the freshest observation, so a turn that started while the
     * baseline was being fetched still keeps the outcome pending.
     *
     * Both reads fail closed: an unreadable state is not evidence of a finished
     * session, so the outcome stays pending and the next poll retries.
     * @param sessionId - the execution's session.
     * @returns true only on confirmed silence.
     */
    private sessionEnded;
    /**
     * Read the Host-wide live control baseline and report whether this session
     * still owns pending work. Every other outcome is deliberately not "none":
     * a frame that is not the baseline or a failed stream leaves the state
     * unknown, which keeps the execution pending.
     * @param sessionId - the execution's session.
     * @returns 'some' when the session has queued prompts or a live job,
     * 'none' when it has neither, 'unsupported' when the runtime has no such
     * endpoint, 'unknown' when the read failed.
     */
    private pendingWork;
    /**
     * Re-read the roster and confirm the session is listed as not running right
     * now. The poll's earlier list predates the history scan, so a turn that
     * started in between would otherwise be invisible.
     * @param sessionId - the execution's session.
     * @returns true only when a fresh roster row reports it idle.
     */
    private sessionIdleNow;
}
