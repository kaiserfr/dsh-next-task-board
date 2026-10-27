/**
 * Task-board settings for availability, agent announcement, and optional Host
 * idle-sleep protection. Registers into the `web-ui.plugin.item` child slot
 * the Web UI plugin group renders, bound to the `task-board` namespace.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState } from 'react'
import type { TaskBoardPowerSnapshot } from '../protocol.ts'
import { PluginSettingsCard, BooleanField, ValueField } from './PluginSettingsCard.tsx'
import { CardForm, booleanField, numberField, textField, type CardActions, type CardShell, type FieldSpec, type FieldState as CardFieldState } from './settings-form.ts'
import { normalizeStateMachine, type StateMachineConfig } from '../core/state-machine.ts'
import { parseReviewEnvironments } from '../core/review-config.ts'
import { parseRepoSubpaths } from '../core/repo-config.ts'

/**
 * A JSON field: the draft is the pretty-printed document, and a save is
 * refused unless it parses AND passes the same validation the Host applies.
 * That keeps "what the card accepted" and "what the Host enforces" one rule.
 */
function jsonField(field: string, validate: (value: unknown) => string[]): FieldSpec {
  return {
    field,
    format: value => value === undefined ? '' : JSON.stringify(value, null, 2),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return undefined
      }
      return validate(parsed).length === 0 ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** The task-board fields this card edits (the namespace's full schema). */
export interface TaskBoardSettings {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Whether the board announces itself in every agent's system prompt. */
  announceToAgent?: boolean
  /** Prevent host idle sleep while sessions run or schedules are armed. */
  preventIdleSleep?: boolean
  /** WIP limit per workspace: how many implementation runs of one workspace may hold a session at once (default 1); a clarification run holds no slot. */
  maxConcurrentRuns?: number
  /** Done-column limit: on-board Done cards before the oldest is archived (default 20). */
  maxDoneTasks?: number
  /** Compose file a card's task environment is brought up from (empty: no task containers). */
  composeFile?: string
  /** Environment of a card's stack, `KEY=VALUE` pairs with `{port}`/`{task}` (e.g. `PORT={port}`). */
  composeEnv?: string
  /**
   * Review setups per workspace (JSON): the commands that start, stop, restart
   * and log the card's version, its URL template, docker context and env. A
   * compose file in the card's directory wins over these commands.
   */
  reviewEnvironments?: string
  /**
   * Repository directory per workspace (JSON): the repository inside a workspace
   * that is a container folder rather than a repository itself, so the card's
   * branch, worktree and merge work there too.
   */
  repoSubpath?: string
  /** Editor binary the worktree link launches (default `code`). */
  editorCommand?: string
  /**
   * Model route "Parse and fill" uses, as `provider/model` (default
   * `deepseek-official/deepseek-flash`). Fixed so a parse never competes with a
   * running card for a local single-slot model.
   */
  parseModel?: string
  /** Budget of one parse in milliseconds (default 120000). */
  parseTimeoutMs?: number
  /** The board's state machine: columns, allowed transitions, transition actions. */
  stateMachine?: StateMachineConfig
}

/** What the task-board card renders. */
export interface TaskBoardSettingsCardState extends CardShell {
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  /** Idle-system-sleep protection flag. */
  preventIdleSleep: CardFieldState
  /** WIP limit draft. */
  maxConcurrentRuns: CardFieldState
  /** Done-column limit draft. */
  maxDoneTasks: CardFieldState
  /** Task-environment compose file draft. */
  composeFile: CardFieldState
  /** Task-environment variables draft. */
  composeEnv: CardFieldState
  /** State-machine JSON draft. */
  stateMachine: CardFieldState
  /** Review-environment JSON draft. */
  reviewEnvironments: CardFieldState
  /** Repository-location JSON draft. */
  repoSubpath: CardFieldState
  /** Editor binary draft for the worktree link. */
  editorCommand: CardFieldState
  /** Parse model route draft. */
  parseModel: CardFieldState
  /** Parse budget draft. */
  parseTimeoutMs: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface TaskBoardSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useTaskBoardSettingsCard. */
    taskBoardSettingsCard: SnapshotStore<TaskBoardSettingsCardState>
  }
}

/** Bridges the `task-board` scope onto the card's staged form. */
export class TaskBoardSettingsCardController {
  private readonly form: CardForm<TaskBoardSettings>
  private readonly store: SnapshotStore<TaskBoardSettingsCardState>

  /** @param scope - the bound settings scope for the `task-board` namespace. */
  constructor(scope: ConfigForm<TaskBoardSettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      booleanField('preventIdleSleep'),
      numberField('maxConcurrentRuns', { integer: true, min: 1 }),
      numberField('maxDoneTasks', { integer: true, min: 1 }),
      textField('composeFile'),
      textField('composeEnv'),
      jsonField('stateMachine', value => normalizeStateMachine(value).errors),
      jsonField('reviewEnvironments', value => parseReviewEnvironments(value).errors),
      jsonField('repoSubpath', value => parseRepoSubpaths(value).errors),
      textField('editorCommand'),
      textField('parseModel'),
      numberField('parseTimeoutMs', { integer: true, min: 10_000 }),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): TaskBoardSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      preventIdleSleep: this.form.field('preventIdleSleep'),
      maxConcurrentRuns: this.form.field('maxConcurrentRuns'),
      maxDoneTasks: this.form.field('maxDoneTasks'),
      composeFile: this.form.field('composeFile'),
      composeEnv: this.form.field('composeEnv'),
      stateMachine: this.form.field('stateMachine'),
      reviewEnvironments: this.form.field('reviewEnvironments'),
      repoSubpath: this.form.field('repoSubpath'),
      editorCommand: this.form.field('editorCommand'),
      parseModel: this.form.field('parseModel'),
      parseTimeoutMs: this.form.field('parseTimeoutMs'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): TaskBoardSettingsCardFace {
    return { hooks: { taskBoardSettingsCard: this.store }, ...this.form.actions() }
  }

  /**
   * Release the card's scope subscription and bound stores; the slot
   * disposer calls this on teardown.
   */
  dispose(): void {
    this.form.dispose()
  }
}

/** Props the renderer binds for the task-board card. */
export type TaskBoardSettingsCardProps =
  PropsRuntime<'web-ui.plugin.item'>
  & PropsLocale<'task-board'>
  & InjectFace<TaskBoardSettingsCardFace>

/**
 * Render the task-board card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function TaskBoardSettingsCard(props: TaskBoardSettingsCardProps) {
  const { t } = props
  const state = props.useTaskBoardSettingsCard(snapshot => snapshot)
  const disabled = !state.writable
  const [power, setPower] = useState<TaskBoardPowerSnapshot | undefined>()
  useEffect(() => {
    // The SSE channel already carries power on every real change and pushes
    // one frame on subscribe; polling the full /state snapshot every 5 s
    // re-cloned and re-serialized the whole ledger server-side for one field.
    let live = true
    const events = new EventSource('/api/task-board/events')
    events.onmessage = (message: MessageEvent<string>): void => {
      try {
        const frame = JSON.parse(message.data) as { power?: TaskBoardPowerSnapshot }
        if (frame.power !== undefined && live) setPower(frame.power)
      } catch {
        // The settings form remains usable while the host status is reconnecting.
      }
    }
    return () => { live = false; events.close() }
  }, [])
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      defaultOpen={false}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <BooleanField
        id="settings-task-board-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <BooleanField
        id="settings-task-board-announce"
        label={t('settings.announceToAgent')}
        hint={t('settings.announceToAgentHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.announceToAgent}
        onEdit={(text) => { props.edit('announceToAgent', text) }}
        onReset={() => { props.resetField('announceToAgent') }}
      />
      <BooleanField
        id="settings-task-board-prevent-idle-sleep"
        label={t('settings.preventIdleSleep')}
        hint={t('settings.preventIdleSleepHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.preventIdleSleep}
        onEdit={(text) => { props.edit('preventIdleSleep', text) }}
        onReset={() => { props.resetField('preventIdleSleep') }}
      />
      <ValueField
        id="settings-task-board-max-concurrent-runs"
        label={t('settings.maxConcurrentRuns')}
        hint={t('settings.maxConcurrentRunsHint')}
        numeric
        {...fieldProps}
        {...state.maxConcurrentRuns}
        onEdit={(text) => { props.edit('maxConcurrentRuns', text) }}
        onReset={() => { props.resetField('maxConcurrentRuns') }}
      />
      <ValueField
        id="settings-task-board-max-done-tasks"
        label={t('settings.maxDoneTasks')}
        hint={t('settings.maxDoneTasksHint')}
        numeric
        {...fieldProps}
        {...state.maxDoneTasks}
        onEdit={(text) => { props.edit('maxDoneTasks', text) }}
        onReset={() => { props.resetField('maxDoneTasks') }}
      />
      <ValueField
        id="settings-task-board-compose-file"
        label={t('settings.composeFile')}
        hint={t('settings.composeFileHint')}
        {...fieldProps}
        {...state.composeFile}
        onEdit={(text) => { props.edit('composeFile', text) }}
        onReset={() => { props.resetField('composeFile') }}
      />
      <ValueField
        id="settings-task-board-compose-env"
        label={t('settings.composeEnv')}
        hint={t('settings.composeEnvHint')}
        {...fieldProps}
        {...state.composeEnv}
        onEdit={(text) => { props.edit('composeEnv', text) }}
        onReset={() => { props.resetField('composeEnv') }}
      />
      <ValueField
        id="settings-task-board-state-machine"
        label={t('settings.stateMachine')}
        hint={t('settings.stateMachineHint')}
        {...fieldProps}
        {...state.stateMachine}
        onEdit={(text) => { props.edit('stateMachine', text) }}
        onReset={() => { props.resetField('stateMachine') }}
      />
      <ValueField
        id="settings-task-board-review-environments"
        label={t('settings.reviewEnvironments')}
        hint={t('settings.reviewEnvironmentsHint')}
        {...fieldProps}
        {...state.reviewEnvironments}
        onEdit={(text) => { props.edit('reviewEnvironments', text) }}
        onReset={() => { props.resetField('reviewEnvironments') }}
      />
      <ValueField
        id="settings-task-board-repo-subpath"
        label={t('settings.repoSubpath')}
        hint={t('settings.repoSubpathHint')}
        {...fieldProps}
        {...state.repoSubpath}
        onEdit={(text) => { props.edit('repoSubpath', text) }}
        onReset={() => { props.resetField('repoSubpath') }}
      />
      <ValueField
        id="settings-task-board-editor-command"
        label={t('settings.editorCommand')}
        hint={t('settings.editorCommandHint')}
        {...fieldProps}
        {...state.editorCommand}
        onEdit={(text) => { props.edit('editorCommand', text) }}
        onReset={() => { props.resetField('editorCommand') }}
      />
      <ValueField
        id="settings-task-board-parse-model"
        label={t('settings.parseModel')}
        hint={t('settings.parseModelHint')}
        {...fieldProps}
        {...state.parseModel}
        onEdit={(text) => { props.edit('parseModel', text) }}
        onReset={() => { props.resetField('parseModel') }}
      />
      <ValueField
        id="settings-task-board-parse-timeout"
        label={t('settings.parseTimeoutMs')}
        hint={t('settings.parseTimeoutMsHint')}
        numeric
        {...fieldProps}
        {...state.parseTimeoutMs}
        onEdit={(text) => { props.edit('parseTimeoutMs', text) }}
        onReset={() => { props.resetField('parseTimeoutMs') }}
      />
      <p>
        {t('settings.powerStatus', {
          platform: power?.platform ?? t('settings.powerUnknown'),
          phase: power?.phase ?? t('settings.powerUnknown'),
          running: String(power?.runningSessions ?? 0),
          schedules: String(power?.armedSchedules ?? 0),
        })}
      </p>
      <p>{t('settings.powerBoundary')}</p>
      {power?.lastError !== undefined && <p>{t('settings.powerError', { error: power.lastError })}</p>}
    </PluginSettingsCard>
  )
}
