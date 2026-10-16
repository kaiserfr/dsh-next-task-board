/**
 * Host loader entry for the task-board plugin.
 *
 * The Host owns the v2 ledger, action API, cron scheduler, session runner,
 * execution reconciliation, and optional idle-sleep inhibitor. The browser is
 * a same-origin asynchronous view over that service.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { type TaskPermission } from './core/tasks.ts';
import type { StateMachineConfig } from './core/state-machine.ts';
/** Default environment variable holding the authenticated proxy token. */
export declare const DEFAULT_PROXY_TOKEN_ENV = "DSH_TASK_BOARD_PROXY_TOKEN";
export declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const TASK_BOARD_GUIDANCE: string;
/**
 * Settings namespace of the board's announcement capability — the section the
 * web settings surface edits. Spelled here rather than imported: the browser
 * half spells the same value and must not depend on a Host package.
 */
export declare const TASK_BOARD_SETTINGS_NAMESPACE: SettingsNamespace;
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
    /**
     * When true (default), a system-prompt section announces the board to every
     * agent. Set false to keep the board silent in prompts; agents then learn
     * about it only when the user mentions it.
     */
    announceToAgent?: Volatile<boolean>;
    /** Master switch for the plugin (browser half + host announcement). */
    enabled?: Volatile<boolean>;
    /** Prevent idle system sleep while sessions run or schedules are armed. */
    preventIdleSleep?: Volatile<boolean>;
    /**
     * WIP limit per workspace/lane: how many task runs of the same workspace may
     * hold a session at the same time. Runs above their lane's limit wait in a
     * FIFO queue and start as soon as a slot in that lane frees up; other
     * workspaces run in parallel. `1` (default) serialises each workspace.
     */
    maxConcurrentRuns?: Volatile<number>;
    /**
     * The board's state machine: columns (task states), the transitions allowed
     * between them, and the actions fired by a transition (`git.openBranch`,
     * `git.commitBranch`, `git.mergeBranch`, `run`, `clarify`, `stamp`). Absent
     * keeps the shipped
     * machine (backlog → todo → running → ready_for_test → failed → done, where
     * `backlog → todo` is the clarification step: every card starts its run
     * there, its prompt asks the agent's open questions and stops, and a human
     * start on to `running` continues that same session with the
     * implementation; every way into `ready_for_test` commits the card's
     * worktree, and `ready_for_test → done` merges the branch). An invalid
     * config is refused as a whole and the machine in force stays.
     * Shape: `{ initial?, states: [{ status, label?, order?, drop? }],
     * transitions: [{ from, to, trigger?, git?, actions? }] }`.
     */
    stateMachine?: Volatile<StateMachineConfig>;
    /**
     * Done-column limit (N): how many on-board cards the `done` column may hold.
     * A move into `done` that would exceed the limit archives the cards that have
     * been in `done` the longest (FIFO) until it holds again; archived cards stay
     * in the ledger and remain reachable through the board's archive view. The
     * limit applies to the `done` column only.
     */
    maxDoneTasks?: Volatile<number>;
    /**
     * Compose file a card's task environment is brought up from, relative to the
     * card's worktree. Absent uses `docker-compose.yml` (with `compose.yaml` and
     * `docker-compose.yaml` as fallbacks); an empty value turns task containers
     * off. The project name is derived from the card id, so every card gets its
     * own stack, its own volumes and — as reported back from compose — its own
     * published ports.
     */
    composeFile?: Volatile<string>;
    /**
     * Environment handed to every card's stack, as `KEY=VALUE` pairs (commas or
     * newlines). `{port}` is replaced by a free host port assigned to the card and
     * kept for it, `{task}` by its id — the way a compose file that publishes a
     * fixed port (`${PORT:-8092}`) gets one port per card instead of colliding
     * with the stack the human runs themselves. Example: `PORT={port}`.
     */
    composeEnv?: Volatile<string>;
    /**
     * Review setups per workspace, as a JSON array. A card in `ready for test`
     * shows the controls of the entry whose `path` is the card's directory or a
     * parent of it (longest match wins):
     *
     * ```json
     * [{ "path": "/home/me/proj", "env": "PORT={port}",
     *    "start": "./start.sh", "stop": "./start.sh --stop",
     *    "logs": "tail -n 200 data/server.log",
     *    "url": "http://127.0.0.1:{port}", "dockerContext": "default" }]
     * ```
     *
     * `{port}`, `{port2}` … become free host ports assigned to the card and kept
     * for it, `{task}` is its id. The commands run in the card's directory (its
     * worktree, else its main checkout) with the configured `env` and
     * `DOCKER_CONTEXT`; a compose file in that directory wins over the configured
     * commands. Leaving the review column stops the version again through the
     * configured `stop` — but only one the board itself started.
     */
    reviewEnvironments?: Volatile<string>;
    /**
     * Repository directory per workspace, as a JSON array — for workspaces that are
     * container folders rather than repositories themselves:
     *
     * ```json
     * [{ "path": "/home/me/proj", "repo": "app" }]
     * ```
     *
     * The card's git flow (feature branch, its own worktree, the merge back into
     * the base branch) needs the repository root; without an entry, a workspace
     * whose directory is not inside a git work tree stays out of that flow (the
     * card keeps working, just without a branch). `repo` is relative to `path` or an
     * absolute directory of its own; the longest matching `path` wins, so a nested
     * repository can override the workspace above it.
     */
    repoSubpath?: Volatile<string>;
    /** Editor binary the worktree link launches (default `code`, opened with `-n`). */
    editorCommand?: Volatile<string>;
    /** Canonical reverse-proxy Host authorities admitted with a server-side token. */
    trustedProxyHosts?: string[];
    /** Environment variable whose value the authenticated proxy injects upstream. */
    proxyTokenEnv?: string;
    /**
     * The deployment's session-default permission. A card whose effective
     * permission (handover bundle or pin) is above this value requires a human
     * confirmation before it may run; cron refuses unconfirmed cards.
     */
    sessionDefaultPermission?: TaskPermission;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
    preventIdleSleep: z<boolean, boolean, "volatile-defined">;
    maxConcurrentRuns: z<number, number, "volatile-defined">;
    stateMachine: z<any, any, "volatile">;
    maxDoneTasks: z<number, number, "volatile-defined">;
    composeFile: z<string, string, "volatile-defined">;
    composeEnv: z<string, string, "volatile-defined">;
    reviewEnvironments: z<string, string, "volatile-defined">;
    repoSubpath: z<string, string, "volatile-defined">;
    editorCommand: z<string, string, "volatile-defined">;
    trustedProxyHosts: z<string[], string[], "defined">;
    proxyTokenEnv: z<string, string, "defined">;
    sessionDefaultPermission: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
    preventIdleSleep: z<boolean, boolean, "volatile-defined">;
    maxConcurrentRuns: z<number, number, "volatile-defined">;
    stateMachine: z<any, any, "volatile">;
    maxDoneTasks: z<number, number, "volatile-defined">;
    composeFile: z<string, string, "volatile-defined">;
    composeEnv: z<string, string, "volatile-defined">;
    reviewEnvironments: z<string, string, "volatile-defined">;
    repoSubpath: z<string, string, "volatile-defined">;
    editorCommand: z<string, string, "volatile-defined">;
    trustedProxyHosts: z<string[], string[], "defined">;
    proxyTokenEnv: z<string, string, "defined">;
    sessionDefaultPermission: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access", "defined">;
}>>, "plain">;
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Volatile config values were committed into the running fiber without a
         * remount; dispatched to the owning fiber only. Spelled here because the
         * Loader package is not a dependency of this plugin, with the Loader's own
         * shape so the two declarations merge when a Host program carries both.
         * @param paths - changed config paths as key arrays; every value is committed before dispatch.
         * @mode emit
         */
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
/**
 * Read one config field's current value.
 *
 * The Loader hands schema-volatile fields as stable references it commits in
 * place, so a live value must be read at use time rather than captured when
 * the plugin activates; a plain value (a programmatic mount, or a field the
 * schema does not mark volatile) is returned as it stands.
 * @param field - the config field as the Loader handed it.
 * @param fallback - value to use when the field is absent.
 * @returns the effective field value.
 */
export declare function readConfigField<T>(field: Volatile<T> | T | undefined, fallback: T): T;
/** Resolve proxy access without ever placing the token value in plugin config. */
export declare function resolveProxyAccess(config: Config | undefined, env?: NodeJS.ProcessEnv): {
    trustedProxyHosts: string[];
    proxyToken?: string;
};
/**
 * Read the optional `llm` service. The board deliberately does not inject it:
 * a deployment without a model must still mount the board, and the parse route
 * answers a typed failure instead of the plugin failing to load (issue #1540).
 * @param ctx - the plugin context.
 * @returns the llm service, or undefined when this deployment serves none.
 */
export declare function resolveLlmRuntime(ctx: Context): LlmRuntime | undefined;
/**
 * Register the board's announcement section, gated on the composition entry's
 * `announceToAgent` (and the live settings value once the web settings
 * surface is served). The section is re-registered whenever the source
 * changes, so a settings edit takes effect without a restart.
 * @param ctx - the plugin context (systemPrompt injected).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export declare const apply: typeof applyImpl;
declare function applyImpl(ctx: Context, config?: Config): void;
export {};
