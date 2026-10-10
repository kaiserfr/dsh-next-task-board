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
import { memo, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { TaskRecord, WaitingReason } from '../../core/tasks.ts'
import { isTaskExecuting, isTaskPaused, tagTone } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import { sessionLinkHref } from '../session-link.ts'
import css from '../board.module.css'

/** Compact relative/absolute time label. */
export function formatHostTimestamp(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

export function formatTime(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (timeZone !== undefined) return formatHostTimestamp(ms, timeZone)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Whether a card may be dragged at all: archived cards are read-only, a card
 * the runner owns (`running`, or pending on the Host) must not be moved while
 * its execution settles. The board reuses this to decide which cards a group
 * drag may carry, so the payload and the `draggable` attribute never disagree.
 */
export function isCardDraggable(task: TaskRecord, pending: boolean): boolean {
  return task.archivedAt === undefined && task.status !== 'running' && !pending
}

function TaskCardInner({ task, pending, timeZone, selected, dragging, waitingReason, waitingTooltip, awaitingAnswerSessionId, onClick, onKeyDown, onDoubleClick, onDragStart, onDragEnd, onOpenSession, onTogglePause }: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  selected: boolean
  dragging: boolean
  /**
   * Why the card waits for its lane's WIP slot (undefined when it waits for
   * nothing). The reason itself is not rendered; the tooltip carries the text.
   */
  waitingReason?: WaitingReason
  /** The waiting reason as text, with the workspace and blocker named. */
  waitingTooltip?: string
  /**
   * The conversation the Host found waiting for the human's answer (the agent
   * asked and stopped). The card then shows its question symbol, which jumps
   * straight into that session; undefined while nothing is open.
   */
  awaitingAnswerSessionId?: string
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onDoubleClick: () => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd: (event: DragEvent<HTMLButtonElement>) => void
  onOpenSession: (sessionId: string) => void
  onTogglePause: (task: TaskRecord) => void
}) {
  const latest = task.executions[task.executions.length - 1]
  const runs = task.executions.length
  const archived = task.archivedAt !== undefined
  // "Running now" (holds a session) is marked hard; an open run without a
  // session is still queued for a WIP slot and only reads as "waiting". A
  // paused card keeps its open run but is neither: its session was stopped.
  const paused = !archived && isTaskPaused(task)
  const executing = !archived && isTaskExecuting(task)
  const queued = !archived && !executing && !paused && !pending && latest !== undefined && latest.endedAt === undefined
  const isDraggable = isCardDraggable(task, pending)
  // The pause button covers every open run of the card: the executing one (its
  // session is stopped) and the queued one (it never starts). A paused card
  // offers the same button as a play button to resume the run. The card's
  // clarification run in `todo` is a run like any other, so it is pausable too.
  const openRun = latest !== undefined && latest.endedAt === undefined
  const showPauseControl = !archived && !pending && (paused || openRun)
  // One jump target per card: the newest execution's conversation — and a card
  // that only ever had a clarification conversation keeps offering that one. A
  // run that has not attached a session yet has none to offer.
  const clarificationSessionId = task.clarificationSessionId
  const sessionId = latest?.sessionId ?? clarificationSessionId
  const clarificationLink = sessionId !== undefined && sessionId === clarificationSessionId && sessionId !== latest?.sessionId
  const sessionLabel = clarificationLink ? t('card.clarifySession') : t('card.openSession')
  // The Host's question watch: this card's conversation holds a question the
  // agent asked and stopped on. Its own jump target is the conversation the Host
  // named (never a guessed one), so the symbol always lands where the answer
  // belongs.
  const answering = !archived && awaitingAnswerSessionId !== undefined

  return (
    <div className={css.cardBox} data-dsh-part="card-box">
      <button
        type="button"
        className={css.card}
        data-status={archived ? 'archived' : task.status}
        data-dsh-part="card"
        data-pending={pending || undefined}
        data-executing={executing || undefined}
        data-paused={paused || undefined}
        data-has-session={sessionId !== undefined || undefined}
        data-has-pause={showPauseControl || undefined}
        data-answering={answering || undefined}
        data-selected={selected || undefined}
        data-dragging={dragging || undefined}
        data-waiting={waitingReason === undefined ? undefined : true}
        aria-pressed={archived ? undefined : selected}
        draggable={isDraggable}
        onDragStart={isDraggable ? onDragStart : undefined}
        onDragEnd={isDraggable ? onDragEnd : undefined}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        title={waitingTooltip ?? (task.description !== '' ? task.description : task.title)}
      >
        <span className={css.cardTitle}>{task.title}</span>
        {task.tags !== undefined && task.tags.length > 0 && (
          <span className={css.cardTags}>
            {task.tags.map(tag => (
              <span
                key={tag.name}
                className={css.cardTag}
                data-tag-tone={tagTone(tag.name)}
                data-dsh-part="tag-badge"
                data-tag-hint={tag.promptPrefix === undefined ? undefined : tag.promptPrefix}
                title={tag.promptPrefix === undefined ? tag.name : tag.promptPrefix}
              >
                {tag.name}
              </span>
            ))}
          </span>
        )}
        {task.description !== '' && <span className={css.cardExcerpt}>{task.description}</span>}
        <span className={css.cardMeta}>
          <span className={css.cardTime}>{t('board.updated')} {formatTime(task.updatedAt)}</span>
          {task.freeze !== undefined && (
            <span className={css.cardSchedule} title={task.freeze.goal}>{t('card.frozen')}</span>
          )}
          {!archived && task.schedule?.enabled === true && (
            <span
              className={css.cardSchedule}
              title={task.schedule.nextRunAt !== undefined
                ? `${t('card.scheduled')} · ${formatHostTimestamp(task.schedule.nextRunAt, timeZone)}`
                : t('card.scheduled')}
            >
              {t('card.scheduled')}
            </span>
          )}
          {latest !== undefined && (
            <span className={css.cardRun} data-result={archived ? undefined : latest.result}>
              {runs} {t('board.runs')}
            </span>
          )}
          {!archived && (executing || pending) && <span className={css.cardSpinner} aria-hidden="true" />}
        </span>
        {!archived && pending && <span className={css.cardRunningLabel}>{t('board.pending')}…</span>}
        {executing && <span className={css.cardExecutingBadge}>{t('card.running')}</span>}
        {paused && (
          <span className={css.cardExecutingBadge} data-paused="true" data-dsh-part="card-paused">
            {t('card.paused')}
          </span>
        )}
        {queued && (
          // A queued card either waits for its lane's WIP slot (the Host's
          // launch queue) or — for an older Host, or a card nothing holds — is
          // simply not started yet; the waiting variant names the blocker.
          <span
            className={css.cardRunningLabel}
            data-dsh-part={waitingReason === undefined ? 'card-queued' : 'card-waiting'}
            title={waitingTooltip ?? t('card.queued')}
          >
            {waitingReason === undefined ? t('card.queued') : t('card.waiting')}
          </span>
        )}
      </button>
      {showPauseControl && (
        // Pause/resume sibling of the card button (a button may not nest in a
        // button): the pause glyph while the run is open, the play glyph to
        // start a paused run again.
        <button
          type="button"
          className={css.cardPause}
          data-dsh-part={paused ? 'card-resume' : 'card-pause'}
          title={paused ? t('card.resume') : t('card.pause')}
          aria-label={paused ? t('card.resume') : t('card.pause')}
          onClick={(event) => { event.stopPropagation(); onTogglePause(task) }}
          onDoubleClick={(event) => { event.stopPropagation() }}
        >
          <span aria-hidden="true">{paused ? '▶' : '⏸'}</span>
        </button>
      )}
      {!archived && awaitingAnswerSessionId !== undefined && (
        // The card's conversation waits for the human: a question-mark anchor in
        // the free top-left corner jumps into that very session, where the
        // question card or the chat that asked sits. Same sibling/click rules as
        // the session link below — the card's own click must never also fire.
        <a
          className={css.cardQuestion}
          data-dsh-part="card-awaiting-answer"
          href={sessionLinkHref(awaitingAnswerSessionId)}
          title={`${t('card.awaitingAnswer')} · ${awaitingAnswerSessionId}`}
          aria-label={t('card.awaitingAnswer')}
          onClick={(event) => {
            event.stopPropagation()
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
            event.preventDefault()
            onOpenSession(awaitingAnswerSessionId)
          }}
          onDoubleClick={(event) => { event.stopPropagation() }}
        >
          <span aria-hidden="true">?</span>
        </a>
      )}
      {sessionId !== undefined && (
        <a
          className={css.cardSession}
          data-dsh-part={clarificationLink ? 'card-clarify-session' : 'card-session'}
          href={sessionLinkHref(sessionId)}
          title={`${sessionLabel} · ${sessionId}`}
          aria-label={sessionLabel}
          onClick={(event) => {
            // The card's own detail click must never also fire, whatever the
            // modifier. A plain left-click jumps in place; a modified click
            // keeps the browser's new-tab behavior (the href is the deep link),
            // which is exactly what the anchor exists for.
            event.stopPropagation()
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
            event.preventDefault()
            onOpenSession(sessionId)
          }}
          // The second click of a double click must not reach the card either,
          // or jumping into a session would also pop the detail open.
          onDoubleClick={(event) => { event.stopPropagation() }}
        >
          <span aria-hidden="true">⌁</span>
        </a>
      )}
    </div>
  )
}

/** Memoized card: re-renders only when the card's own task record changes. */
export const TaskCard = memo(TaskCardInner)
