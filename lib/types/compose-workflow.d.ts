/**
 * Task-scoped Docker Compose environments.
 *
 * A card whose worktree carries a compose file gets **its own stack**: the
 * project name is derived from the card id (`dsh-tb-<id8>`), every command runs
 * inside the card's worktree, and the published host ports are read back from
 * `docker compose ps` so the board can show the human where the app answers.
 *
 * The environment lives exactly as long as the card needs it — it is brought up
 * when an implementation run starts and torn down when the card leaves the run
 * and review columns, when it is deleted or archived, or when the Host notices
 * that the project has no card any more.
 *
 * Everything here is asynchronous on purpose: `compose up` builds images and
 * starts containers, which can take minutes, and the Host must keep serving the
 * board meanwhile. The command is always a fixed argv with `shell: false`, and
 * a missing compose file means "no environment", not an error — the feature is
 * discovered per workspace, not configured.
 */
import { type CommandRunner } from './command-runner.ts';
import type { TaskCompose, TaskRecord } from './core/tasks.ts';
/** Compose file a task environment is brought up from unless configured otherwise. */
export declare const DEFAULT_COMPOSE_FILE = "docker-compose.yml";
/** How long one compose command may take before it is killed. */
export declare const COMPOSE_TIMEOUT_MS: number;
/** First host port a card's environment is offered when `{port}` is used. */
export declare const DEFAULT_COMPOSE_PORT_BASE = 8100;
/** How many log lines one on-demand snapshot keeps. */
export declare const COMPOSE_LOG_TAIL = 200;
/** Size of the range the per-card port is picked from. */
export declare const DEFAULT_COMPOSE_PORT_RANGE = 800;
/** Per-call options of one compose invocation. */
export interface ComposeRunOptions {
    /**
     * Card id the command works for, for cancellation. The task record already
     * provides it; a teardown after the card is gone has only the id.
     */
    scope?: string;
    /**
     * Kill the command when this signal aborts (the operator pressed "Abbrechen").
     */
    signal?: AbortSignal;
    /**
     * Docker context the command addresses (`docker --context <name> compose …`).
     * The board's own default context is the one the Host runs under; a workspace
     * whose containers live elsewhere names its context in `reviewEnvironments`.
     */
    context?: string;
}
/** The subset of the workflow the Host service uses; tests fake this. */
export interface TaskComposeController {
    /**
     * Compose file the card would be brought up from (the card's worktree, else
     * its checkout), or undefined when it has none. Optional: a fake controller
     * without it simply never offers a compose environment.
     */
    fileFor?(task: TaskRecord): {
        dir: string;
        file: string;
    } | undefined;
    /** Bring the card's environment up; `undefined` when the card has none. */
    up(task: TaskRecord, options?: ComposeRunOptions): Promise<TaskCompose | undefined>;
    /** Tear a project down again (idempotent; failures only log). */
    down(project: string, dir: string, options?: ComposeRunOptions): Promise<void>;
    /** Snapshot of a project's container logs; optional like {@link TaskComposeController.fileFor}. */
    logs?(project: string, dir: string, options?: ComposeRunOptions): Promise<string>;
}
interface ComposeWorkflowOptions {
    /** Docker binary; the default resolves through PATH. */
    dockerCommand?: string;
    /** Compose file inside the card's worktree; an empty string disables the feature. */
    file?: string;
    /**
     * Environment for the card's stack, as `KEY=VALUE` pairs separated by commas
     * or newlines. `{port}`, `{port2}` … become distinct free host ports picked
     * for the card (and kept for it), `{task}` its id — that is how a compose file
     * that publishes fixed host ports (`${PORT:-8092}`) gets its own ports per
     * card instead of colliding with the human's own stack.
     */
    env?: string;
    /** Base of the per-card port range. */
    portBase?: number;
    /** Timeout of one compose command. */
    timeoutMs?: number;
    /** Command runner (the Host injects the worker-backed one; tests fake it). */
    runner?: CommandRunner;
}
/** Project name of a card's environment: stable, unique, easy to spot. */
export declare function composeProject(task: Pick<TaskRecord, 'id'>): string;
/** Directory a card's environment belongs to: its worktree, else its checkout. */
export declare function composeDir(task: Pick<TaskRecord, 'git'>): string | undefined;
export declare class ComposeWorkflow implements TaskComposeController {
    private file;
    private env;
    private readonly portBase;
    private readonly dockerCommand;
    private readonly timeoutMs;
    private readonly runner;
    constructor(options?: ComposeWorkflowOptions);
    /** Point the workflow at another environment template (settings). */
    setEnv(env: string): void;
    /**
     * Compose file to use, or undefined when the card has no environment. An
     * empty configured name disables the feature entirely; a missing configured
     * file falls back to the two other names compose itself accepts, so an
     * ordinary repository needs no configuration at all.
     */
    fileFor(task: TaskRecord): {
        dir: string;
        file: string;
    } | undefined;
    /** The configured compose file name (empty disables the feature). */
    get configuredFile(): string;
    /** Point the workflow at another compose file (settings); empty disables it. */
    setFile(file: string): void;
    /**
     * Bring the card's environment up and read its published ports back. Returns
     * undefined when the card has no compose file (nothing to do). A failure
     * throws with the command's own output, so the caller can fail the run and
     * put the reason on the card.
     */
    up(task: TaskRecord, options?: ComposeRunOptions): Promise<TaskCompose | undefined>;
    /**
     * Tear the project down, volumes included: the environment is disposable, and
     * a leftover volume would surprise the next run of the same card. A project
     * that is already gone is not an error; a real failure only logs.
     */
    down(project: string, dir: string, options?: ComposeRunOptions): Promise<void>;
    /**
     * Snapshot of the project's container logs (the last {@link COMPOSE_LOG_TAIL}
     * lines, no follow): the review modal reads it on demand, so a long-running
     * stack never holds a stream open in the Host.
     */
    logs(project: string, dir: string, options?: ComposeRunOptions): Promise<string>;
    /** Published host ports of the project, as `service host->container/proto`. */
    private ports;
    /**
     * Run one compose command in `dir`. The task id travels in the environment so
     * a compose file can key its own variables on it (`${DSH_TASK_ID}`), and the
     * project name is exported as `COMPOSE_PROJECT_NAME` for the same reason. A
     * context, when given, is addressed with docker's own global flag, so the
     * command reaches the daemon the workspace named instead of the Host's
     * default one.
     */
    private exec;
}
/**
 * Resolve the environment template for one card. `{task}` becomes the card id;
 * `{port}`, `{port2}` … `{port9}` become free host ports, one distinct port per
 * placeholder (a compose file may publish several: app, devtools, VNC). The
 * ports are probed on the loopback interface, start at the configured base
 * offset by the card id, and are **remembered** on the card
 * (`DSH_COMPOSE_PORT`, `DSH_COMPOSE_PORT2`, …), so re-running a card re-creates
 * its stack on the very ports the human already knows.
 */
export declare function resolveComposeEnv(template: string, task: Pick<TaskRecord, 'id'>, options?: {
    base?: number;
    previous?: Record<string, string>;
    probe?: (port: number) => Promise<boolean>;
}): Promise<Record<string, string>>;
/** Whether nothing is listening on the port (the probe a port allocation makes). */
export declare function isPortFree(port: number): Promise<boolean>;
/**
 * Read published ports out of `docker compose ps --format json`. Compose emits
 * one JSON object per line (and an array on some versions), so both shapes are
 * accepted; anything unparseable is ignored — a missing port list must never
 * fail a working environment.
 */
export declare function parsePublishedPorts(output: string): string[];
export {};
