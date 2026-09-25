/**
 * Task-board client plugin: wires the framework-free core (controller,
 * execution service, store) to the real client runtime and mounts the two
 * DOM surfaces — the sidebar entry row and the board view in the center
 * column.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import { type TaskBoardSettings } from './TaskBoardSettingsCard.tsx';
import { type TaskBoardKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Task-board surface copy. */
        'task-board': TaskBoardKey;
    }
    interface SlotMap {
        /**
         * The child slot the Web UI plugin group declares; this card registers
         * into the group instead of the top-level `settings.plugin.item` list.
         * Spelled here with the same shape so this package can register without
         * depending on the sibling UI package.
         */
        'web-ui.plugin.item': {
            kind: 'list';
            scope: 'root';
            owner: SettingsPluginItemOwnerProps;
        };
    }
}
/** Owner share of a plugin card (the section supplies nothing). */
export interface SettingsPluginItemOwnerProps {
    /** Marker field: card owner props are intentionally empty. */
    children?: never;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /**
         * Optional family settings binder provided by dsh-web-settings; absent
         * when that group plugin is not installed, so callers fall back to the
         * shared configuration forms service.
         */
        webUiSettings?: SettingsFormBinder;
    }
}
/** Domain-owned description of one settings namespace a family card binds. */
export interface SettingsFormSpec<T> {
    /** Settings namespace the card edits. */
    namespace: string;
    /**
     * Narrow one wire section; undefined keeps the last accepted value. The
     * shared form already resolves the namespace's own serialized wire schema,
     * so a decoder exists only to narrow beyond that schema.
     */
    decode?: (section: unknown) => T | undefined;
}
/**
 * The family settings binder published by dsh-web-settings. Its `bind` resolves
 * a family namespace to the profile entry id that owns it and hands back the
 * shared configuration form, so it is the only seat that can reach this card's
 * form on a Host whose row id is not the namespace.
 */
export interface SettingsFormBinder {
    /** Bind one family settings namespace. */
    bind<T>(spec: SettingsFormSpec<T>): ConfigForm<T>;
}
/**
 * Required services (fiber inject waiting — the runtime must be up first).
 * The generated remote faces are probed at use time instead of injected:
 * `remote.agentPresets` only registers on 0.1.2-alpha.2 hosts (the
 * api-remotes contribution), so a hard wait would pend the entry forever
 * on hosts below that cohort, which serve the same roster through the
 * connection RPC face.
 */
export declare const inject: string[];
/**
 * Mount the task board.
 * @param ctx - client root context (services: sessions, workspaces).
 */
export declare function apply(ctx: ClientContext): void;
/**
 * Bind the settings form this card stages over.
 *
 * The family binder (`ctx.get('webUiSettings')`, published by dsh-web-settings)
 * comes first: it is what traces this package's family namespace onto the
 * profile entry id the Host serves the form under. A page without that group
 * falls back to the shared configuration forms service bound directly at one of
 * this package's own profile entry ids.
 * @param ctx - client root context.
 * @returns the form the settings card reads and writes.
 */
export declare function bindSettingsForm(ctx: ClientContext): ConfigForm<TaskBoardSettings>;
