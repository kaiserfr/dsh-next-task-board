/**
 * Warm-cache retention of archived cards.
 *
 * Archiving a card no longer releases its checkout and stops its conversation
 * right away: both stay reusable for {@link WARM_RETENTION_MS} after the archive
 * stamp, so restoring the card (or continuing it in a follow-up) finds the
 * directory and the session warm instead of paying for a fresh checkout and a
 * fresh conversation. Only after that window has passed AND no card still on the
 * board references them may the Host release the worktree and stop the session.
 *
 * Worktree and session are resources of their own; a card references them by
 * name (its `TaskGit.worktreePath`, its clarification/execution session, and the
 * source conversation of a follow-up). Following the repository's habit, the
 * reference count is **derived**, never stored: a counter would need every
 * archive/restore/follow-up/delete path to keep it in sync, and the day one of
 * them forgets, the board either leaks a checkout or yanks one from under a
 * running follow-up. Scanning the tasks gives the same answer and cannot drift.
 *
 * Two owners of one resource (a source card and its follow-up share the checkout
 * and the conversation) each hold the resource for {@link WARM_RETENTION_MS}
 * after their own archive stamp, so the resource's window ends with the
 * **youngest** archive among its owners.
 */
import type { TaskRecord } from './tasks.ts'

/** How long an archived card's worktree and conversation stay reusable. */
export const WARM_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Session ids a card could continue — the same sources `core/session-reuse.ts`
 * reads: its clarification conversation, the newest execution's session, and the
 * source conversation a follow-up continues. A card whose conversation is in
 * this set keeps that session warm.
 * @param task - the card to read (never mutated).
 */
export function warmSessionIds(task: TaskRecord): string[] {
  const ids = new Set<string>()
  if (task.clarificationSessionId !== undefined) ids.add(task.clarificationSessionId)
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const sessionId = task.executions[index]?.sessionId
    if (sessionId === undefined) continue
    ids.add(sessionId)
    break
  }
  if (task.followUp?.sessionId !== undefined) ids.add(task.followUp.sessionId)
  return [...ids]
}

/**
 * Archived cards whose warm cache may be released now: the retention window of
 * every card sharing their checkout/session has passed, no card still on the
 * board references either resource, and — because a release is all-or-nothing
 * per card — every resource the card names is releasable. Cards with an open run
 * are left alone (the run still owns its worktree and conversation).
 *
 * A card already released (`warmReleasedAt` set) is never listed again; the Host
 * retries a failed worktree removal from its own projection, so this scan can
 * stay a cheap read.
 * @param tasks - the whole ledger.
 * @param now - the current instant (ms epoch).
 * @param retentionMs - the warm window; defaults to {@link WARM_RETENTION_MS}.
 * @returns ids of the archived cards to stamp as released.
 */
export function expiredWarmTaskIds(
  tasks: readonly TaskRecord[],
  now: number,
  retentionMs: number = WARM_RETENTION_MS,
): string[] {
  const liveWorktrees = new Set<string>()
  const liveSessions = new Set<string>()
  for (const task of tasks) {
    // A run that has not settled still owns its checkout and conversation, even
    // when the card was archived while it was open: it is a hard reference for
    // as long as it runs, and the release below leaves it alone.
    if (task.archivedAt !== undefined && !hasOpenExecution(task)) continue
    const path = task.git?.worktreePath
    if (path !== undefined) liveWorktrees.add(path)
    for (const sessionId of warmSessionIds(task)) liveSessions.add(sessionId)
  }

  const worktreeOwners = new Map<string, TaskRecord[]>()
  const sessionOwners = new Map<string, TaskRecord[]>()
  const archived = tasks.filter(task => task.archivedAt !== undefined && task.warmReleasedAt === undefined)
  for (const task of archived) {
    const path = task.git?.worktreePath
    if (path !== undefined) addOwner(worktreeOwners, path, task)
    for (const sessionId of warmSessionIds(task)) addOwner(sessionOwners, sessionId, task)
  }

  const windowPassed = (owners: readonly TaskRecord[]): boolean => {
    let youngest = 0
    for (const owner of owners) youngest = Math.max(youngest, owner.archivedAt ?? 0)
    return now >= youngest + retentionMs
  }
  const disposableWorktrees = new Set<string>()
  for (const [path, owners] of worktreeOwners) {
    if (!liveWorktrees.has(path) && windowPassed(owners)) disposableWorktrees.add(path)
  }
  const disposableSessions = new Set<string>()
  for (const [sessionId, owners] of sessionOwners) {
    if (!liveSessions.has(sessionId) && windowPassed(owners)) disposableSessions.add(sessionId)
  }

  const ids: string[] = []
  for (const task of archived) {
    if (hasOpenExecution(task)) continue
    const path = task.git?.worktreePath
    const sessions = warmSessionIds(task)
    if (path === undefined && sessions.length === 0) continue
    if (path !== undefined && !disposableWorktrees.has(path)) continue
    if (!sessions.every(sessionId => disposableSessions.has(sessionId))) continue
    ids.push(task.id)
  }
  return ids
}

function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined)
}

function addOwner(groups: Map<string, TaskRecord[]>, key: string, task: TaskRecord): void {
  const owners = groups.get(key)
  if (owners === undefined) groups.set(key, [task])
  else owners.push(task)
}
