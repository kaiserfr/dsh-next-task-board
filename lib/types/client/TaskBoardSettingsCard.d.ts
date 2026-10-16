/**
 * Task-board settings for availability, agent announcement, and optional Host
 * idle-sleep protection. Registers into the `web-ui.plugin.item` child slot
 * the Web UI plugin group renders, bound to the `task-board` namespace.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import { type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts';
import { type StateMachineConfig } from '../core/state-machine.ts';
/** The task-board fields this card edits (the namespace's full schema). */
export interface TaskBoardSettings {
    /** Master switch for the plugin. */
    enabled?: boolean;
    /** Whether the board announces itself in every agent's system prompt. */
    announceToAgent?: boolean;
    /** Prevent host idle sleep while sessions run or schedules are armed. */
    preventIdleSleep?: boolean;
    /** WIP limit per workspace: how many implementation runs of one workspace may hold a session at once (default 1); a `todo` clarification run holds no slot. */
    maxConcurrentRuns?: number;
    /** Done-column limit: on-board Done cards before the oldest is archived (default 20). */
    maxDoneTasks?: number;
    /** Compose file a card's task environment is brought up from (empty: no task containers). */
    composeFile?: string;
    /** Environment of a card's stack, `KEY=VALUE` pairs with `{port}`/`{task}` (e.g. `PORT={port}`). */
    composeEnv?: string;
    /**
     * Review setups per workspace (JSON): the commands that start, stop, restart
     * and log the card's version, its URL template, docker context and env. A
     * compose file in the card's directory wins over these commands.
     */
    reviewEnvironments?: string;
    /**
     * Repository directory per workspace (JSON): the repository inside a workspace
     * that is a container folder rather than a repository itself, so the card's
     * branch, worktree and merge work there too.
     */
    repoSubpath?: string;
    /** Editor binary the worktree link launches (default `code`). */
    editorCommand?: string;
    /** The board's state machine: columns, allowed transitions, transition actions. */
    stateMachine?: StateMachineConfig;
}
/** What the task-board card renders. */
export interface TaskBoardSettingsCardState extends CardShell {
    /** Master switch. */
    enabled: CardFieldState;
    /** System-prompt announcement flag. */
    announceToAgent: CardFieldState;
    /** Idle-system-sleep protection flag. */
    preventIdleSleep: CardFieldState;
    /** WIP limit draft. */
    maxConcurrentRuns: CardFieldState;
    /** Done-column limit draft. */
    maxDoneTasks: CardFieldState;
    /** Task-environment compose file draft. */
    composeFile: CardFieldState;
    /** Task-environment variables draft. */
    composeEnv: CardFieldState;
    /** State-machine JSON draft. */
    stateMachine: CardFieldState;
    /** Review-environment JSON draft. */
    reviewEnvironments: CardFieldState;
    /** Repository-location JSON draft. */
    repoSubpath: CardFieldState;
    /** Editor binary draft for the worktree link. */
    editorCommand: CardFieldState;
}
/** The registration-side face the card's slot entry injects. */
export interface TaskBoardSettingsCardFace extends CardActions {
    hooks: {
        /** Card snapshot bound by the renderer as useTaskBoardSettingsCard. */
        taskBoardSettingsCard: SnapshotStore<TaskBoardSettingsCardState>;
    };
}
/** Bridges the `task-board` scope onto the card's staged form. */
export declare class TaskBoardSettingsCardController {
    private readonly form;
    private readonly store;
    /** @param scope - the bound settings scope for the `task-board` namespace. */
    constructor(scope: ConfigForm<TaskBoardSettings>);
    private projection;
    /**
     * Build the face the card's slot registration injects.
     * @returns the card's snapshot and its form actions.
     */
    inject(): TaskBoardSettingsCardFace;
    /**
     * Release the card's scope subscription and bound stores; the slot
     * disposer calls this on teardown.
     */
    dispose(): void;
}
/** Props the renderer binds for the task-board card. */
export type TaskBoardSettingsCardProps = PropsRuntime<'web-ui.plugin.item'> & PropsLocale<'task-board'> & InjectFace<TaskBoardSettingsCardFace>;
/**
 * Render the task-board card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export declare function TaskBoardSettingsCard(props: TaskBoardSettingsCardProps): import("react").JSX.Element;
