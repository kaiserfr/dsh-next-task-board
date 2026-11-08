/**
 * Task card: the board's column item. The card body itself is not a click
 * target: its title and the short description below it form one button that
 * opens the task detail — the detail holds the transition buttons, including
 * the run starts. Selection is a separate, visually unlabelled checkbox in the
 * card's top-left corner; the board owns the Shift range rule. A card whose
 * latest execution carries a session also renders a direct session link, for a
 * running (active) and a settled (inactive) execution alike.
 *
 * The card's left/right edges carry the one-column step chevrons: they move the
 * card to the directly adjacent column (the same manual transition a drop would
 * fire) and are disabled at the board's edges and whenever that move is blocked.
 * The board resolves the target and blocker; the card only renders them.
 *
 * The detail button, the checkbox, the corner controls and the chevrons are
 * siblings of the card body: each click reaches only its own control, so a link
 * jumps, the checkbox marks, a chevron steps, and nothing opens the detail by
 * accident. The tags, the meta row and the card's empty space stay inert.
 *
 * Memoized: the card re-renders only when its own task record changes, so a
 * status/filter update on one card (or scrolling) never re-renders every
 * card on the board. The per-card handlers are built with a stable task
 * reference by the board, so the memo boundary is effective.
 */
import { type DragEvent } from 'react';
import type { TaskRecord, TaskStatus, WaitingReason } from '../../core/tasks.ts';
import type { QueuedTransition, StepBlocker, TransitionError } from '../../core/transitions.ts';
/** Compact relative/absolute time label. */
export declare function formatHostTimestamp(ms: number, timeZone?: string): string;
export declare function formatTime(ms: number, timeZone?: string): string;
/**
 * Whether a card may be dragged at all: only archived cards are read-only. A
 * card the runner owns (`running`) may be dragged too — the drop validation
 * (machine + {@link transitionBlockerOf}) only lets it land on Done, where the
 * Host settles the open run and stops the session; every other column still
 * refuses it. A card with an action in the outbox is deliberately **not**
 * excluded: further actions queue behind it, so the user is never blocked by a
 * running backend call. The board reuses this to decide which cards a group
 * drag may carry.
 */
export declare function isCardDraggable(task: TaskRecord): boolean;
/**
 * Whether a card may take part in the selection's bulk archive/delete. The
 * broader drag rule deliberately does not apply here: archiving a card while a
 * Host action for it is on the wire would race that action (pending cards stay
 * out), and a card the runner owns cannot be archived/deleted at all — its run
 * must end first (`running`). Only the drag onto Done may bypass the run.
 */
export declare function isCardBulkActionable(task: TaskRecord, pending: boolean): boolean;
declare function TaskCardInner({ task, pending, releasePending, releaseLocked, pendingTransition, transitionError, timeZone, selected, dragging, waitingReason, waitingTooltip, awaitingAnswerSessionId, hasFollowUpSource, followUpSourceHint, leftTarget, leftBlocker, rightTarget, rightBlocker, onSelect, onOpen, onDragStart, onDragEnd, onOpenSession, onTogglePause, onStopSession, onRelease, onStep, sessionRunning }: {
    task: TaskRecord;
    pending: boolean;
    /** A merge release of this card runs in the Host's background. */
    releasePending?: boolean;
    /**
     * The Host would refuse the release (the card's branch belongs to a
     * follow-up): the card then offers no merge control of its own.
     */
    releaseLocked?: boolean;
    /** The card's waiting transition intent (one per card), if any. */
    pendingTransition?: QueuedTransition;
    /** The last discarded/failed transition, until the card's next action. */
    transitionError?: TransitionError;
    timeZone?: string;
    selected: boolean;
    dragging: boolean;
    /** The card is the source of at least one follow-up card. */
    hasFollowUpSource?: boolean;
    /** Titles of this card's follow-ups, for the source badge's tooltip. */
    followUpSourceHint?: string;
    /**
     * Why the card waits for its lane's WIP slot (undefined when it waits for
     * nothing). The reason itself is not rendered; the tooltip carries the text.
     */
    waitingReason?: WaitingReason;
    /** The waiting reason as text, with the workspace and blocker named. */
    waitingTooltip?: string;
    /**
     * The conversation the Host found waiting for the human's answer (the agent
     * asked and stopped). The card then shows its question symbol, which jumps
     * straight into that session; undefined while nothing is open.
     */
    awaitingAnswerSessionId?: string;
    /** Neighboring column to the card's left; undefined at the board's edge. */
    leftTarget?: TaskStatus;
    /** Why a step left is unavailable (`edge` = no column there). */
    leftBlocker?: StepBlocker;
    /** Neighboring column to the card's right; undefined at the board's edge. */
    rightTarget?: TaskStatus;
    /** Why a step right is unavailable (`edge` = no column there). */
    rightBlocker?: StepBlocker;
    /** Mark or unmark the card; `extend` walks the range from the last marked card. */
    onSelect: (id: string, extend: boolean) => void;
    /** Open the card's detail (the title and excerpt are the only entry). */
    onOpen: (id: string) => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: (event: DragEvent<HTMLElement>) => void;
    onOpenSession: (sessionId: string) => void;
    onTogglePause: (task: TaskRecord) => void;
    /** Stop the conversation right now (the Host says it is running). */
    onStopSession: (task: TaskRecord) => void;
    /** Ask to release the card for the merge (the Host's `approve-merge`). */
    onRelease: (task: TaskRecord) => void;
    /** Fire the manual transition into the adjacent column (same as a drop). */
    onStep: (taskId: string, status: TaskStatus) => void;
    /** Whether the card's conversation is running right now (derived by the Host). */
    sessionRunning: boolean;
}): import("react").JSX.Element;
/** Memoized card: re-renders only when the card's own task record changes. */
export declare const TaskCard: import("react").MemoExoticComponent<typeof TaskCardInner>;
export {};
