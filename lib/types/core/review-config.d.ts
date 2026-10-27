/**
 * Review setups of the workspaces: the declarative half of the review block,
 * framework-free and dependency-free so both halves share exactly one rule —
 * the browser's settings card validates the document the Host later executes
 * (the same convention `core/state-machine.ts` follows).
 *
 * One entry per workspace directory:
 *
 * ```json
 * [{ "path": "/home/me/proj", "env": "PORT={port}",
 *    "start": "./start.sh", "stop": "./start.sh --stop",
 *    "restart": "./start.sh --restart", "logs": "tail -n 200 data/server.log",
 *    "url": "http://127.0.0.1:{port}", "dockerContext": "default",
 *    "data": ["data/app.db"] }]
 * ```
 *
 * `path` is the repository root; a card matches the longest entry that is its
 * directory or a parent of it, so a nested repository can override the entry of
 * the workspace above it. Commands run in the card's directory — its own
 * worktree, else its main checkout — which is what makes every action
 * card-scoped rather than global.
 *
 * `data` names SQLite files (relative to the repository root) that the review
 * start snapshots from the **main checkout** into the card's own worktree before
 * it starts the version. A fresh worktree has no gitignored database, so without
 * this list the reviewed version would start empty.
 */
/** One workspace's review setup. */
export interface ReviewEnvironmentConfig {
    /** Absolute directory (repository root) this entry applies to, prefix match. */
    path: string;
    /** Command that starts the version in the card's directory. */
    start?: string;
    /** Command that stops it again; also used by the automatic cleanup. */
    stop?: string;
    /** Command that restarts it; without one, stop + start is used. */
    restart?: string;
    /** Command whose output the logs modal shows. */
    logs?: string;
    /** URL template of the running version; `{port}`, `{port2}` … `{task}`. */
    url?: string;
    /** Docker context exported as `DOCKER_CONTEXT` for the commands. */
    dockerContext?: string;
    /** Extra environment, `KEY=VALUE` pairs separated by commas or newlines. */
    env?: string;
    /**
     * SQLite files to snapshot from the main checkout into the card's worktree
     * before a start, relative to the repository root (`data/app.db`). Only a card
     * that runs in its own worktree is seeded; the copy is never written back, and
     * every start overwrites the worktree copy from the current main checkout.
     */
    data?: string[];
}
/** File suffixes the review data list accepts (case-insensitive). */
export declare const REVIEW_DATA_SUFFIXES: readonly [".db", ".db3", ".sqlite", ".sqlite3"];
/** One directory entry without a trailing separator (`/` stays `/`). */
export declare function normalizedReviewPath(value: string): string;
/**
 * Whether `dir` is `prefix` itself or lives below it. Both separators are
 * accepted, so a POSIX Host and a Windows Host agree on the boundary without
 * this module importing `node:path`.
 */
export declare function isBelow(dir: string, prefix: string): boolean;
/**
 * Validate and normalize one `data` entry: a path relative to the repository
 * root that names a SQLite file. The returned path always uses `/` as the
 * separator, so a document written on Windows and one written on POSIX mean the
 * same file. `error` names the reason a human has to fix.
 */
export declare function normalizeReviewDataPath(value: unknown): {
    path: string;
} | {
    error: string;
};
/**
 * Parse the `reviewEnvironments` setting: the JSON text, or an already parsed
 * value. Invalid entries are reported with a reason and dropped, so one typo
 * never silently disables another workspace — the settings card shows the
 * reasons and the valid entries keep working.
 */
export declare function parseReviewEnvironments(value: unknown): {
    environments: ReviewEnvironmentConfig[];
    errors: string[];
};
/**
 * The workspace entry that governs `dir`: the longest configured path that is
 * `dir` itself or a parent of it. Longest wins so a nested repository overrides
 * the entry of the workspace above it.
 */
export declare function findReviewEnvironment(environments: readonly ReviewEnvironmentConfig[], dir: string): ReviewEnvironmentConfig | undefined;
/** Whether an entry can start anything at all. */
export declare function hasCommands(environment: ReviewEnvironmentConfig | undefined): environment is ReviewEnvironmentConfig;
