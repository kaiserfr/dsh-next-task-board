/**
 * Review block of the card detail: everything the manual check of a new version
 * needs, and only for cards standing in the review column.
 *
 * The block is one card's own story: where the version lives (its worktree, or
 * the main checkout when it has none), how to open it in the editor, what the
 * branch and the reviewed commit are, where the running version answers, and the
 * controls that start, stop, restart and read it. Every control addresses this
 * card — its directory, its compose project, its configured command environment
 * — never a global instance.
 *
 * Where the *plan* comes from: the Host derives it per read (directory on disk,
 * compose file, workspace entry) and ships it with the snapshot, so this
 * component never guesses a path or offers a button that could not work. The
 * live state (running since when, links, last error) is the card's own `review`
 * record; the logs and the diff are read on demand.
 */
import { useCallback, useEffect, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { mergeStateOf, type MergeState } from '../../core/merge.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import css from '../board.module.css'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { formatHostTimestamp } from './TaskCard.tsx'

/**
 * How many log lines the modal announces. Compose logs are trimmed to exactly
 * this many by the Host (`COMPOSE_LOG_TAIL`); a workspace's own `logs` command
 * prints whatever it was told to print, so the label is an upper bound for it.
 */
const REVIEW_LOG_LINES = 200

/** Wording of one merge state inside the review block. */
const MERGE_KEY: Record<MergeState, TaskBoardKey> = {
  merged: 'review.merge.merged',
  unmerged: 'review.merge.unmerged',
  released: 'review.merge.released',
  resolving: 'review.merge.resolving',
  failed: 'review.merge.failed',
  'no-branch': 'review.merge.noBranch',
}

function shortCommit(commit: string): string {
  return commit.length > 10 ? commit.slice(0, 10) : commit
}

export function ReviewSection({ controller, task, timeZone }: {
  controller: BoardController
  task: TaskRecord
  timeZone?: string
}) {
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())
  useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller])
  const [logs, setLogs] = useState<{ text?: string; error?: string } | undefined>(undefined)
  const [diff, setDiff] = useState<{ text?: string; error?: string } | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** The release asks before it merges: the card leaves the column for good. */
  const [confirmRelease, setConfirmRelease] = useState(false)

  const plan = snapshot.host?.reviewPlans?.[task.id]
  const canRead = snapshot.canReviewRead === true
  const review = task.review
  const running = review?.startedAt !== undefined
  // An action in flight is queued, not a fence: start/stop/restart and the
  // release stay clickable (a second click waits behind the first on the Host).
  // Only a status that really forbids the control (nothing running, a merge
  // being resolved) disables it.
  const busy = false
  const releasePending = snapshot.host?.pendingReleases?.[task.id]

  const openEditor = useCallback(async (): Promise<void> => {
    setNotice(undefined)
    const result = await controller.openWorktree(task.id)
    setNotice(result.ok ? t('review.editorStarted', { path: result.text ?? '' }) : result.error ?? t('review.unknownError'))
  }, [controller, task.id])

  const showLogs = useCallback(async (): Promise<void> => {
    setLogs({})
    const result = await controller.loadReviewLogs(task.id)
    setLogs(result.ok ? { text: result.text ?? '' } : { error: result.error ?? t('review.unknownError') })
  }, [controller, task.id])

  const showDiff = useCallback(async (): Promise<void> => {
    setDiff({})
    const result = await controller.loadReviewDiff(task.id)
    setDiff(result.ok ? { text: result.text ?? '' } : { error: result.error ?? t('review.unknownError') })
  }, [controller, task.id])

  // The environment controls and the release exist for the review column only.
  // A card whose release failed keeps showing the merge verdict and the reason —
  // that is what the human writes the correction about — but nothing that the
  // Host would refuse outside the column.
  const inReview = task.status === 'ready_for_test' && task.archivedAt === undefined
  if (!inReview && !(task.status === 'failed' && task.merge !== undefined)) return null

  const git = task.git
  const merge = mergeStateOf(task)
  const mergeTime = task.merge?.mergedAt ?? git?.mergedAt
  const statusLine = plan?.pending === 'start'
    ? t('review.starting')
    : plan?.pending === 'stop'
      ? t('review.stopping')
      : plan?.pending === 'restart'
        ? t('review.restarting')
        : running
          ? t('review.running', { time: review?.startedAt === undefined ? '—' : formatHostTimestamp(review.startedAt, timeZone) })
          : review?.stoppedAt !== undefined
            ? t('review.stopped', { time: formatHostTimestamp(review.stoppedAt, timeZone) })
            : t('review.never')

  return (
    <section className={css.detailSection} data-dsh-part="review">
      <h4>{inReview ? t('review.title') : t('review.mergeTitle')}</h4>

      {/* The merge verdict and the release: what the whole review is for. Shown
          for every card in the column — a card without a branch is released the
          same way (it just has nothing to merge), which the state says. */}
      <p className={css.detailMeta} data-dsh-part="review-merge" data-merge={merge ?? 'none'}>
        {merge === undefined ? t('review.merge.unmerged') : t(MERGE_KEY[merge], mergeTime === undefined ? {} : { time: formatHostTimestamp(mergeTime, timeZone) })}
        {task.merge?.commit !== undefined && ` · ${t('review.merge.commit', { commit: shortCommit(task.merge.commit) })}`}
        {task.merge !== undefined && ` · ${t('review.merge.releasedAt', { time: formatHostTimestamp(task.merge.releasedAt, timeZone) })}`}
        {task.merge?.resolvedAt !== undefined && ` · ${t('review.merge.resolvedAt', { time: formatHostTimestamp(task.merge.resolvedAt, timeZone) })}`}
      </p>
      {task.merge?.conflict !== undefined && (
        <p className={css.detailMeta}>{t('review.merge.conflict', { conflict: task.merge.conflict })}</p>
      )}
      {task.merge?.error !== undefined && (
        <p className={css.formError}>{t('review.merge.error', { error: task.merge.error })}</p>
      )}
      {releasePending !== undefined && (
        // The release runs in the background: the card stays in this column and
        // this derived marker explains why, with or without a review environment.
        <p className={css.detailMeta} data-dsh-part="release-pending" data-state="release" role="status">
          {t('review.releasePending')}
        </p>
      )}
      {inReview && (
        <div className={css.moveRow}>
          <button
            type="button"
            data-action="release"
            className={css.primaryButton}
            disabled={busy || merge === 'resolving'}
            title={t('review.releaseHint')}
            onClick={() => { setConfirmRelease(true) }}
          >
            {t('review.release')}
          </button>
        </div>
      )}

      {!inReview ? null : plan?.dir === undefined ? (
        <p className={css.detailText}>{t('review.notConfigured')}</p>
      ) : (
        <>
          <p className={css.detailMeta}>{plan.worktree === true ? t('review.worktree') : t('review.mainCheckout')}</p>
          <p className={css.detailText} title={plan.dir}>
            {t('review.path', { path: plan.dir })}
          </p>
          {canRead && (
            <div className={css.moveRow}>
              <button
                type="button"
                data-action="editor"
                className={css.ghostButton}
                title={t('review.openEditorHint')}
                onClick={() => { void openEditor() }}
              >
                {t('review.openEditor')}
              </button>
            </div>
          )}
          {notice !== undefined && <p className={css.detailMeta}>{notice}</p>}

          {git !== undefined && (
            <p className={css.detailText}>
              {t('review.branch', { branch: git.branch })}
              {' · '}{t('review.base', { base: git.base })}
              {git.reviewedCommit !== undefined && ` · ${t('review.reviewedCommit', { commit: shortCommit(git.reviewedCommit) })}`}
            </p>
          )}
          {canRead && git?.reviewedCommit !== undefined && (
            <div className={css.moveRow}>
              <button type="button" data-action="diff" className={css.linkButton} onClick={() => { void showDiff() }}>
                {t('review.diff')}
              </button>
            </div>
          )}
          {diff !== undefined && (
            <div className={css.detailSection} data-dsh-part="review-diff">
              {diff.error !== undefined
                ? <p className={css.formError}>{diff.error}</p>
                : diff.text === undefined
                  ? <p className={css.detailMeta}>{t('review.pendingAction')}</p>
                  : (
                    <>
                      <p className={css.detailMeta}>
                        {t('review.diffTitle', {
                          base: git?.base ?? '',
                          commit: shortCommit(git?.reviewedCommit ?? ''),
                        })}
                      </p>
                      <pre className={css.promptBlock}>{diff.text.trim() === '' ? t('review.diffEmpty') : diff.text}</pre>
                    </>
                  )}
            </div>
          )}

          <p className={css.detailMeta} data-dsh-part="review-status" data-state={plan?.pending ?? (running ? 'running' : 'stopped')}>
            {statusLine}
            {review !== undefined && ` · ${review.mode === 'compose' ? t('review.compose', { project: review.source }) : t('review.commandEnv', { source: review.source })}`}
          </p>
          {review?.error !== undefined && <p className={css.formError}>{t('review.error', { error: review.error })}</p>}
          {review?.ports !== undefined && review.ports.length > 0 && (
            <p className={css.detailMeta}>{t('review.ports', { ports: review.ports.join(' · ') })}</p>
          )}
          {running && review?.links !== undefined && review.links.length > 0 && (
            <ul className={css.executionList} data-dsh-part="review-links">
              {review.links.map(link => (
                <li key={link} className={css.executionRow}>
                  <a className={css.linkButton} data-action="app-link" href={link} target="_blank" rel="noreferrer" title={link}>
                    {t('review.appLink')} ↗
                  </a>
                  <span className={css.executionTimes}>{link}</span>
                </li>
              ))}
            </ul>
          )}

          {plan?.available !== true ? (
            <p className={css.detailText}>{t('review.notConfigured')}</p>
          ) : canRead ? (
            <div className={css.moveRow}>
              <button
                type="button"
                data-action="start"
                className={css.primaryButton}
                disabled={busy || running}
                onClick={() => { void controller.reviewStart(task.id) }}
              >
                {t('review.start')}
              </button>
              <button
                type="button"
                data-action="stop"
                className={css.ghostButton}
                disabled={busy || !running}
                onClick={() => { void controller.reviewStop(task.id) }}
              >
                {t('review.stop')}
              </button>
              <button
                type="button"
                data-action="restart"
                className={css.ghostButton}
                disabled={busy}
                onClick={() => { void controller.reviewRestart(task.id) }}
              >
                {t('review.restart')}
              </button>
              {plan.logs === true && (
                <button
                  type="button"
                  data-action="logs"
                  className={css.ghostButton}
                  disabled={busy}
                  onClick={() => { void showLogs() }}
                >
                  {t('review.logs')}
                </button>
              )}
            </div>
          ) : (
            <p className={css.detailText}>{t('review.unavailable')}</p>
          )}
        </>
      )}

      {logs !== undefined && (
        <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) setLogs(undefined) }}>
          <div className={css.modal} role="dialog" aria-label={t('review.logs')} data-dsh-part="review-logs">
            <h2 className={css.modalTitle}>{t('review.logsTitle', { lines: String(REVIEW_LOG_LINES) })}</h2>
            {logs.error !== undefined
              ? <p className={css.formError}>{logs.error}</p>
              : logs.text === undefined
                ? <p className={css.detailMeta}>{t('review.pendingAction')}</p>
                : <pre className={css.promptBlock}>{logs.text.trim() === '' ? t('review.never') : logs.text}</pre>}
            <footer className={css.modalFooter}>
              <button type="button" className={css.ghostButton} onClick={() => { void showLogs() }}>
                {t('review.logsRefresh')}
              </button>
              <button type="button" className={css.primaryButton} onClick={() => { setLogs(undefined) }}>
                {t('review.logsClose')}
              </button>
            </footer>
          </div>
        </div>
      )}
      {confirmRelease && (
        <ConfirmDialog
          title={t('review.releaseTitle')}
          message={t('review.releaseMessage', { base: git?.base ?? 'main' })}
          confirmLabel={t('review.releaseConfirm')}
          onCancel={() => { setConfirmRelease(false) }}
          onConfirm={() => {
            setConfirmRelease(false)
            void controller.approveMerge(task.id)
          }}
        />
      )}
    </section>
  )
}
