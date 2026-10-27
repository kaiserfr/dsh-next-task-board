import type { TaskRecord, TaskReview } from './core/tasks.ts';
import { type ReviewEnvironmentConfig } from './core/review-config.ts';
import { type TaskComposeController } from './compose-workflow.ts';
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts';
export { findReviewEnvironment, hasCommands, isBelow, parseReviewEnvironments, type ReviewEnvironmentConfig } from './core/review-config.ts';
/** App URL a card is offered when its workspace configures no template. */
export declare const DEFAULT_REVIEW_URL_TEMPLATE = "http://127.0.0.1:{port}";
/** How long one configured review command (start/stop/restart) may take. */
export declare const REVIEW_COMMAND_TIMEOUT_MS: number;
/** How long a logs read may take; it is a snapshot, not a build. */
export declare const REVIEW_READ_TIMEOUT_MS = 30000;
/** Editor binary the worktree link launches. */
export declare const DEFAULT_EDITOR_COMMAND = "code";
/** Flag that keeps a second card out of the window of the first one. */
export declare const EDITOR_NEW_WINDOW_FLAG = "-n";
/** Outcome of one command run. */
export interface ReviewCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}
/** Injection seam for the shell commands (tests replace it). */
export type ReviewCommandRunner = (command: string, options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
}) => Promise<ReviewCommandResult>;
/** Injection seam for fixed-argv calls (git diff; tests replace it). */
export type ReviewFixedRunner = (command: string, args: readonly string[], options: {
    cwd: string;
    timeoutMs: number;
}) => Promise<ReviewCommandResult>;
/** Injection seam for the editor launch (tests replace it). */
export type ReviewAppLauncher = (command: string, args: readonly string[]) => Promise<void>;
/** Options of the review workflow. */
export interface ReviewWorkflowOptions {
    /** Compose integration the review start reuses (the card's own project). */
    compose: TaskComposeController;
    /** Registered workspaces: resolves a card without git state to its directory. */
    workspaceRegistry?: TaskBoardWorkspaceRegistry;
    /**
     * Repository directory of one workspace directory (the git workflow's
     * `repoSubpath` resolution). Used for a card without git state: the review then
     * looks at the repository inside the workspace, exactly like the git flow and
     * the workspace's configured commands do, instead of at the container folder.
     */
    repoDirectory?: (workspacePath: string) => string | undefined;
    /** Editor binary; defaults to `code`. */
    editorCommand?: string;
    /** Base of the per-card port range for configured commands. */
    portBase?: number;
    /** Command timeout; defaults to {@link REVIEW_COMMAND_TIMEOUT_MS}. */
    commandTimeoutMs?: number;
    /** Logs/read timeout; defaults to {@link REVIEW_READ_TIMEOUT_MS}. */
    readTimeoutMs?: number;
    /** Clock (tests). */
    now?: () => number;
    /** Command runner (tests). */
    runCommand?: ReviewCommandRunner;
    /** Fixed-argv runner for git reads (tests). */
    runFixed?: ReviewFixedRunner;
    /** Editor launcher (tests). */
    launchApp?: ReviewAppLauncher;
}
/**
 * What one card offers the review step; derived from the filesystem and the
 * settings on every read, never persisted.
 */
export interface ReviewPlan {
    /** Directory the version runs in; absent when the card has no known directory. */
    dir?: string;
    /** Whether `dir` is the card's own worktree (false = its main checkout). */
    worktree?: boolean;
    /** `*.code-workspace` to open instead of the directory, when one exists. */
    workspaceFile?: string;
    /** Whether there is something to start (a compose file or configured commands). */
    available: boolean;
    /** Whether the Host can read logs for it (compose, or a configured logs command). */
    logs: boolean;
}
/**
 * Resolve the URL template against an environment: `{port}`, `{port2}` …
 * become the assigned host ports and `{task}` the card id. An unresolved
 * placeholder means the URL cannot answer yet, so there is no link instead of a
 * made-up address; anything that is not an http(s) URL is refused for the same
 * reason.
 */
export declare function resolveReviewUrl(template: string, env: Readonly<Record<string, string>>, taskId?: string): string | undefined;
/** Published host ports of one compose project, as `service host->container/proto`. */
export declare function publishedPorts(ports: readonly string[] | undefined): number[];
/**
 * Links the review offers: the template resolved with the card's assigned
 * ports, plus one link per published compose port (the container may publish
 * more than the template's first port names). Duplicates collapse, and an
 * unresolvable template simply produces no link.
 */
export declare function reviewLinks(template: string, env: Readonly<Record<string, string>>, published: readonly number[], taskId?: string): string[];
/**
 * The `*.code-workspace` to open for a directory: the file named after the
 * directory first (that is the one the human's repositories carry), otherwise
 * the single/lexicographically first one. Returns an absolute path or
 * undefined; a directory without a workspace file is opened as a folder.
 */
export declare function pickCodeWorkspace(dir: string, files?: readonly string[]): string | undefined;
/**
 * Run one configured command through the shell: the command text is the
 * human's own settings text (it may contain pipes, `&&`, a leading `PORT=…`
 * assignment), and it runs in the card's directory with the review environment
 * exported. A command that does not finish within the budget is killed and
 * reported as a failure — including its own output, so the reason is visible.
 */
export declare function runShellCommand(command: string, options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
}): Promise<ReviewCommandResult>;
/** Start the editor and resolve once it is really running (a missing binary rejects). */
export declare function launchDetached(command: string, args: readonly string[]): Promise<void>;
export declare class ReviewWorkflow {
    private environments;
    /** Parse reasons of the current setting, for the settings card. */
    private errors;
    private readonly compose;
    private readonly registry;
    private readonly repoDirectory;
    private editorCommand;
    private readonly portBase;
    private readonly commandTimeoutMs;
    private readonly readTimeoutMs;
    private readonly now;
    private readonly runCommand;
    private readonly runFixed;
    private readonly launchApp;
    constructor(options: ReviewWorkflowOptions);
    /** Point the workflow at another `reviewEnvironments` setting; returns the reasons. */
    configure(value: unknown): string[];
    /** Reasons of the last {@link ReviewWorkflow.configure} (empty when it parsed). */
    get configurationErrors(): readonly string[];
    /** Point the worktree link at another editor binary (settings `editorCommand`). */
    setEditorCommand(command: string): void;
    /** The configured entries (tests and diagnostics). */
    get entries(): readonly ReviewEnvironmentConfig[];
    /**
     * Directory the card's version lives in: its own worktree when it still
     * exists, else its main checkout, else the registered directory of the
     * pinned workspace (a card without git state). Absent when none of them is a
     * real directory — then there is nothing to open, start or diff.
     */
    directory(task: TaskRecord): string | undefined;
    /**
     * Registered directory of the card's pinned workspace, when the registry knows
     * it — the last resort for a card without git state.
     */
    private workspaceDirectory;
    /**
     * The workspace entry governing the card, looked up by its directory first and
     * then by the repository it belongs to: a card working in its own worktree
     * lives *outside* the repository, so an entry keyed to the repository root must
     * still govern it (the worktree is that repository's checkout). The registered
     * workspace directory closes the same gap for a card without git state.
     */
    environmentFor(task: TaskRecord, dir: string): ReviewEnvironmentConfig | undefined;
    /** Compose file the card's directory holds, when the compose integration finds one. */
    private composeTarget;
    /**
     * What the review step offers this card. Derived from the filesystem and the
     * settings on every read (the plan is not ledger state): a card whose worktree
     * was deleted, whose compose file moved or whose workspace entry was removed
     * simply loses the corresponding control.
     */
    plan(task: TaskRecord): ReviewPlan;
    /**
     * Identity of the environment a start would create: how it would be managed,
     * what identifies it and where it would run. Known before anything runs, which
     * is what lets the Host record a *failed* start on the card with the same
     * fields a successful one carries. Undefined when there is nothing to manage.
     */
    describe(task: TaskRecord): Pick<TaskReview, 'mode' | 'source' | 'dir'> & Pick<TaskReview, 'context'> | undefined;
    /**
     * Bring the card's version up and return the record for the card. Compose
     * wins when the directory holds a compose file (the card's own project, its
     * own ports, its own volumes); otherwise the workspace's configured start
     * command runs in the card's directory with the assigned ports and the
     * configured docker context in its environment.
     *
     * A failure throws with the command's own output — the caller puts it on the
     * card. Nothing is recorded as running here; only a successful start returns
     * a record with `startedAt`.
     *
     * Before either mode starts, the environment's `data` list is snapshotted from
     * the card's main checkout into its own worktree: the worktree is a fresh
     * checkout, so a gitignored database would otherwise be missing. A failed
     * snapshot fails the start, never silently starting an empty application.
     */
    start(task: TaskRecord): Promise<TaskReview>;
    /**
     * Snapshot the configured SQLite files from the main checkout into the card's
     * own worktree. Only a card that really runs in its worktree is seeded: a card
     * reviewed in its main checkout already has the data, and a card without git
     * state has no main checkout to read from. The source is never written.
     */
    private seedData;
    private startCompose;
    private startCommand;
    /**
     * Tear the card's version down: the compose project goes down (volumes
     * included, like the run environment), a command environment runs its
     * configured stop command in the very environment it was started with — the
     * assigned ports, so it stops this card's instance and not the human's.
     */
    stop(taskId: string, review: TaskReview): Promise<void>;
    /**
     * Snapshot of the environment's own log or the compose project's container
     * logs (compose's own snapshot size, {@link COMPOSE_LOG_TAIL}); a configured
     * `logs` command prints what the human wrote into it. Throws when the
     * workspace configures no logs command and the card has no compose file.
     */
    logs(taskId: string, review: TaskReview): Promise<string>;
    /**
     * Open the card's directory in the editor, or the `*.code-workspace` it
     * carries (the workspace file is what the human's environment expects, and
     * its relative folder entries point at the worktree). A missing editor binary
     * rejects, so the card can say why nothing opened.
     */
    openInEditor(task: TaskRecord): Promise<string>;
    /**
     * `git diff --stat` of the reviewed commit against the base branch: what the
     * human is looking at, without opening the repository. A card that was never
     * parked (no reviewed commit) has nothing to compare and reads as an empty
     * diff instead of an error.
     */
    reviewDiff(task: TaskRecord): Promise<string>;
    /**
     * Environment of one command run: the assigned ports first (remembered on the
     * card, so a re-start keeps the URL the human already has open), then the
     * workspace's own `KEY=VALUE` pairs, then the docker context as
     * `DOCKER_CONTEXT` (docker's own convention, which is what makes a groove
     * command land on the intended daemon).
     */
    private commandEnv;
}
