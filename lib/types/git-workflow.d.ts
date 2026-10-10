import type { TaskGit, TaskRecord } from './core/tasks.ts';
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts';
/** Namespace of the feature branches the board opens. */
export declare const TASK_BRANCH_PREFIX = "task/";
/** Feature branch name of a task: `task/<title-slug>-<id8>`. */
export declare function taskBranch(task: TaskRecord): string;
export declare class GitWorkflow {
    private readonly registry?;
    constructor(registry?: TaskBoardWorkspaceRegistry | undefined);
    private run;
    /** Worktree of the task's pinned workspace when it is a git repository. */
    repoPath(task: TaskRecord): string | undefined;
    /**
     * Cut (or re-check-out) the task's feature branch, cut from the current
     * branch. Called on the `backlog` → `todo` move.
     */
    openBranch(task: TaskRecord): TaskGit | undefined;
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
     * @param task - the card whose work is being parked.
     * @param now - commit instant to stamp on the returned state.
     * @returns the git state stamped with `committedAt`, or undefined without a
     *   repository.
     */
    commitBranch(task: TaskRecord, now: number): TaskGit | undefined;
    /** Check out the task's recorded feature branch before it runs. */
    useBranch(task: TaskRecord): void;
    /**
     * Commit any leftover the run left behind on the feature branch and merge it
     * back into the base branch. Called on the `ready_for_test` → `done` move; an
     * already-merged branch is left alone. The commit is a safety net: the park
     * into `ready_for_test` already committed the work.
     * @param task - the card being accepted.
     * @param now - merge instant to stamp on the returned state.
     * @returns the git state stamped with `mergedAt`, or undefined without one.
     */
    mergeBranch(task: TaskRecord, now: number): TaskGit | undefined;
    /**
     * Branch a new feature branch starts from: HEAD while it is a normal branch,
     * otherwise the repository's main branch (a second card pulled into `todo`
     * while the first is still under review must not nest on the first card's
     * branch).
     */
    private baseBranch;
    private branchExists;
    private isDirty;
}
