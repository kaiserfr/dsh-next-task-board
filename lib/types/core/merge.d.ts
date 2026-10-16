/**
 * Merge state of a card: the one derived value the board shows about the merge
 * release, framework-free so the browser, the Host and the tests read the same
 * rule (the convention `core/state-machine.ts` and `core/review-config.ts`
 * follow).
 *
 * The state is *derived*, never stored: the card's `merge` record and its `git`
 * record are the durable truth (`TaskMerge`/`TaskGit`), and this function turns
 * them into the single word the board renders. A card can therefore never claim
 * a merge it did not record.
 */
import type { TaskRecord } from './tasks.ts';
/**
 * What the card says about its merge:
 *
 * - `merged` — the result is in the base branch (and `mergedAt` names when),
 * - `resolving` — the replay onto the base conflicted and a resolution run is
 *   working on it,
 * - `released` — the human released the card and the Host is merging,
 * - `failed` — the release failed; the card carries the reason,
 * - `unmerged` — the card has a branch but was not merged (yet),
 * - `no-branch` — there is nothing to merge (no repository, or a card released
 *   without a branch), which is a statement, not an error.
 */
export type MergeState = 'merged' | 'resolving' | 'released' | 'failed' | 'unmerged' | 'no-branch';
/**
 * Merge state of one card, or undefined when the card has nothing to say about a
 * merge. That is deliberately narrow: a card that never ran the git flow and
 * never was released (a plain backlog card, or one of the many legacy cards)
 * shows no badge at all, instead of a "not merged" label on every column.
 * @param task - the card to read.
 * @returns the state, or undefined when there is nothing to show.
 */
export declare function mergeStateOf(task: TaskRecord): MergeState | undefined;
/** Whether the review block should warn that the release has to wait. */
export declare function mergeNeedsResolution(task: TaskRecord): boolean;
