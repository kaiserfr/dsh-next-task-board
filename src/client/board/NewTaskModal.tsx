/**
 * New-task modal: title + description + the prompt that execution will send.
 * Creates through the Host and closes only after the Host confirms it.
 */
import { useEffect, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { isValidCron, nextRunAtMs } from '../../core/schedule.ts'
import { parseFreezeRequest } from '../../core/freeze-snapshot.ts'
import { collectKnownTags, TASK_PERMISSIONS, type TaskPermission, type TaskRecord, type TaskTag } from '../../core/tasks.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { SCHEDULE_PRESETS } from '../schedule-presets.ts'
import { ModalShell, TaskContentFields, TaskTagFields, AiParseSection, useAiParse, cleanTags, DraftNotice, NEW_TASK_DRAFT_KEY, duplicateDraftKey, useFormDraftSeat, useStoredFormDraft } from './TaskForm.tsx'
import css from '../board.module.css'

export interface NewTaskModalProps {
  controller: BoardController
  onClose: () => void
  /** Optional task template to clone/duplicate from. */
  initialTask?: TaskRecord
  /**
   * Workspace the board's project filter has selected (#1536): a task created
   * while a project is open belongs to that project unless the user changes it.
   */
  defaultWorkspaceId?: string
  /** Optional callback after successful duplication (e.g. to archive source). */
  onDuplicateSuccess?: (sourceTaskId: string) => Promise<void>
}

/**
 * Everything the new-task form carries. The draft seat stores exactly this, so
 * a popup closed next to the popup reopens where it was left — the "Parse with
 * AI" source text included.
 */
interface NewTaskForm {
  title: string
  description: string
  prompt: string
  workspaceId: string
  mode: string
  permission: string
  model: string
  reuseSession: boolean
  scheduleEnabled: boolean
  scheduleCron: string
  freezeText: string
  handoverText: string
  tags: TaskTag[]
  archiveOriginal: boolean
  parseText: string
}

/** New-task form overlay. */
export function NewTaskModal({ controller, onClose, initialTask, defaultWorkspaceId, onDuplicateSuccess }: NewTaskModalProps) {
  const isDuplicate = initialTask !== undefined
  // A duplicate popup keeps its own draft per source card: what was typed while
  // duplicating card A must not appear when duplicating card B.
  const draftKey = isDuplicate ? duplicateDraftKey(initialTask.id) : NEW_TASK_DRAFT_KEY
  const { stored, restored, discard: forgetDraft } = useStoredFormDraft<NewTaskForm>(controller, draftKey)
  // The untouched form: what "discard draft" falls back to, and the yardstick
  // that keeps a form nobody worked in from becoming a draft.
  const [pristine] = useState<NewTaskForm>(() => ({
    title: initialTask?.title ?? '',
    description: initialTask?.description ?? '',
    prompt: initialTask?.prompt ?? '',
    workspaceId: initialTask?.workspaceId ?? defaultWorkspaceId ?? '',
    mode: initialTask?.mode ?? '',
    permission: initialTask?.permission ?? '',
    model: initialTask?.model ?? '',
    reuseSession: initialTask?.reuseSession ?? false,
    scheduleEnabled: initialTask?.schedule?.enabled ?? false,
    scheduleCron: initialTask?.schedule?.cron ?? '',
    freezeText: '',
    handoverText: initialTask?.handover?.references !== undefined ? initialTask.handover.references.join('\n') : '',
    tags: initialTask?.tags ?? [],
    archiveOriginal: true,
    parseText: initialTask?.parseText ?? '',
  }))
  const [title, setTitle] = useState(stored?.title ?? pristine.title)
  const [description, setDescription] = useState(stored?.description ?? pristine.description)
  const [prompt, setPrompt] = useState(stored?.prompt ?? pristine.prompt)
  const [workspaceId, setWorkspaceId] = useState(stored?.workspaceId ?? pristine.workspaceId)
  const [mode, setMode] = useState(stored?.mode ?? pristine.mode)
  const [permission, setPermission] = useState(stored?.permission ?? pristine.permission)
  const [model, setModel] = useState(stored?.model ?? pristine.model)
  const [reuseSession, setReuseSession] = useState(stored?.reuseSession ?? pristine.reuseSession)
  const [scheduleEnabled, setScheduleEnabled] = useState(stored?.scheduleEnabled ?? pristine.scheduleEnabled)
  const [scheduleCron, setScheduleCron] = useState(stored?.scheduleCron ?? pristine.scheduleCron)
  const [scheduleError, setScheduleError] = useState<string | undefined>(undefined)
  const [freezeText, setFreezeText] = useState(stored?.freezeText ?? pristine.freezeText)
  const [freezeError, setFreezeError] = useState<string | undefined>(undefined)
  const [handoverText, setHandoverText] = useState(stored?.handoverText ?? pristine.handoverText)
  const [tags, setTags] = useState<TaskTag[]>(stored?.tags ?? pristine.tags)
  const [archiveOriginal, setArchiveOriginal] = useState(stored?.archiveOriginal ?? pristine.archiveOriginal)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [options, setOptions] = useState(controller.getSnapshot().executionOptions)
  // "Parse pasted text" (issue #1540) exists only when the deployment carries a
  // parse face; the section stays hidden otherwise.
  const [canParse] = useState(controller.getSnapshot().canParseTask === true)
  // The source text lives on the created task, so editing the card later offers
  // the same text again ("parse and fill again") instead of losing it; a
  // duplicate starts from the source's text. A kept draft has the last word.
  const parse = useAiParse(controller, stored?.parseText ?? pristine.parseText, draft => {
    setTitle(draft.title)
    setDescription(draft.description)
    setPrompt(draft.prompt)
  })

  /** The whole form as one value: the draft seat's payload. */
  const form = (): NewTaskForm => ({
    title,
    description,
    prompt,
    workspaceId,
    mode,
    permission,
    model,
    reuseSession,
    scheduleEnabled,
    scheduleCron,
    freezeText,
    handoverText,
    tags,
    archiveOriginal,
    parseText: parse.text,
  })

  /** Put one whole form on screen (opening on a draft, or discarding it). */
  const applyForm = (value: NewTaskForm): void => {
    setTitle(value.title)
    setDescription(value.description)
    setPrompt(value.prompt)
    setWorkspaceId(value.workspaceId)
    setMode(value.mode)
    setPermission(value.permission)
    setModel(value.model)
    setReuseSession(value.reuseSession)
    setScheduleEnabled(value.scheduleEnabled)
    setScheduleCron(value.scheduleCron)
    setFreezeText(value.freezeText)
    setHandoverText(value.handoverText)
    setTags(value.tags)
    setArchiveOriginal(value.archiveOriginal)
    parse.setText(value.parseText)
  }

  // Closing the popup — backdrop, Escape, Cancel, or the board going away —
  // keeps the form in the controller's seat instead of dropping it.
  const { spend } = useFormDraftSeat(controller, draftKey, {
    snapshot: form,
    dirty: () => JSON.stringify(form()) !== JSON.stringify(pristine),
  })

  /** "Discard draft": forget the seat and start from the untouched form again. */
  const discardDraft = (): void => {
    forgetDraft()
    applyForm(pristine)
    setScheduleError(undefined)
    setFreezeError(undefined)
    setError(undefined)
  }

  // The workspace list and preset roster arrive from the runtime after mount;
  // follow them so the pickers never freeze on an empty snapshot.
  useEffect(
    () => controller.subscribe(() => setOptions(controller.getSnapshot().executionOptions)),
    [controller],
  )

  const submit = async (): Promise<void> => {
    if (scheduleEnabled) {
      const cron = scheduleCron.trim()
      if (cron === '' || !isValidCron(cron)) {
        setScheduleError(t('detail.schedule.invalid'))
        return
      }
    }
    // Optional continuation-card snapshot: parse the freeze block through the
    // T2 gate (structure + redaction + taint + size); a malformed block stops
    // submission with the parser's error instead of creating a plain task.
    let freeze: Parameters<typeof controller.createTaskConfirmed>[0]['freeze'] = undefined
    if (freezeText.trim() !== '') {
      const parsed = parseFreezeRequest(freezeText)
      if (!parsed.ok) {
        setFreezeError(parsed.error.message)
        return
      }
      freeze = { ...parsed.snapshot, ...(parsed.warnings.includes('redacted') ? { redacted: true } : {}) }
    }
    // Optional handover bundle: non-empty reference lines attach the picked
    // triplet (workspace/mode/permission above) plus the references.
    const references = handoverText.split('\n').map(line => line.trim()).filter(line => line !== '')
    const handover = references.length === 0 ? undefined : {
      references,
      workspaceId: workspaceId === '' ? undefined : workspaceId,
      mode: mode === '' ? undefined : mode,
      permission: permission === '' ? undefined : permission as TaskPermission,
    }
    // Blank rows never reach the wire: the protocol rejects a tag with an
    // empty name, and an empty list is expressed by omitting the field.
    const tagList = cleanTags(tags)
    setPending(true)
    const task = await controller.createTaskConfirmed({
      title,
      description,
      prompt,
      // Keep the parse box's source text on the card: the edit form offers it
      // again, and the field is dropped entirely when the box stayed empty.
      ...(canParse && parse.text.trim() !== '' ? { parseText: parse.text } : {}),
      freeze,
      handover,
      workspaceId: workspaceId === '' ? undefined : workspaceId,
      mode: mode === '' ? undefined : mode,
      permission: permission === '' ? undefined : permission as TaskPermission,
      model: model === '' ? undefined : model,
      ...(reuseSession ? { reuseSession: true } : {}),
      ...(tagList.length > 0 ? { tags: tagList } : {}),
      schedule: scheduleEnabled ? { enabled: true, cron: scheduleCron.trim() } : undefined,
    })
    if (task === undefined) {
      setPending(false)
      setError(controller.getSnapshot().transportError ?? t('new.required'))
      return
    }
    if (isDuplicate && archiveOriginal && initialTask !== undefined) {
      if (onDuplicateSuccess !== undefined) {
        await onDuplicateSuccess(initialTask.id)
      } else {
        await controller.archiveTask(initialTask.id)
      }
    }
    // The form became a card: its draft is spent and must not come back, even
    // when this confirmation arrives after the popup was already closed.
    spend()
    onClose()
  }

  /** Next-run preview for a valid armed cron (creation-time only). */
  const scheduleNextRun = scheduleEnabled && scheduleCron.trim() !== '' && isValidCron(scheduleCron)
    ? nextRunAtMs(scheduleCron, Date.now())
    : undefined

  const modalTitle = isDuplicate ? t('new.duplicateTitle') : t('board.new')

  return (
    <ModalShell
      ariaLabel={modalTitle}
      title={modalTitle}
      error={error}
      pending={pending}
      submitLabel={t('new.submit')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
    >
      {restored && <DraftNotice onDiscard={discardDraft} />}

      {canParse && <AiParseSection parse={parse} />}

      <TaskContentFields
        title={title}
        description={description}
        prompt={prompt}
        onTitleChange={value => { setTitle(value); setError(undefined) }}
        onDescriptionChange={setDescription}
        onPromptChange={setPrompt}
      />

      <TaskTagFields tags={tags} knownTags={collectKnownTags(controller.getSnapshot().tasks)} onChange={setTags} />

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.freeze')}</span>
          <textarea
            className={css.input}
            rows={4}
            value={freezeText}
            placeholder={t('new.freezePlaceholder')}
            spellCheck={false}
            onChange={event => { setFreezeText(event.target.value); setFreezeError(undefined) }}
          />
        </label>
        {freezeError !== undefined && <p className={css.formError}>{freezeError}</p>}

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.handover')}</span>
          <textarea
            className={css.input}
            rows={3}
            value={handoverText}
            placeholder={t('new.handoverPlaceholder')}
            spellCheck={false}
            onChange={event => { setHandoverText(event.target.value) }}
          />
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.workspace')}</span>
          <select
            className={css.select}
            value={workspaceId}
            onChange={event => { setWorkspaceId(event.target.value) }}
          >
            <option value="">{t('exec.workspace.recent')}</option>
            {options.workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.mode')}</span>
          <select
            className={css.select}
            value={mode}
            onChange={event => { setMode(event.target.value) }}
          >
            <option value="">{t('exec.mode.default')}</option>
            {options.presets.map(preset => (
              <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
                {preset.name ?? preset.id}
                {preset.isDefault ? t('exec.mode.defaultSuffix') : ''}
                {preset.broken !== undefined ? t('exec.mode.brokenSuffix') : ''}
              </option>
            ))}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.permission')}</span>
          <select
            className={css.select}
            value={permission}
            onChange={event => { setPermission(event.target.value) }}
          >
            <option value="">{t('exec.permission.default')}</option>
            {TASK_PERMISSIONS.map(id => (
              <option key={id} value={id}>{t(`exec.permission.${id}` as TaskBoardKey)}</option>
            ))}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.model')}</span>
          <select
            className={css.select}
            value={model}
            onChange={event => { setModel(event.target.value) }}
          >
            <option value="">{t('exec.model.default')}</option>
            {options.models?.map(item => (
              <option key={item.id} value={item.id}>{item.name ?? item.id}</option>
            ))}
          </select>
        </label>

        <label className={css.scheduleToggle}>
          <input
            type="checkbox"
            checked={reuseSession}
            onChange={event => { setReuseSession(event.target.checked) }}
          />
          <span>{t('exec.reuseSession')}</span>
        </label>
        <p className={css.detailText}>{t('exec.reuseSessionHint')}</p>

        <section className={css.detailSection}>
          <h4>{t('detail.schedule')}</h4>
          <label className={css.scheduleToggle}>
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={event => {
                setScheduleEnabled(event.target.checked)
                if (!event.target.checked) setScheduleError(undefined)
              }}
            />
            <span>{t('detail.schedule.enable')}</span>
          </label>
          {scheduleEnabled && (
            <>
              <div className={css.scheduleRow}>
                <input
                  className={`${css.input} ${css.scheduleInput}${scheduleError !== undefined ? ` ${css.scheduleInputInvalid}` : ''}`}
                  value={scheduleCron}
                  placeholder="0 9 * * *"
                  spellCheck={false}
                  aria-label={t('detail.schedule.cron')}
                  onChange={event => { setScheduleCron(event.target.value); setScheduleError(undefined) }}
                />
                <select
                  className={css.schedulePreset}
                  value=""
                  aria-label={t('detail.schedule.presets')}
                  onChange={event => {
                    if (event.target.value === '') return
                    setScheduleCron(event.target.value)
                    setScheduleError(undefined)
                  }}
                >
                  <option value="">{t('detail.schedule.presets')}…</option>
                  {SCHEDULE_PRESETS.map(preset => (
                    <option key={preset.cron} value={preset.cron}>{t(preset.label)}</option>
                  ))}
                </select>
              </div>
              {scheduleError !== undefined && <p className={css.formError}>{scheduleError}</p>}
              {scheduleError === undefined && scheduleNextRun !== undefined && (
                <p className={css.scheduleMeta}>
                  {t('detail.schedule.nextRun')} {new Date(scheduleNextRun).toLocaleString()}
                </p>
              )}
            </>
          )}
        </section>
        {isDuplicate && (
          <label className={css.checkboxLabel} style={{ marginTop: '12px' }}>
            <input
              type="checkbox"
              checked={archiveOriginal}
              onChange={event => { setArchiveOriginal(event.target.checked) }}
            />
            <span>{t('new.archiveOriginal')}</span>
          </label>
        )}
    </ModalShell>
  )
}
