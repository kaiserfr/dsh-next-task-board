import type { TaskCompose, TaskRecord } from './core/tasks.ts';
/** Compose file a task environment is brought up from unless configured otherwise. */
export declare const DEFAULT_COMPOSE_FILE = "docker-compose.yml";
/** How long one compose command may take before it is killed. */
export declare const COMPOSE_TIMEOUT_MS: number;
/** First host port a card's environment is offered when `{port}` is used. */
export declare const DEFAULT_COMPOSE_PORT_BASE = 8100;
/** Size of the range the per-card port is picked from. */
export declare const DEFAULT_COMPOSE_PORT_RANGE = 800;
/** The subset of the workflow the Host service uses; tests fake this. */
export interface TaskComposeController {
    /** Bring the card's environment up; `undefined` when the card has none. */
    up(task: TaskRecord): Promise<TaskCompose | undefined>;
    /** Tear a project down again (idempotent; failures only log). */
    down(project: string, dir: string): Promise<void>;
}
interface ComposeWorkflowOptions {
    /** Docker binary; the default resolves through PATH. */
    dockerCommand?: string;
    /** Compose file inside the card's worktree; an empty string disables the feature. */
    file?: string;
    /**
     * Environment for the card's stack, as `KEY=VALUE` pairs separated by commas
     * or newlines. `{port}` is replaced by a free host port picked for the card
     * (and kept for it), `{task}` by its id — that is how a compose file that
     * publishes a fixed host port (`${PORT:-8092}`) gets one port per card
     * instead of colliding with the human's own stack.
     */
    env?: string;
    /** Base of the per-card port range. */
    portBase?: number;
    /** Timeout of one compose command. */
    timeoutMs?: number;
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
    up(task: TaskRecord): Promise<TaskCompose | undefined>;
    /**
     * Tear the project down, volumes included: the environment is disposable, and
     * a leftover volume would surprise the next run of the same card. A project
     * that is already gone is not an error; a real failure only logs.
     */
    down(project: string, dir: string): Promise<void>;
    /** Published host ports of the project, as `service host->container/proto`. */
    private ports;
    /**
     * Run one compose command in `dir`. The task id travels in the environment so
     * a compose file can key its own variables on it (`${DSH_TASK_ID}`), and the
     * project name is exported as `COMPOSE_PROJECT_NAME` for the same reason.
     */
    private exec;
}
/**
 * Resolve the environment template for one card. `{task}` becomes the card id,
 * `{port}` a free host port: the card's own remembered port when it has one,
 * otherwise a port from the configured base (offset by the card id so two cards
 * do not start probing at the same number), skipping ports that are already
 * taken on the loopback interface.
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
