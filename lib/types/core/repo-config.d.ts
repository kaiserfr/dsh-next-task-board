/**
 * Repository discovery per workspace: the setting that tells the board where the
 * git repository of a workspace lives when the workspace directory itself is not
 * one.
 *
 * A workspace is often a container directory (`/home/me/proj` holding `app/`,
 * `infra/`, docs and the board's own scratch files) while the repository — the
 * thing that has a `main` branch to merge into — is one directory inside it. The
 * git workflow needs the repository root: it cuts the card's feature branch
 * there, creates the card's worktree there, and merges back there. Without this
 * mapping, such a card simply has no git state (the historical, silent no-op).
 *
 * Framework-free and Node-builtin-free, because the browser's settings card
 * validates exactly the document the Host executes (the convention
 * `core/review-config.ts` follows).
 */
/** One workspace's repository location. */
export interface RepoSubpathConfig {
    /** Absolute workspace directory this entry applies to (prefix match). */
    path: string;
    /**
     * Repository directory: relative to {@link path} (`dsh-next-task-board`,
     * `repos/app`), or an absolute directory of its own.
     */
    repo: string;
}
/** Result of parsing the setting: what parsed, and why the rest did not. */
export interface ParsedRepoSubpaths {
    entries: RepoSubpathConfig[];
    errors: string[];
}
/**
 * Whether a path is absolute in either spelling this Host sees: a POSIX path
 * (`/…`), a Windows drive path (`C:\…`) or a UNC path (`\\server\share`).
 */
export declare function isAbsoluteRepoPath(value: string): boolean;
/** One directory without a trailing separator (`/` stays `/`). */
export declare function normalizedRepoPath(value: string): string;
/**
 * Parse the `repoSubpath` setting: the JSON text, or an already parsed value.
 * Invalid entries are reported with a reason and dropped, so one typo never
 * disables another workspace.
 *
 * ```json
 * [{ "path": "/home/me/proj", "repo": "app" }]
 * ```
 */
export declare function parseRepoSubpaths(value: unknown): ParsedRepoSubpaths;
/**
 * Absolute repository directory of one entry: an absolute `repo` stands for
 * itself, a relative one is appended to the workspace path. Written out instead
 * of using `node:path` so the browser can use the same function.
 */
export declare function resolveRepoDirectory(entry: RepoSubpathConfig): string;
/**
 * The entry governing one workspace directory: the longest configured path that
 * is the directory itself or a parent of it (a nested project can override the
 * workspace above it).
 */
export declare function findRepoSubpath(entries: readonly RepoSubpathConfig[], workspacePath: string): RepoSubpathConfig | undefined;
