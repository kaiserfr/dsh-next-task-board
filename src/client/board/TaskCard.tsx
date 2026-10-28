/**
 * Task card: the board's column item. A plain click marks the card (the
 * board owns the Ctrl/Shift/Space rules), a double click opens the task
 * detail — it never executes anything directly (detail holds the transition
 * buttons, including the run starts). A card whose latest execution carries a
 * session also renders a direct session link, for a running (active) and a
 * settled (inactive) execution alike.
 *
 * The card's left/right edges carry the one-column step chevrons: they move the
 * card to the directly adjacent column (the same manual transition a drop would
 * fire) and are disabled at the board's edges and whenever that move is blocked.
 * The board resolves the target and blocker; the card only renders them.
 *
 * The link and the chevrons are siblings of the card button, not children: a
 * button may not hold interactive content, and a nested anchor would not be
 * keyboard-reachable. Clicking them acts on the card instead of opening it.
 *
 * Memoized: the card re-renders only when its own task record changes, so a
 * status/filter update on one card (or scrolling) never re-renders every
 * card on the board. The per-card onClick is built with a stable task reference
 * by the board, so the memo boundary is effective.
 */
import { memo, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { TaskRecord, TaskStatus, WaitingReason } from '../../core/tasks.ts'
import { isTaskExecuting, isTaskPaused, tagTone } from '../../core/tasks.ts'
import type { ColumnStep, QueuedTransition, StepBlocker, TransitionError } from '../../core/transitions.ts'
import { mergeStateOf, type MergeState } from '../../core/merge.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { sessionLinkHref } from '../session-link.ts'
import css from '../board.module.css'
import { queuedTransitionText, blockerText, statusLabel, transitionErrorText } from './transition-text.ts'

/** Badge wording of one merge state (the card's own one-word verdict). */
const MERGE_KEY: Record<MergeState, TaskBoardKey> = {
  merged: 'card.merge.merged',
  unmerged: 'card.merge.unmerged',
  released: 'card.merge.released',
  resolving: 'card.merge.resolving',
  failed: 'card.merge.failed',
  'no-branch': 'card.merge.noBranch',
}

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
 * Whether a card may be dragged at all: archived cards are read-only and a card
 * the runner owns (`running`) must not be moved while its execution settles.
 * A card with an action in the outbox is deliberately **not** excluded: further
 * actions queue behind it, so the user is never blocked by a running backend
 * call. The board reuses this to decide which cards a group drag may carry.
 */
export function isCardDraggable(task: TaskRecord): boolean {
  return task.archivedAt === undefined && task.status !== 'running'
}

/**
 * Whether a card may take part in the selection's bulk archive/delete. The
 * broader drag rule deliberately does not apply here: archiving a card while a
 * Host action for it is on the wire would race that action, so pending cards
 * remain out of the bulk actions even though they can be dragged.
 */
export function isCardBulkActionable(task: TaskRecord, pending: boolean): boolean {
  return isCardDraggable(task) && !pending
}

/**
 * One of the card's two column-step chevrons: a small sibling button at the
 * card's left or right edge. The wrapper owns the tooltip so the disabled
 * state's reason stays readable (a disabled button swallows mouse events); the
 * button itself only fires the transition the board resolved.
 */
function CardStepButton({ taskId, direction, target, blocker, disabled, queued, title, onStep }: {
  taskId: string
  direction: ColumnStep
  target?: TaskStatus
  blocker?: StepBlocker
  disabled: boolean
  queued: boolean
  title: string
  onStep: (taskId: string, status: TaskStatus) => void
}) {
  return (
    <span
      className={direction === 'left' ? css.cardStepLeft : css.cardStepRight}
      title={title}
    >
      <button
        type="button"
        className={css.cardStep}
        data-dsh-part={`card-step-${direction}`}
        data-target={target}
        data-blocker={blocker}
        data-queued={queued || undefined}
        disabled={disabled}
        title={title}
        aria-label={title}
        onClick={(event) => {
          // The card's own detail click must never also fire.
          event.stopPropagation()
          if (target === undefined || disabled) return
          onStep(taskId, target)
        }}
        onDoubleClick={(event) => { event.stopPropagation() }}
      >
        <span aria-hidden="true">{direction === 'left' ? '‹' : '›'}</span>
      </button>
    </span>
  )
}

function TaskCardInner({ task, pending, releasePending, pendingTransition, transitionError, timeZone, selected, dragging, waitingReason, waitingTooltip, awaitingAnswerSessionId, leftTarget, leftBlocker, rightTarget, rightBlocker, onClick, onKeyDown, onDoubleClick, onDragStart, onDragEnd, onOpenSession, onTogglePause, onStopSession, onStep, sessionRunning }: {
  task: TaskRecord
  pending: boolean
  /** A merge release of this card runs in the Host's background. */
  releasePending?: boolean
  /** The card's waiting transition intent (one per card), if any. */
  pendingTransition?: QueuedTransition
  /** The last discarded/failed transition, until the card's next action. */
  transitionError?: TransitionError
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
  /** Neighboring column to the card's left; undefined at the board's edge. */
  leftTarget?: TaskStatus
  /** Why a step left is unavailable (`edge` = no column there). */
  leftBlocker?: StepBlocker
  /** Neighboring column to the card's right; undefined at the board's edge. */
  rightTarget?: TaskStatus
  /** Why a step right is unavailable (`edge` = no column there). */
  rightBlocker?: StepBlocker
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onDoubleClick: () => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd: (event: DragEvent<HTMLButtonElement>) => void
  onOpenSession: (sessionId: string) => void
  onTogglePause: (task: TaskRecord) => void
  /** Stop the conversation right now (the Host says it is running). */
  onStopSession: (task: TaskRecord) => void
  /** Fire the manual transition into the adjacent column (same as a drop). */
  onStep: (taskId: string, status: TaskStatus) => void
  /** Whether the card's conversation is running right now (derived by the Host). */
  sessionRunning: boolean
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
  const isDraggable = isCardDraggable(task)
  const transitionErrorTextOf = transitionError === undefined ? undefined : transitionErrorText(transitionError)
  const transitionQueuedTextOf = pendingTransition === undefined ? undefined : queuedTransitionText(pendingTransition)
  // The pause button covers every open run of the card: the executing one (its
  // session is stopped) and the queued one (it never starts). A paused card
  // offers the same button as a play button to resume the run. The card's
  // clarification run in `clarification` is a run like any other, so it is
  // pausable too.
  const openRun = latest !== undefined && latest.endedAt === undefined
  // A paused card whose session is running again (a background job woke it, or
  // the human typed) cannot be "resumed" meaningfully: the control that helps is
  // the stop.
  const showStopControl = !archived && !pending && paused && sessionRunning
  const showPauseControl = !archived && !pending && (paused || openRun) && !showStopControl
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
  // The card's merge verdict: whether its result is in the base branch. Derived
  // from the card's own git/merge records, so a card never claims a merge it did
  // not record; undefined on cards with nothing to say about a merge.
  const merge = mergeStateOf(task)
  // One-column steps: the board resolved the neighbor and its blocker. A step
  // already queued for that very target is disabled like the detail's button;
  // a different waiting target stays selectable (the last click wins per card).
  const leftQueued = leftTarget !== undefined && pendingTransition?.to === leftTarget
  const rightQueued = rightTarget !== undefined && pendingTransition?.to === rightTarget
  const leftDisabled = leftBlocker !== undefined || leftQueued
  const rightDisabled = rightBlocker !== undefined || rightQueued
  // The wrapper owns the tooltip (a disabled native button swallows the mouse),
  // so the title always names the action, the target column and the reason.
  const stepTitleOf = (direction: ColumnStep, target: TaskStatus | undefined, blocker: StepBlocker | undefined, queued: boolean): string => {
    const action = t(direction === 'left' ? 'card.step.left' : 'card.step.right')
    if (target === undefined) return `${action} — ${t('card.step.edge')}`
    const to = statusLabel(target)
    if (blocker !== undefined) {
      return `${action} → ${to} — ${blocker === 'edge' ? t('card.step.edge') : blockerText(blocker)}`
    }
    if (queued) return `${action} → ${to} — ${t('card.step.queued')}`
    return `${action} → ${to}`
  }
  const leftTitle = stepTitleOf('left', leftTarget, leftBlocker, leftQueued)
  const rightTitle = stepTitleOf('right', rightTarget, rightBlocker, rightQueued)

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
        data-has-step={!archived || undefined}
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
        title={transitionErrorTextOf ?? waitingTooltip ?? (task.description !== '' ? task.description : task.title)}
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
          {pendingTransition !== undefined && (
            // The waiting intent stays visible after the detail popup closes:
            // one target per card, the last click wins.
            <span className={css.cardTransition} data-dsh-part="card-transition-queued" title={transitionQueuedTextOf}>
              → {statusLabel(pendingTransition.to)}
            </span>
          )}
          {transitionError !== undefined && (
            <span
              className={css.cardTransition}
              data-error="true"
              data-dsh-part="card-transition-error"
              title={transitionErrorTextOf}
            >
              !
            </span>
          )}
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
        {!archived && releasePending === true && (
          <span className={css.cardRunningLabel} data-dsh-part="card-release-pending">{t('card.releasePending')}</span>
        )}
        {merge !== undefined && (
          // The merge verdict, in the free bottom-left corner: is this result in
          // the base branch, still waiting, resolving a conflict, or failed? A
          // merged card also names when, so the badge carries the fact the human
          // looks for after releasing.
          <span
            className={css.cardMerge}
            data-merge={merge}
            data-dsh-part="card-merge"
            title={merge === 'merged'
              ? `${t('review.mergeTitle')}: ${t(MERGE_KEY[merge])}${task.merge?.mergedAt === undefined ? '' : ` · ${formatHostTimestamp(task.merge.mergedAt, timeZone)}`}`
              : t('review.mergeTitle') + ': ' + t(MERGE_KEY[merge])}
          >
            {t(MERGE_KEY[merge])}
          </span>
        )}
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
      {showStopControl && (
        <button
          type="button"
          className={css.cardPause}
          data-dsh-part="card-stop"
          title={t('card.stopSession')}
          aria-label={t('card.stopSession')}
          onClick={(event) => { event.stopPropagation(); onStopSession(task) }}
          onDoubleClick={(event) => { event.stopPropagation() }}
        >
          <span aria-hidden="true">■</span>
        </button>
      )}
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
      {!archived && (
        // Column steps: one chevron per card edge, always visible (and usable
        // with a keyboard), disabled whenever the adjacent move is not allowed.
        <>
          <CardStepButton
            taskId={task.id}
            direction="left"
            target={leftTarget}
            blocker={leftBlocker}
            disabled={leftDisabled}
            queued={leftQueued}
            title={leftTitle}
            onStep={onStep}
          />
          <CardStepButton
            taskId={task.id}
            direction="right"
            target={rightTarget}
            blocker={rightBlocker}
            disabled={rightDisabled}
            queued={rightQueued}
            title={rightTitle}
            onStep={onStep}
          />
        </>
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
