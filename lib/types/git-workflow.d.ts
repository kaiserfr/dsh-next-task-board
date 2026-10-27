import type { CommandRunner } from './command-runner.ts';
import type { TaskGit, TaskRecord } from './core/tasks.ts';
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts';
/** Namespace of the feature branches the board opens. */
export declare const TASK_BRANCH_PREFIX = "task/";
/**
 * A conflict the release ran into: thrown by {@link GitWorkflow.mergeBranch}
 * when the replay of the card's branch onto the base branch conflicts. The
 * replay is deliberately left in place in the card's own directory (conflict
 * markers, a rebase waiting to be continued), so the ledger can hand the
 * conflict to the card's agent instead of failing the release outright. The
 * class is the signal — a refusal (a dirty worktree, a moved branch) stays an
 * ordinary error and never starts a run.
 */
export declare class MergeConflictError extends Error {
    readonly files: readonly string[];
    constructor(message: string, files: readonly string[]);
}
/** Feature branch name of a task: `task/<title-slug>-<id8>`. */
export declare function taskBranch(task: TaskRecord): string;
/** Options of the git integration. */
export interface GitWorkflowOptions {
    /**
     * Directory the per-card worktrees are created in; one subdirectory per card
     * id. Defaults to `$DSH_HOME/task-board/worktrees`, so the board owns them and
     * nothing appears next to the user's repository.
     */
    worktreesRoot?: string;
    /**
     * Runner for the heavy git commands. The Host injects the worker-backed
     * runner, so worktree creation, commits, rebases and merges run off its
     * event loop and can be cancelled per card. Absent: the in-process spawn
     * this class always used (tests, source checkouts).
     */
    runner?: CommandRunner;
}
export declare class GitWorkflow {
    private readonly registry?;
    private readonly worktreesRoot;
    private readonly runner?;
    /** `repoSubpath` entries in force (see {@link configure}). */
    private repoSubpaths;
    /** Parse reasons of the last {@link configure}, for the settings card. */
    private repoSubpathErrors;
    constructor(registry?: TaskBoardWorkspaceRegistry | undefined, options?: GitWorkflowOptions);
    /**
     * Apply the `repoSubpath` setting: one entry per workspace directory, naming
     * the repository inside it. Invalid entries are reported with a reason and
     * dropped, exactly like `reviewEnvironments`.
     * @param value - raw setting (JSON text or the parsed array).
     * @returns the reasons of every entry that was refused (empty when all parsed).
     */
    configure(value: unknown): string[];
    /** Reasons of the last {@link configure} (empty when it parsed). */
    get configurationErrors(): readonly string[];
    private run;
    /**
     * Run one git command **without blocking the event loop** (`spawn`, not
     * `spawnSync`). This is what keeps `/parse`, `/state` and the SSE stream
     * answering while a worktree is created, a commit is built or a branch is
     * replayed and merged. The promise settles on the child's exit; the bounded
     * timeout only protects against a wedged child.
     */
    private runAsync;
    /**
     * One heavy git command through the injected runner: the worker thread owns
     * the child, the deadline and the card-scoped cancellation. A cancelled
     * command is an ordinary failure for the caller (the ledger records it on the
     * card), so the error text names the cancellation instead of a git exit code.
     */
    private runViaRunner;
    /** Whether `dir` is inside a git work tree. */
    private isRepository;
    /**
     * Repository directory of one workspace: the workspace itself when it is a
     * repository, otherwise the `repoSubpath` entry that governs it (when one is
     * configured and really is a repository). Undefined when the workspace has no
     * repository at all — the git flow is then the historical no-op.
     */
    repositoryOf(workspacePath: string): string | undefined;
    /** Worktree of the task's pinned workspace when it is a git repository. */
    repoPath(task: TaskRecord): string | undefined;
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
    openBranch(task: TaskRecord): Promise<TaskGit | undefined>;
    /**
     * The card's worktree directory, attached when it is missing: `git worktree
     * add` for a new branch, `git worktree add <path> <branch>` for an existing
     * one (a re-entered step, or a restart). Returns false when git refuses, so
     * the caller can fall back to the shared checkout.
     */
    private attachWorktree;
    /** Whether git lists `worktreePath` as a worktree of `repoPath`. */
    private isWorktreeOf;
    /** Absolute worktree directory of a card: one per card id. */
    private worktreePath;
    /**
     * Where the card's work happens right now: its worktree when that directory
     * exists (the branch is fixed there, so no checkout), otherwise the main
     * checkout (which the caller has to put on the card's branch).
     */
    private workDir;
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
    commitBranch(task: TaskRecord, now: number): Promise<TaskGit | undefined>;
    /**
     * Put the card's branch in place before it runs. A card with its own worktree
     * needs nothing: that directory stands on its branch already and switching
     * branches there is exactly the yank the worktree exists to prevent.
     */
    useBranch(task: TaskRecord): Promise<void>;
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
    mergeBranch(task: TaskRecord, now: number): Promise<TaskGit | undefined>;
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
    private rebaseOnto;
    /** Unmerged paths (`git ls-files -u`) of one directory; empty when there are none. */
    unmergedFiles(dir: string): string[];
    /** Roll back a half-done merge (conflict) in one directory. */
    abortMerge(dir: string): void;
    /** Roll back an unfinished rebase in one directory. */
    private abortRebase;
    /**
     * Whether one directory currently holds an unfinished rebase. Asked of git
     * itself (`rev-parse --git-path`), so it answers for the card's own worktree
     * and for the main checkout alike — and only for *this* directory's state.
     */
    private rebaseInProgress;
    /** Whether the card's own directory currently holds an unfinished conflict. */
    hasUnresolvedMerge(task: TaskRecord): boolean;
    /**
     * Put the card's directory back into a clean state after a failed conflict
     * resolution: an unfinished rebase or merge (`MERGE_HEAD`, conflict markers)
     * is aborted so the next run does not start on top of a half-done one. Only a
     * conflict that really is unfinished is touched.
     */
    abortUnresolvedMerge(task: TaskRecord): void;
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
    releaseWorktree(task: TaskRecord): Promise<string | undefined>;
    /**
     * Branch a new feature branch starts from: HEAD while it is a normal branch,
     * otherwise the repository's main branch (a second card pulled into
     * `clarification` while the first is still under review must not nest on the
     * first card's branch).
     */
    private baseBranch;
    private branchExists;
    private isDirty;
    /** Full SHA of the worktree's current head. */
    private head;
}
