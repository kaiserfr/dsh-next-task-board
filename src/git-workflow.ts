/**
 * Host-side git integration for the board's agentic-programming flow.
 *
 * Everything here is a no-op unless the card's pinned workspace is a git
 * repository (`repoPath` returns undefined otherwise), so the board keeps
 * working in plain directories:
 *
 * - `backlog` → `clarification` (a human pulls the card in) opens the feature
 *   branch **and the card's own worktree** under `worktreesRoot`: the session
 *   then works in that directory (the runner passes it as the session `cwd`), so
 *   the main checkout stays on whatever the human is using and two cards of one
 *   workspace never share a directory. Where `git worktree` refuses (an older
 *   git, a branch already checked out elsewhere, a leftover directory), the
 *   function falls back to the historical shared checkout — no worktree path on
 *   the card, and every later step checks the branch out as before,
 * - the run works in that worktree, which never changes branch (`useBranch` is a
 *   no-op there),
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
 * The board's WIP limit stays per workspace (WIP lane): one implementation run
 * per workspace. The card's worktree is what makes that limit about *slots*, not
 * about a shared directory — a clarification round of another card of the same
 * workspace no longer has a checkout to fight over.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'
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

/** Options of the git integration. */
export interface GitWorkflowOptions {
  /**
   * Directory the per-card worktrees are created in; one subdirectory per card
   * id. Defaults to `$DSH_HOME/task-board/worktrees`, so the board owns them and
   * nothing appears next to the user's repository.
   */
  worktreesRoot?: string
}

export class GitWorkflow {
  private readonly worktreesRoot: string

  constructor(private readonly registry?: TaskBoardWorkspaceRegistry, options: GitWorkflowOptions = {}) {
    this.worktreesRoot = options.worktreesRoot ?? join(dshHome(), 'task-board', 'worktrees')
  }

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
   * Cut (or re-attach) the task's feature branch and its own worktree. Called on
   * the `backlog` → `clarification` move.
   *
   * A branch that already exists is re-used (a card passing the step again, or a
   * restart) and only gets a worktree when it has none. The worktree is cut from
   * the base branch, so it never carries the main checkout's uncommitted state.
   * When git refuses the worktree, the historical shared checkout is used
   * instead: the card keeps working, just without its own directory.
   */
  openBranch(task: TaskRecord): TaskGit | undefined {
    const repoPath = this.repoPath(task)
    if (repoPath === undefined) return undefined
    const branch = taskBranch(task)
    const base = this.baseBranch(repoPath)
    const worktreePath = this.worktreePath(task)
    // Attached: the card works in its own directory from here on.
    if (this.attachWorktree(repoPath, worktreePath, branch, base)) return { branch, base, repoPath, worktreePath }
    if (this.branchExists(repoPath, branch)) this.run(repoPath, ['checkout', branch])
    else this.run(repoPath, ['checkout', '-b', branch])
    return { branch, base, repoPath }
  }

  /**
   * The card's worktree directory, attached when it is missing: `git worktree
   * add` for a new branch, `git worktree add <path> <branch>` for an existing
   * one (a re-entered step, or a restart). Returns false when git refuses, so
   * the caller can fall back to the shared checkout.
   */
  private attachWorktree(repoPath: string, worktreePath: string, branch: string, base: string): boolean {
    if (existsSync(worktreePath)) {
      // The directory exists: it is either this card's live worktree or a
      // leftover. Only a worktree git knows about counts.
      return this.isWorktreeOf(repoPath, worktreePath)
    }
    try {
      mkdirSync(this.worktreesRoot, { recursive: true })
      if (this.branchExists(repoPath, branch)) this.run(repoPath, ['worktree', 'add', worktreePath, branch])
      else this.run(repoPath, ['worktree', 'add', '-b', branch, worktreePath, base])
      return true
    } catch (error) {
      console.warn(`task board: no worktree for ${branch} (${error instanceof Error ? error.message : String(error)}); working in ${repoPath} instead`)
      return false
    }
  }

  /** Whether git lists `worktreePath` as a worktree of `repoPath`. */
  private isWorktreeOf(repoPath: string, worktreePath: string): boolean {
    try {
      return this.run(repoPath, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .some(line => line.startsWith('worktree ') && line.slice('worktree '.length).trim() === worktreePath)
    } catch {
      return false
    }
  }

  /** Absolute worktree directory of a card: one per card id. */
  private worktreePath(task: TaskRecord): string {
    const id = task.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
    return join(this.worktreesRoot, id === '' ? 'task' : id)
  }

  /**
   * Where the card's work happens right now: its worktree when that directory
   * exists (the branch is fixed there, so no checkout), otherwise the main
   * checkout (which the caller has to put on the card's branch).
   */
  private workDir(git: TaskGit): { dir: string; checkout: boolean } {
    if (git.worktreePath !== undefined && existsSync(git.worktreePath)) return { dir: git.worktreePath, checkout: false }
    return { dir: git.repoPath, checkout: true }
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
    const { dir, checkout } = this.workDir(git)
    // The commit belongs on the card's branch, whatever HEAD happens to be: a
    // run that skipped the pull may still sit on the base branch. A worktree
    // already stands on that branch.
    if (checkout) this.run(dir, ['checkout', git.branch])
    if (!this.isDirty(dir)) return { ...git, reviewedCommit: this.head(dir) }
    this.run(dir, ['add', '-A'])
    this.run(dir, ['commit', '-m', `task: ${task.title}`])
    return { ...git, committedAt: now, reviewedCommit: this.head(dir) }
  }

  /**
   * Put the card's branch in place before it runs. A card with its own worktree
   * needs nothing: that directory stands on its branch already and switching
   * branches there is exactly the yank the worktree exists to prevent.
   */
  useBranch(task: TaskRecord): void {
    const git = task.git
    if (git === undefined) return
    const { checkout } = this.workDir(git)
    if (!checkout) return
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
    const { dir, checkout } = this.workDir(git)
    if (this.isDirty(dir)) {
      throw new Error(`merge refused: ${dir} still holds uncommitted work, so the reviewed commit ${short(git.reviewedCommit)} is not what the worktree shows; park the card in "Ready for test" again`)
    }
    if (checkout) this.run(dir, ['checkout', git.branch])
    const head = this.head(dir)
    if (head !== git.reviewedCommit) {
      throw new Error(`merge refused: ${git.branch} moved from the reviewed commit ${short(git.reviewedCommit)} to ${short(head)}; review the new state (park the card again) before merging`)
    }
    // The merge itself happens in the main checkout, on the base branch: a
    // worktree never has the base checked out.
    this.run(git.repoPath, ['checkout', git.base])
    this.run(git.repoPath, ['merge', '--no-ff', '-m', `merge ${git.branch} (task board)`, git.branch])
    this.removeWorktree(git)
    return { ...git, mergedAt: now }
  }

  /**
   * Drop the card's worktree after its branch was merged: the directory was
   * disposal-only from the start (the branch, the commits and the review stamp
   * all survive in the repository). A worktree git refuses to remove — untracked
   * build artifacts, a lock — is left alone and never fails the accept.
   */
  private removeWorktree(git: TaskGit): void {
    if (git.worktreePath === undefined || !existsSync(git.worktreePath)) return
    try {
      this.run(git.repoPath, ['worktree', 'remove', '--force', git.worktreePath])
    } catch (error) {
      console.warn(`task board: could not remove worktree ${git.worktreePath} (${error instanceof Error ? error.message : String(error)})`)
    }
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
