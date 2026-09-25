/**
 * Host-side git integration for the board's agentic-programming flow.
 *
 * Everything here is a no-op unless the card's pinned workspace is a git
 * worktree (`repoPath` returns undefined otherwise), so the board keeps
 * working in plain directories:
 *
 * - `backlog` → `todo` (a human pulls the card in) opens the feature branch,
 * - `running` checks the feature branch out before the agent session starts,
 * - `ready_for_test` → `done` (a human accepts the work) commits what the run
 *   left behind and merges the feature branch back into its base branch.
 *
 * The board's WIP limit is per workspace (WIP lane), so runs of one workspace
 * never overlap and one shared worktree per workspace is enough; different
 * workspaces have their own worktrees and `useBranch` targets the card's own.
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

  /** Check out the task's recorded feature branch before it runs. */
  useBranch(task: TaskRecord): void {
    const git = task.git
    if (git === undefined) return
    this.run(git.repoPath, ['checkout', git.branch])
  }

  /**
   * Commit what the run left behind on the feature branch and merge it back
   * into the base branch. Called on the `ready_for_test` → `done` move; an
   * already-merged branch is left alone.
   * @param task - the card being accepted.
   * @param now - merge instant to stamp on the returned state.
   * @returns the git state stamped with `mergedAt`, or undefined without one.
   */
  mergeBranch(task: TaskRecord, now: number): TaskGit | undefined {
    const git = task.git
    if (git === undefined || git.mergedAt !== undefined) return undefined
    if (this.isDirty(git.repoPath)) {
      this.run(git.repoPath, ['add', '-A'])
      this.run(git.repoPath, ['commit', '-m', `task: ${task.title}`])
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
}
