import type { TaskGit, TaskRecord } from './core/tasks.ts';
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts';
/** Namespace of the feature branches the board opens. */
export declare const TASK_BRANCH_PREFIX = "task/";
/**
 * A merge that hit conflicts: thrown by {@link GitWorkflow.mergeBranch} after it
 * rolled the half-done merge back, so the ledger can hand the conflict to the
 * card's agent instead of failing the release outright. The class is the signal
 * — a refusal (a dirty worktree, a moved branch) stays an ordinary error and
 * never starts a run.
 */
export declare class MergeConflictError extends Error {
    readonly files: readonly string[];
    constructor(message: string, files: readonly string[]);
}
/**
 * What one started conflict-resolution merge did in the card's directory: either
 * the merge went through on its own (`clean`), or it is left in place with
 * conflict markers for the agent (`files` names the unmerged paths).
 */
export interface MergeResolutionStart {
    clean: boolean;
    files: string[];
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
}
export declare class GitWorkflow {
    private readonly registry?;
    private readonly worktreesRoot;
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
    openBranch(task: TaskRecord): TaskGit | undefined;
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
    commitBranch(task: TaskRecord, now: number): TaskGit | undefined;
    /**
     * Put the card's branch in place before it runs. A card with its own worktree
     * needs nothing: that directory stands on its branch already and switching
     * branches there is exactly the yank the worktree exists to prevent.
     */
    useBranch(task: TaskRecord): void;
    /**
     * Merge the card's feature branch back into the base branch — but only the
     * exact commit the human reviewed. Called by the release path (the
     * `ready_for_test` → `done` move and the card's release action); an
     * already-merged branch is left alone.
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
     * One deliberate exception: while the card carries an **open release**
     * (`task.merge` without `mergedAt`/`error`), a head that is a descendant of
     * the reviewed commit is accepted. That is the conflict-resolution commit the
     * board's own run created (`beginMergeResolution`) — the human released the
     * card, the automatic resolution is part of that release, and the release only
     * ever accepts commits the reviewed one is an ancestor of.
     *
     * A conflict is not a refusal: the half-done merge in the main checkout is
     * rolled back and a {@link MergeConflictError} is thrown, so the caller can
     * hand the conflict to the card's agent. Every other failure is an ordinary
     * error.
     * @param task - the card being accepted.
     * @param now - merge instant to stamp on the returned state.
     * @returns the git state stamped with `mergedAt`, or undefined without one.
     */
    mergeBranch(task: TaskRecord, now: number): TaskGit | undefined;
    /**
     * Whether an open release lets the merge accept a head past the reviewed
     * commit: only when the card currently carries a release in progress and the
     * reviewed commit is still an ancestor of that head (so the release can only
     * ever add commits on top of what the human reviewed, never rewrite it).
     */
    private acceptsResolvedHead;
    /**
     * Start the conflict resolution in the card's own directory: merge the base
     * branch into the feature branch there (`git merge <base>`), which is the
     * mirror image of the merge that just failed — but in the directory the agent
     * works in, where the conflict can be resolved and committed without ever
     * touching the human's checkout.
     *
     * A clean merge is committed by git itself and reported as `clean`; a conflict
     * is deliberately **left in place** (conflict markers, `MERGE_HEAD`) for the
     * run that follows, so the agent sees exactly the conflicted state.
     * @param task - the card whose release hit the conflict.
     * @returns what the started merge did.
     */
    beginMergeResolution(task: TaskRecord): MergeResolutionStart;
    /** Unmerged paths (`git ls-files -u`) of one directory; empty when there are none. */
    unmergedFiles(dir: string): string[];
    /** Roll back a half-done merge (conflict) in one directory. */
    abortMerge(dir: string): void;
    /** Whether the card's own directory currently holds an unfinished merge. */
    hasUnresolvedMerge(task: TaskRecord): boolean;
    /**
     * Put the card's directory back into a clean state after a failed conflict
     * resolution: an unfinished merge (`MERGE_HEAD`, conflict markers) is aborted
     * so the next run does not start on top of a half-done merge. Only a merge
     * that really is unfinished is touched.
     */
    abortUnresolvedMerge(task: TaskRecord): void;
    /**
     * Drop a card's worktree because the card itself is gone (deleted from the
     * board): nothing points at the directory any more, so it is not kept around.
     * A git that refuses (untracked build artifacts, a lock) only logs.
     */
    releaseWorktree(task: TaskRecord): void;
    /**
     * Drop the card's worktree after its branch was merged: the directory was
     * disposal-only from the start (the branch, the commits and the review stamp
     * all survive in the repository). A worktree git refuses to remove — untracked
     * build artifacts, a lock — is left alone and never fails the accept.
     */
    private removeWorktree;
    /**
     * Branch a new feature branch starts from: HEAD while it is a normal branch,
     * otherwise the repository's main branch (a second card pulled into `todo`
     * while the first is still under review must not nest on the first card's
     * branch).
     */
    private baseBranch;
    private branchExists;
    private isDirty;
    /** Full SHA of the worktree's current head. */
    private head;
}
