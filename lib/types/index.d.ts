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
export declare const TASK_BOARD_GUIDANCE = "\u672C\u673A\u5DF2\u5B89\u88C5 dsh-next-task-board \u63D2\u4EF6\uFF08DSH Web GUI \u7684\u4EFB\u52A1\u770B\u677F\uFF0Ckaiserfr/dsh-next-task-board \u7EF4\u62A4\u7684 dsh-task-board \u5206\u652F\uFF09\uFF1A\u4FA7\u8FB9\u680F\u300C\u4EFB\u52A1\u770B\u677F\u300D\u5165\u53E3\uFF1B\u5217\u5373\u4EFB\u52A1\u72B6\u6001\uFF0C\u5E95\u4E0B\u7684\u72B6\u6001\u673A\u53EF\u914D\u7F6E\uFF08\u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4 task-board \u7684 stateMachine\uFF0CJSON\uFF1Astates \u5217\u3001transitions \u5141\u8BB8\u7684\u8F6C\u79FB\u3001\u4EE5\u53CA\u8F6C\u79FB\u4E0A\u7684 actions\uFF1Agit.openBranch \u5F00 feature \u5206\u652F\u3001git.mergeBranch \u5408\u5E76\u56DE\u57FA\u7EBF\u5206\u652F\u3001run \u542F\u52A8\u6267\u884C\u3001stamp \u5199\u65F6\u95F4\u6233\uFF09\u3002\u672A\u58F0\u660E\u7684\u8F6C\u79FB\u4E00\u5F8B\u88AB Host \u62D2\u7EDD\uFF0C\u62D6\u653E\u4E5F\u53EA\u5141\u8BB8\u5DF2\u58F0\u660E\u7684\u8F6C\u79FB\uFF1B\u7559\u7A7A\u7528\u5185\u7F6E\u72B6\u6001\u673A\u3002Host \u6309\u5DE5\u4F5C\u533A\uFF08WIP lane\uFF09\u5206\u522B\u6267\u884C\u4E0A\u9650\uFF08\u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4 task-board \u7684 maxConcurrentRuns\uFF0C\u9ED8\u8BA4 1\uFF09\uFF1A\u540C\u4E00\u5DE5\u4F5C\u533A\u5185\u4E32\u884C/\u9650\u6D41\uFF0C\u4E0D\u540C\u5DE5\u4F5C\u533A\u53EF\u5E76\u884C\uFF1B\u540C\u4E00\u5DE5\u4F5C\u533A\u8D85\u51FA\u7684\u8FD0\u884C\u5148\u6392\u961F\u3001\u6309\u5148\u6765\u540E\u5230\u5728\u540D\u989D\u7A7A\u51FA\u540E\u542F\u52A8\uFF0C\u6392\u961F\u4E2D\u7684\u5361\u7247\u5DF2\u663E\u793A\u4E3A\u8FDB\u884C\u4E2D\u4F46\u5C1A\u65E0\u4F1A\u8BDD\u3002\u770B\u677F\u8FD8\u6709 Done \u5217\u4E0A\u9650\uFF08\u8BBE\u7F6E task-board \u7684 maxDoneTasks\uFF0C\u9ED8\u8BA4 9\uFF09\uFF1A\u5361\u7247\u79FB\u5165\u5DF2\u5B8C\u6210\u4E14\u8D85\u51FA\u4E0A\u9650\u65F6\uFF0C\u6309\u8FDB\u5165 Done \u7684\u65F6\u95F4\u81EA\u52A8\u628A\u6700\u65E7\u7684\u5361\u7247\uFF08FIFO\uFF09\u5F52\u6863\u5230\u5F52\u6863\u89C6\u56FE\uFF08\u4E0D\u5220\u9664\uFF0C\u53EF\u6062\u590D\uFF09\uFF0C\u5E76\u53EA\u5728\u5FC5\u8981\u65F6\u5F52\u6863\uFF1B\u8C03\u4F4E\u4E0A\u9650\u6216 Host \u542F\u52A8\u65F6\u4E5F\u4F1A\u7ACB\u5373\u628A\u8D85\u51FA\u90E8\u5206\u5F52\u6863\uFF0CDone \u5217\u59CB\u7EC8\u4E0D\u8D85\u8FC7\u4E0A\u9650\u3002\u5185\u7F6E\u72B6\u6001\u673A\u7684\u5217\u4E3A\uFF1A\u5F85\u89C4\u5212 \u2192 \u5F85\u529E \u2192 \u8FDB\u884C\u4E2D \u2192 \u5F85\u6D4B\u8BD5 \u2192 \u5DF2\u5B8C\u6210 \u2192 \u5DF2\u5931\u8D25\uFF1B\u65B0\u4EFB\u52A1\u843D\u5728\u5F85\u89C4\u5212\uFF0C\u9700\u4EBA\u5DE5\u62D6\u5230\u5F85\u529E\uFF1B\u6267\u884C\u6210\u529F\u540E\u5361\u7247\u505C\u5728\u5F85\u6D4B\u8BD5\uFF0C\u53EA\u6709\u4EBA\u5DE5\u79FB\u5230\u5DF2\u5B8C\u6210\u624D\u4F1A\u7ED3\u675F\u3002\u5DE5\u4F5C\u533A\u82E5\u662F\u672C\u5730 git \u4ED3\u5E93\uFF1A\u62D6\u5230\u5F85\u529E\u5F00 feature \u5206\u652F\u3001\u8FDB\u884C\u4E2D\u5728\u8BE5\u5206\u652F\u4E0A\u5DE5\u4F5C\u3001\u79FB\u5230\u5DF2\u5B8C\u6210\u65F6\u63D0\u4EA4\u6539\u52A8\u5E76\u628A\u5206\u652F\u5408\u5E76\u56DE\u57FA\u7EBF\u5206\u652F\u3002\u80FD\u529B\uFF1A\u591A\u5217\u770B\u677F\u7BA1\u7406\u4EFB\u52A1\uFF1BHost \u6743\u5A01\u8D26\u672C\uFF1B\u5173\u95ED\u6D4F\u89C8\u5668\u540E\u4ECD\u7531 Host \u6267\u884C\u548C\u7ED3\u7B97\uFF1B\u4EFB\u52A1\u53EF\u9489\u4F4F\u5DE5\u4F5C\u533A\u3001agent \u9884\u8BBE\u548C\u6743\u9650\uFF1B\u652F\u6301 Host \u672C\u5730\u65F6\u533A\u7684 5 \u6BB5 cron\uFF0C\u9519\u8FC7\u7684\u89E6\u53D1\u70B9\u4E0D\u8865\u8DD1\uFF1B\u53EF\u9009\u4E14\u9ED8\u8BA4\u5173\u95ED\u7684\u7A7A\u95F2\u7CFB\u7EDF\u7761\u7720\u4FDD\u62A4\u5141\u8BB8\u5C4F\u5E55\u7184\u706D\uFF0C\u4F46\u4E0D\u627F\u8BFA\u62E6\u622A\u5408\u76D6\u3001\u624B\u52A8\u7761\u7720\u3001\u4F11\u7720\u3001\u5173\u673A\u6216\u5524\u9192\u5DF2\u7761\u7720\u673A\u5668\u3002\u6267\u884C\u6D88\u8017 API \u989D\u5EA6\u3002\u7528\u6237\u63D0\u5230\u300C\u4EFB\u52A1\u770B\u677F / \u770B\u677F / \u5B9A\u65F6\u4EFB\u52A1\u300D\u65F6\u5373\u6307\u672C\u63D2\u4EF6\uFF0C\u8BF7\u636E\u6B64\u534F\u4F5C\u3002\u82E5\u4F60\u540C\u65F6\u7528 todo_write \u7EF4\u62A4\u4F1A\u8BDD\u9876\u90E8\u7684\u53EF\u89C1\u8BA1\u5212\u5217\u8868\uFF0C\u6700\u7EC8\u56DE\u590D\u524D\u5FC5\u987B\u518D\u6B21\u8C03\u7528 todo_write \u6536\u5C3E\uFF1A\u6CA1\u6709\u5269\u4F59\u5DE5\u4F5C\u65F6\u4E0D\u8981\u4FDD\u7559 in_progress\uFF0C\u5DF2\u5B8C\u6210\u7684\u6700\u540E\u4E00\u6B65\u8981\u6807\u4E3A completed\u3002";
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
     * `git.mergeBranch`, `run`, `stamp`). Absent keeps the shipped machine
     * (backlog → todo → running → ready_for_test → done/failed). An invalid
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
