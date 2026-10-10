/**
 * Task card: the board's column item. A plain click marks the card (the
 * board owns the Ctrl/Shift/Space rules), a double click opens the task
 * detail — it never executes anything directly (detail holds the Run button).
 * A card whose latest execution carries a session also renders a direct
 * session link, for a running (active) and a settled (inactive) execution
 * alike.
 *
 * The link is a sibling of the card button, not a child: a button may not hold
 * interactive content, and a nested anchor would not be keyboard-reachable.
 * Clicking it jumps straight into the session instead of selecting the card.
 *
 * Memoized: the card re-renders only when its own task record changes, so a
 * status/filter update on one card (or scrolling) never re-renders every
 * card on the board. The per-card onClick is built with a stable task reference
 * by the board, so the memo boundary is effective.
 */
import { type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { TaskRecord, WaitingReason } from '../../core/tasks.ts';
/** Compact relative/absolute time label. */
export declare function formatHostTimestamp(ms: number, timeZone?: string): string;
export declare function formatTime(ms: number, timeZone?: string): string;
/**
 * Whether a card may be dragged at all: archived cards are read-only, a card
 * the runner owns (`running`, or pending on the Host) must not be moved while
 * its execution settles. The board reuses this to decide which cards a group
 * drag may carry, so the payload and the `draggable` attribute never disagree.
 */
export declare function isCardDraggable(task: TaskRecord, pending: boolean): boolean;
declare function TaskCardInner({ task, pending, timeZone, selected, dragging, waitingReason, waitingTooltip, awaitingAnswerSessionId, onClick, onKeyDown, onDoubleClick, onDragStart, onDragEnd, onOpenSession, onTogglePause }: {
    task: TaskRecord;
    pending: boolean;
    timeZone?: string;
    selected: boolean;
    dragging: boolean;
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
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onDoubleClick: () => void;
    onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
    onDragEnd: (event: DragEvent<HTMLButtonElement>) => void;
    onOpenSession: (sessionId: string) => void;
    onTogglePause: (task: TaskRecord) => void;
}): import("react").JSX.Element;
/** Memoized card: re-renders only when the card's own task record changes. */
export declare const TaskCard: import("react").MemoExoticComponent<typeof TaskCardInner>;
export {};
