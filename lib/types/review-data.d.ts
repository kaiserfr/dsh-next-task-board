/** How long one SQLite snapshot may take before the start is failed. */
export declare const REVIEW_DATA_SNAPSHOT_TIMEOUT_MS = 60000;
/** Source and target of one review start's data provisioning. */
export interface SeedReviewDataOptions {
    /** The human's main checkout (read-only source). */
    sourceRoot: string;
    /** The card's own worktree (destination). */
    targetRoot: string;
    /** SQLite files relative to both roots, as validated by the settings parser. */
    files: readonly string[];
    /** Snapshot timeout; defaults to {@link REVIEW_DATA_SNAPSHOT_TIMEOUT_MS}. */
    timeoutMs?: number;
}
/**
 * Snapshot every configured SQLite file from `sourceRoot` into `targetRoot`.
 * Rejects with a human-readable reason naming the file; the caller fails the
 * review start on it. The sources are only read.
 */
export declare function seedReviewData(options: SeedReviewDataOptions): Promise<void>;
