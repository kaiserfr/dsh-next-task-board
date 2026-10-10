/**
 * Host-side git integration for the board's agentic-programming flow.
 *
 * Everything here is a no-op unless the card's pinned workspace is a git
 * worktree (`repoPath` returns undefined otherwise), so the board keeps
 * working in plain directories:
 *
 * - `backlog` → `todo` (a human pulls the card in) opens the feature branch,
 * - `running` checks the feature branch out before the agent session starts,
 * - reaching `ready_for_test` commits what the run left behind onto the feature
 *   branch (`git.commitBranch`, and the runner's own settle), so no run's work
 *   ever waits uncommitted in the worktree, and stamps the resulting head as the
 *   card's `reviewedCommit` — the commit the human reviews,
 * - `ready_for_test` → `done` (a human accepts the work) merges the feature
 *   branch back into its base branch, but **only** while the branch still
 *   stands exactly on that reviewed commit and the worktree is clean: work
 *   committed after the review makes the approval stale and the merge refuses
 *   instead of merging something nobody reviewed.
 *
 * The board's WIP limit is per workspace (WIP lane), so two *implementation*
 * runs of one workspace never overlap and one shared worktree per workspace is
 * enough; different workspaces have their own worktrees and `useBranch` targets
 * the card's own. A clarification run (`todo`) may start next to a working run,
 * but it checks no branch out at all (see `TaskBoardHostService.launch`), so the
 * checkout stays with the run that is working.
 */
import { spawnSync } from 'node:child_process'
import type { TaskGit, TaskRecord } from './core/tasks.ts'
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts'

/** Namespace of the feature branches the board opens. */
export const TASK_BRANCH_PREFIX = 'task/'

/** Base branches probed when HEAD is already on a board-opened branch. */
const FALLBACK_BASE_BRANCHES = ['main', 'master'] as const

/** Lowercase, dash-separated branch-name fragment of a task title. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/** Short form of a commit sha, for messages a human reads on the board. */
function short(sha: string): string {
  return sha.slice(0, 8)
}

/** Feature branch name of a task: `task/<title-slug>-<id8>`. */
export function taskBranch(task: TaskRecord): string {
  const name = slug(task.title)
  const id = task.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  return `${TASK_BRANCH_PREFIX}${name === '' ? '' : `${name}-`}${id}`
}

export class GitWorkflow {
  constructor(private readonly registry?: TaskBoardWorkspaceRegistry) {}

  private run(cwd: string, args: readonly string[]): string {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
    if (result.error !== undefined) throw new Error(`git ${args[0]} failed: ${result.error.message}`)
    if (result.status !== 0) {
      const detail = `${result.stderr}${result.stdout}`.trim()
      throw new Error(`git ${args.join(' ')} failed in ${cwd}${detail === '' ? '' : `: ${detail}`}`)
    }
    return result.stdout
  }

  /** Worktree of the task's pinned workspace when it is a git repository. */
  repoPath(task: TaskRecord): string | undefined {
    const workspaceId = task.handover?.workspaceId ?? task.workspaceId
    if (workspaceId === undefined || this.registry === undefined) return undefined
    const workspace = this.registry.list().find(item => item.id === workspaceId)
    if (workspace === undefined) return undefined
    try {
      return this.run(workspace.path, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
        ? workspace.path
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Cut (or re-check-out) the task's feature branch, cut from the current
   * branch. Called on the `backlog` → `todo` move.
   */
  openBranch(task: TaskRecord): TaskGit | undefined {
    const repoPath = this.repoPath(task)
    if (repoPath === undefined) return undefined
    const branch = taskBranch(task)
    const base = this.baseBranch(repoPath)
    if (this.branchExists(repoPath, branch)) this.run(repoPath, ['checkout', branch])
    else this.run(repoPath, ['checkout', '-b', branch])
    return { branch, base, repoPath }
  }

  /**
   * Commit what the worktree holds onto the card's feature branch, stamping
   * `committedAt`. Called whenever a card reaches `ready_for_test` — the
   * configurable `git.commitBranch` action and the runner settling a run there
   * — so no run's work is ever left uncommitted in the worktree, no matter
   * whether the run succeeded, failed or was cancelled.
   *
   * A card that never had a branch (it skipped `todo`, or a cron/button start)
   * gets one cut first, so the commit has a branch to land on. An already-clean
   * worktree is left alone: no empty commit, and `committedAt` keeps the last
   * instant something was actually committed.
   *
   * Either way the head the card now stands on is stamped as `reviewedCommit`:
   * parking binds the review to exactly this commit, and `mergeBranch` refuses
   * to merge anything else (see there).
   * @param task - the card whose work is being parked.
   * @param now - commit instant to stamp on the returned state.
   * @returns the git state stamped with `committedAt`/`reviewedCommit`, or
   *   undefined without a repository.
   */
  commitBranch(task: TaskRecord, now: number): TaskGit | undefined {
    const git = task.git ?? this.openBranch(task)
    if (git === undefined) return undefined
    // The commit belongs on the card's branch, whatever HEAD happens to be: a
    // run that skipped the `todo` pull may still sit on the base branch.
    this.run(git.repoPath, ['checkout', git.branch])
    if (!this.isDirty(git.repoPath)) return { ...git, reviewedCommit: this.head(git.repoPath) }
    this.run(git.repoPath, ['add', '-A'])
    this.run(git.repoPath, ['commit', '-m', `task: ${task.title}`])
    return { ...git, committedAt: now, reviewedCommit: this.head(git.repoPath) }
  }

  /** Check out the task's recorded feature branch before it runs. */
  useBranch(task: TaskRecord): void {
    const git = task.git
    if (git === undefined) return
    this.run(git.repoPath, ['checkout', git.branch])
  }

  /**
   * Merge the card's feature branch back into the base branch — but only the
   * exact commit the human reviewed. Called on the `ready_for_test` → `done`
   * move; an already-merged branch is left alone.
   *
   * The gate (fail-closed, and the whole point of `reviewedCommit`):
   *
   * - a worktree that still holds uncommitted work is refused instead of being
   *   committed behind the review's back,
   * - a card without a reviewed commit (parked before this gate existed, or by
   *   a custom machine that skips `git.commitBranch`) is refused: the human has
   *   to park it again, which binds the approval to a concrete commit,
   * - a branch that moved past the reviewed commit (a commit landed after the
   *   review) is refused: the review has to be redone.
   *
   * Every refusal is thrown, so the ledger refuses the move and the card stays
   * in `ready_for_test`.
   * @param task - the card being accepted.
   * @param now - merge instant to stamp on the returned state.
   * @returns the git state stamped with `mergedAt`, or undefined without one.
   */
  mergeBranch(task: TaskRecord, now: number): TaskGit | undefined {
    const git = task.git
    if (git === undefined || git.mergedAt !== undefined) return undefined
    if (git.reviewedCommit === undefined) {
      throw new Error(`merge refused: ${git.branch} has no reviewed commit; park the card in "Ready for test" again so the approval is bound to the commit you reviewed`)
    }
    if (this.isDirty(git.repoPath)) {
      throw new Error(`merge refused: ${git.repoPath} still holds uncommitted work, so the reviewed commit ${short(git.reviewedCommit)} is not what the worktree shows; park the card in "Ready for test" again`)
    }
    this.run(git.repoPath, ['checkout', git.branch])
    const head = this.head(git.repoPath)
    if (head !== git.reviewedCommit) {
      throw new Error(`merge refused: ${git.branch} moved from the reviewed commit ${short(git.reviewedCommit)} to ${short(head)}; review the new state (park the card again) before merging`)
    }
    this.run(git.repoPath, ['checkout', git.base])
    this.run(git.repoPath, ['merge', '--no-ff', '-m', `merge ${git.branch} (task board)`, git.branch])
    return { ...git, mergedAt: now }
  }

  /**
   * Branch a new feature branch starts from: HEAD while it is a normal branch,
   * otherwise the repository's main branch (a second card pulled into `todo`
   * while the first is still under review must not nest on the first card's
   * branch).
   */
  private baseBranch(repoPath: string): string {
    const current = this.run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    if (!current.startsWith(TASK_BRANCH_PREFIX)) return current
    for (const candidate of FALLBACK_BASE_BRANCHES) {
      if (this.branchExists(repoPath, candidate)) return candidate
    }
    return current
  }

  private branchExists(repoPath: string, branch: string): boolean {
    try {
      this.run(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  private isDirty(repoPath: string): boolean {
    return this.run(repoPath, ['status', '--porcelain']).trim() !== ''
  }

  /** Full SHA of the worktree's current head. */
  private head(repoPath: string): string {
    return this.run(repoPath, ['rev-parse', 'HEAD']).trim()
  }
}
