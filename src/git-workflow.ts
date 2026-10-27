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
 * - `ready_for_test` → `done` (a human accepts the work) **replays** the feature
 *   branch onto its base branch as that stands *now* (`git rebase` — other cards
 *   may have merged into it since this card was cut) and then merges the branch
 *   back, but **only** while the branch still stands exactly on that reviewed
 *   commit and the worktree is clean: work committed after the review makes the
 *   approval stale and the release refuses instead of replaying something nobody
 *   reviewed. A replay that conflicts is left in the card's own worktree for the
 *   card's agent ({@link GitWorkflow.mergeBranch}),
 * - the worktree outlives the merge: a done card may be pulled back out of
 *   `done` (reactivated or reworked), and that run needs its own checkout. The
 *   directory is only released when the card leaves the board for good —
 *   archiving or deleting it ({@link GitWorkflow.releaseWorktree}).
 *
 * The board's WIP limit stays per workspace (WIP lane): one implementation run
 * per workspace. The card's worktree is what makes that limit about *slots*, not
 * about a shared directory — a clarification round of another card of the same
 * workspace no longer has a checkout to fight over.
 *
 * A workspace directory that is not itself a repository is resolved through the
 * `repoSubpath` setting ({@link GitWorkflow.configure}): the entry that governs
 * the workspace names the repository directory inside it, so a project whose
 * repository is one subdirectory deep still gets the whole branch/worktree/merge
 * flow.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { CommandRunner } from './command-runner.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import { findRepoSubpath, parseRepoSubpaths, resolveRepoDirectory, type RepoSubpathConfig } from './core/repo-config.ts'
import type { TaskGit, TaskRecord } from './core/tasks.ts'
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts'

/** Namespace of the feature branches the board opens. */
export const TASK_BRANCH_PREFIX = 'task/'

/** Base branches probed when HEAD is already on a board-opened branch. */
const FALLBACK_BASE_BRANCHES = ['main', 'master'] as const

/**
 * Upper bound for one heavy git command (worktree add, add -A, commit, rebase,
 * merge). This is a Host safety net against a wedged child process, not a user
 * timeout: the UI never waits on the request and never sees this number. A
 * release that takes longer than this fails visibly on the card.
 */
const HEAVY_GIT_TIMEOUT_MS = 10 * 60_000

/** Lowercase, dash-separated branch-name fragment of a task title. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/** Short form of a commit sha, for messages a human reads on the board. */
function short(sha: string): string {
  return sha.slice(0, 8)
}

/**
 * A conflict the release ran into: thrown by {@link GitWorkflow.mergeBranch}
 * when the replay of the card's branch onto the base branch conflicts. The
 * replay is deliberately left in place in the card's own directory (conflict
 * markers, a rebase waiting to be continued), so the ledger can hand the
 * conflict to the card's agent instead of failing the release outright. The
 * class is the signal — a refusal (a dirty worktree, a moved branch) stays an
 * ordinary error and never starts a run.
 */
export class MergeConflictError extends Error {
  constructor(message: string, readonly files: readonly string[]) {
    super(message)
    this.name = 'MergeConflictError'
  }
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
  /**
   * Runner for the heavy git commands. The Host injects the worker-backed
   * runner, so worktree creation, commits, rebases and merges run off its
   * event loop and can be cancelled per card. Absent: the in-process spawn
   * this class always used (tests, source checkouts).
   */
  runner?: CommandRunner
}

export class GitWorkflow {
  private readonly worktreesRoot: string
  private readonly runner?: CommandRunner
  /** `repoSubpath` entries in force (see {@link configure}). */
  private repoSubpaths: RepoSubpathConfig[] = []
  /** Parse reasons of the last {@link configure}, for the settings card. */
  private repoSubpathErrors: string[] = []

  constructor(private readonly registry?: TaskBoardWorkspaceRegistry, options: GitWorkflowOptions = {}) {
    this.worktreesRoot = options.worktreesRoot ?? join(dshHome(), 'task-board', 'worktrees')
    this.runner = options.runner
  }

  /**
   * Apply the `repoSubpath` setting: one entry per workspace directory, naming
   * the repository inside it. Invalid entries are reported with a reason and
   * dropped, exactly like `reviewEnvironments`.
   * @param value - raw setting (JSON text or the parsed array).
   * @returns the reasons of every entry that was refused (empty when all parsed).
   */
  configure(value: unknown): string[] {
    const parsed = parseRepoSubpaths(value)
    this.repoSubpaths = parsed.entries
    this.repoSubpathErrors = parsed.errors
    return parsed.errors
  }

  /** Reasons of the last {@link configure} (empty when it parsed). */
  get configurationErrors(): readonly string[] {
    return this.repoSubpathErrors
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

  /**
   * Run one git command **without blocking the event loop** (`spawn`, not
   * `spawnSync`). This is what keeps `/parse`, `/state` and the SSE stream
   * answering while a worktree is created, a commit is built or a branch is
   * replayed and merged. The promise settles on the child's exit; the bounded
   * timeout only protects against a wedged child.
   */
  private runAsync(cwd: string, args: readonly string[], scope?: string): Promise<string> {
    if (this.runner !== undefined) return this.runViaRunner(this.runner, cwd, args, scope)
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const finish = (error: Error | undefined, output: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) resolve(output)
        else reject(error)
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(new Error(`git ${args.join(' ')} timed out after ${Math.round(HEAVY_GIT_TIMEOUT_MS / 1000)}s in ${cwd}`), '')
      }, HEAVY_GIT_TIMEOUT_MS)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', error => {
        finish(new Error(`git ${args[0]} failed: ${error.message}`), '')
      })
      child.once('close', code => {
        if (code === 0) {
          finish(undefined, stdout)
          return
        }
        const detail = `${stderr}${stdout}`.trim()
        finish(new Error(`git ${args.join(' ')} failed in ${cwd}${detail === '' ? '' : `: ${detail}`}`), '')
      })
    })
  }

  /**
   * One heavy git command through the injected runner: the worker thread owns
   * the child, the deadline and the card-scoped cancellation. A cancelled
   * command is an ordinary failure for the caller (the ledger records it on the
   * card), so the error text names the cancellation instead of a git exit code.
   */
  private async runViaRunner(runner: CommandRunner, cwd: string, args: readonly string[], scope?: string): Promise<string> {
    const result = await runner.run({
      command: 'git',
      args,
      cwd,
      timeoutMs: HEAVY_GIT_TIMEOUT_MS,
      ...(scope === undefined ? {} : { scope }),
    })
    if (result.aborted) throw new Error(`git ${args.join(' ')} was cancelled in ${cwd}`)
    if (result.timedOut) throw new Error(`git ${args.join(' ')} timed out after ${Math.round(HEAVY_GIT_TIMEOUT_MS / 1000)}s in ${cwd}`)
    if (result.code !== 0) {
      const detail = `${result.stderr}${result.stdout}`.trim()
      throw new Error(`git ${args.join(' ')} failed in ${cwd}${detail === '' ? '' : `: ${detail}`}`)
    }
    return result.stdout
  }

  /** Whether `dir` is inside a git work tree. */
  private isRepository(dir: string): boolean {
    try {
      return this.run(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
    } catch {
      return false
    }
  }

  /**
   * Repository directory of one workspace: the workspace itself when it is a
   * repository, otherwise the `repoSubpath` entry that governs it (when one is
   * configured and really is a repository). Undefined when the workspace has no
   * repository at all — the git flow is then the historical no-op.
   */
  repositoryOf(workspacePath: string): string | undefined {
    if (this.isRepository(workspacePath)) return workspacePath
    const entry = findRepoSubpath(this.repoSubpaths, workspacePath)
    if (entry === undefined) return undefined
    const resolved = resolveRepoDirectory(entry)
    if (!existsSync(resolved) || !this.isRepository(resolved)) return undefined
    return resolved
  }

  /** Worktree of the task's pinned workspace when it is a git repository. */
  repoPath(task: TaskRecord): string | undefined {
    const workspaceId = task.handover?.workspaceId ?? task.workspaceId
    if (workspaceId === undefined || this.registry === undefined) return undefined
    const workspace = this.registry.list().find(item => item.id === workspaceId)
    if (workspace === undefined || typeof workspace.path !== 'string') return undefined
    return this.repositoryOf(workspace.path)
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
  async openBranch(task: TaskRecord): Promise<TaskGit | undefined> {
    const repoPath = this.repoPath(task)
    if (repoPath === undefined) return undefined
    const branch = taskBranch(task)
    const base = this.baseBranch(repoPath)
    const worktreePath = this.worktreePath(task)
    // Attached: the card works in its own directory from here on.
    if (await this.attachWorktree(repoPath, worktreePath, branch, base, task.id)) return { branch, base, repoPath, worktreePath }
    if (this.branchExists(repoPath, branch)) await this.runAsync(repoPath, ['checkout', branch], task.id)
    else await this.runAsync(repoPath, ['checkout', '-b', branch], task.id)
    return { branch, base, repoPath }
  }

  /**
   * The card's worktree directory, attached when it is missing: `git worktree
   * add` for a new branch, `git worktree add <path> <branch>` for an existing
   * one (a re-entered step, or a restart). Returns false when git refuses, so
   * the caller can fall back to the shared checkout.
   */
  private async attachWorktree(repoPath: string, worktreePath: string, branch: string, base: string, scope?: string): Promise<boolean> {
    if (existsSync(worktreePath)) {
      // The directory exists: it is either this card's live worktree or a
      // leftover. Only a worktree git knows about counts.
      return this.isWorktreeOf(repoPath, worktreePath)
    }
    try {
      mkdirSync(this.worktreesRoot, { recursive: true })
      if (this.branchExists(repoPath, branch)) await this.runAsync(repoPath, ['worktree', 'add', worktreePath, branch], scope)
      else await this.runAsync(repoPath, ['worktree', 'add', '-b', branch, worktreePath, base], scope)
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
   * A card that never had a branch (it skipped `clarification`, or a cron/button
   * start) gets one cut first, so the commit has a branch to land on. An already-clean
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
  async commitBranch(task: TaskRecord, now: number): Promise<TaskGit | undefined> {
    const git = task.git ?? await this.openBranch(task)
    if (git === undefined) return undefined
    const { dir, checkout } = this.workDir(git)
    // The commit belongs on the card's branch, whatever HEAD happens to be: a
    // run that skipped the pull may still sit on the base branch. A worktree
    // already stands on that branch.
    if (checkout) await this.runAsync(dir, ['checkout', git.branch], task.id)
    // An unfinished conflict resolution is never committed: `git add -A` would
    // stage the conflict markers as if they were the resolution, and a commit
    // inside a running rebase would derail it. The card keeps its previous
    // review stamp, and the release fails visibly instead.
    if (this.unmergedFiles(dir).length > 0 || this.rebaseInProgress(dir)) return git
    if (!this.isDirty(dir)) return { ...git, reviewedCommit: this.head(dir) }
    await this.runAsync(dir, ['add', '-A'], task.id)
    await this.runAsync(dir, ['commit', '-m', `task: ${task.title}`], task.id)
    return { ...git, committedAt: now, reviewedCommit: this.head(dir) }
  }

  /**
   * Put the card's branch in place before it runs. A card with its own worktree
   * needs nothing: that directory stands on its branch already and switching
   * branches there is exactly the yank the worktree exists to prevent.
   */
  async useBranch(task: TaskRecord): Promise<void> {
    const git = task.git
    if (git === undefined) return
    const { checkout } = this.workDir(git)
    if (!checkout) return
    await this.runAsync(git.repoPath, ['checkout', git.branch], task.id)
  }

  /**
   * Merge the card's feature branch back into the base branch — but only the
   * exact commit the human reviewed. Called by the release path (the
   * `ready_for_test` → `done` move and the card's release action); an
   * already-merged branch is left alone.
   *
   * Before anything is merged, the branch is **replayed onto the base as it
   * stands now** (`git rebase`, see {@link GitWorkflow.rebaseOnto}): this card
   * was cut from the base when it was pulled in, and other cards may have merged
   * into that base since. Without the replay the reviewed work would meet the
   * current base only inside the final merge commit — a clean text merge that
   * nobody ever built or ran against the new base.
   *
   * The gate (fail-closed, and the whole point of `reviewedCommit`):
   *
   * - a worktree that still holds uncommitted work is refused instead of being
   *   committed behind the review's back,
   * - a card without a reviewed commit (parked before this gate existed, or by
   *   a custom machine that skips `git.commitBranch`) is refused: the human has
   *   to park it again, which binds the approval to a concrete commit,
   * - a branch that moved past the reviewed commit (a commit landed after the
   *   review) is refused: the review has to be redone,
   *
   * The gate is deliberately checked *before* the replay: it is the state the
   * human reviewed that goes onto the base, never one a replay already rewrote.
   * The replay itself is part of the release, so the resolution run it may open
   * commits on top of the reviewed commit and the next attempt finds a clean
   * worktree bound to the replayed head (the run's settle commits and re-stamps
   * it, see `HostTaskLedger.settle`).
   *
   * A conflict during the replay is not a refusal: it stays where the agent can
   * reach it — in the card's own worktree — and is reported as a
   * {@link MergeConflictError}. Every other failure is an ordinary error.
   * @param task - the card being accepted.
   * @param now - merge instant to stamp on the returned state.
   * @returns the git state stamped with `mergedAt`, or undefined without one.
   */
  async mergeBranch(task: TaskRecord, now: number): Promise<TaskGit | undefined> {
    const git = task.git
    if (git === undefined || git.mergedAt !== undefined) return undefined
    if (git.reviewedCommit === undefined) {
      throw new Error(`merge refused: ${git.branch} has no reviewed commit; park the card in "Ready for test" again so the approval is bound to the commit you reviewed`)
    }
    const { dir, checkout } = this.workDir(git)
    if (this.isDirty(dir)) {
      throw new Error(`merge refused: ${dir} still holds uncommitted work, so the reviewed commit ${short(git.reviewedCommit)} is not what the worktree shows; park the card in "Ready for test" again`)
    }
    if (checkout) await this.runAsync(dir, ['checkout', git.branch], task.id)
    const head = this.head(dir)
    if (head !== git.reviewedCommit) {
      throw new Error(`merge refused: ${git.branch} moved from the reviewed commit ${short(git.reviewedCommit)} to ${short(head)}; review the new state (park the card again) before merging`)
    }
    await this.rebaseOnto(dir, git, task.id)
    // The merge itself happens in the main checkout, on the base branch: a
    // worktree never has the base checked out. The branch now lies on top of
    // that base, so this merge cannot conflict — whatever fails here is a
    // refusal (a base that moved in between, a checkout the human is using),
    // and it aborts rather than leaving the human's checkout half-merged.
    await this.runAsync(git.repoPath, ['checkout', git.base], task.id)
    try {
      await this.runAsync(git.repoPath, ['merge', '--no-ff', '-m', `merge ${git.branch} (task board)`, git.branch], task.id)
    } catch (error) {
      if (this.unmergedFiles(git.repoPath).length > 0) this.abortMerge(git.repoPath)
      throw error
    }
    // The worktree deliberately outlives the merge: a card can be reactivated
    // from `done`, and that run must find the checkout it worked in. It is
    // released when the card is archived or deleted.
    return { ...git, mergedAt: now }
  }

  /**
   * Replay the card's branch onto the base branch as it stands right now. A
   * branch that already lies on the base is left alone (`git rebase` is then a
   * no-op), so this is what every release does.
   *
   * A conflict is deliberately **left in place** in `dir` (conflict markers, a
   * rebase in progress, nothing staged by us) for the run that follows, so the
   * agent sees exactly the conflicted state and finishes the replay itself with
   * `git add` + `git rebase --continue`.
   * @param dir - the card's own directory (its worktree, or the main checkout).
   * @param git - the card's git state, for the base branch to replay onto.
   */
  private async rebaseOnto(dir: string, git: TaskGit, scope?: string): Promise<void> {
    try {
      await this.runAsync(dir, ['rebase', git.base], scope)
    } catch (error) {
      const files = this.unmergedFiles(dir)
      if (files.length > 0) {
        throw new MergeConflictError(
          `${git.branch} could not be replayed onto ${git.base}: ${files.length} conflicted file(s): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`,
          files,
        )
      }
      throw error
    }
  }

  /** Unmerged paths (`git ls-files -u`) of one directory; empty when there are none. */
  unmergedFiles(dir: string): string[] {
    try {
      const output = this.run(dir, ['ls-files', '-u', '-z'])
      return [...new Set(output.split('\0').map(line => line.split('\t')[1] ?? '').filter(line => line !== ''))]
    } catch {
      return []
    }
  }

  /** Roll back a half-done merge (conflict) in one directory. */
  abortMerge(dir: string): void {
    try {
      this.run(dir, ['merge', '--abort'])
    } catch {
      // Nothing in progress (or nothing to abort): the caller's own error text
      // is what the human reads, so this must not mask it.
    }
  }

  /** Roll back an unfinished rebase in one directory. */
  private abortRebase(dir: string): void {
    try {
      this.run(dir, ['rebase', '--abort'])
    } catch {
      // Nothing in progress (or nothing to abort): the caller's own error text
      // is what the human reads, so this must not mask it.
    }
  }

  /**
   * Whether one directory currently holds an unfinished rebase. Asked of git
   * itself (`rev-parse --git-path`), so it answers for the card's own worktree
   * and for the main checkout alike — and only for *this* directory's state.
   */
  private rebaseInProgress(dir: string): boolean {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      try {
        if (existsSync(this.run(dir, ['rev-parse', '--git-path', name]).trim())) return true
      } catch {
        // Not a repository (or no git at all): nothing is in progress there.
      }
    }
    return false
  }

  /** Whether the card's own directory currently holds an unfinished conflict. */
  hasUnresolvedMerge(task: TaskRecord): boolean {
    const git = task.git
    if (git === undefined) return false
    const { dir } = this.workDir(git)
    return this.unmergedFiles(dir).length > 0 || this.rebaseInProgress(dir)
  }

  /**
   * Put the card's directory back into a clean state after a failed conflict
   * resolution: an unfinished rebase or merge (`MERGE_HEAD`, conflict markers)
   * is aborted so the next run does not start on top of a half-done one. Only a
   * conflict that really is unfinished is touched.
   */
  abortUnresolvedMerge(task: TaskRecord): void {
    const git = task.git
    if (git === undefined) return
    const { dir } = this.workDir(git)
    if (this.rebaseInProgress(dir)) {
      this.abortRebase(dir)
      return
    }
    if (this.unmergedFiles(dir).length > 0) this.abortMerge(dir)
  }

  /**
   * Release the card's own worktree: the card is archived (it left the board
   * for good, so no run will ever need the directory again) or deleted. The
   * directory was disposal-only from the start — the branch, the commits and
   * the review stamp all survive in the repository. A git that refuses
   * (untracked build artifacts a `--force` cannot take, a locked worktree, an
   * open file) is reported instead of thrown: archiving never fails because of
   * it, and the Host poll retries the removal on the archived card.
   * @param task - the card leaving the board.
   * @returns why git refused, or undefined when the directory is gone.
   */
  async releaseWorktree(task: TaskRecord): Promise<string | undefined> {
    const git = task.git
    if (git === undefined || git.worktreePath === undefined || !existsSync(git.worktreePath)) return undefined
    try {
      await this.runAsync(git.repoPath, ['worktree', 'remove', '--force', git.worktreePath], task.id)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return existsSync(git.worktreePath) ? `${git.worktreePath} is still there after git worktree remove` : undefined
  }

  /**
   * Branch a new feature branch starts from: HEAD while it is a normal branch,
   * otherwise the repository's main branch (a second card pulled into
   * `clarification` while the first is still under review must not nest on the
   * first card's branch).
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
