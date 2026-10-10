import type { TaskGit, TaskRecord } from './core/tasks.ts';
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts';
/** Namespace of the feature branches the board opens. */
export declare const TASK_BRANCH_PREFIX = "task/";
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
    constructor(registry?: TaskBoardWorkspaceRegistry | undefined, options?: GitWorkflowOptions);
    private run;
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
    mergeBranch(task: TaskRecord, now: number): TaskGit | undefined;
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
