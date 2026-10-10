/**
 * Shared task-modal pieces: the overlay shell (backdrop, form, title, error,
 * footer), the title/description/prompt field trio used by both the
 * NewTaskModal and the EditTaskModal, and the "Parse with AI" box both forms
 * offer (same state machine, different opening text). State stays in the
 * owning modal; these are controlled components.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TAG_NAME_MAX_LENGTH, TAG_PROMPT_MAX_LENGTH, TASK_TAG_LIMIT, normalizeTags, type TaskRecord, type TaskTag } from '../../core/tasks.ts'
import type { BoardController } from '../../core/controller.ts'
import type { TaskBoardParseDraft } from '../../protocol.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import css from '../board.module.css'

/** DOM id shared by the tag-name inputs and their datalist (one board at a time). */
const TAG_NAME_LIST_ID = 'dsh-task-board-tag-names'

/**
 * Draft seat keys. One key per modal instance: the blank "new task" form, one
 * duplicate form per source card, and one content/label form per card — so a
 * draft kept for one card never reappears while a different card is edited.
 */
export const NEW_TASK_DRAFT_KEY = 'new'
export const duplicateDraftKey = (sourceTaskId: string): string => `duplicate:${sourceTaskId}`
export const editDraftKey = (taskId: string): string => `edit:${taskId}`
export const tagsDraftKey = (taskId: string): string => `tags:${taskId}`

/**
 * The draft a modal opens on, read once from the controller's seat. `restored`
 * drives the "draft restored" note; `discard` forgets the seat (the explicit
 * discard button, which then also puts the untouched form back on screen).
 */
export function useStoredFormDraft<T>(
  controller: BoardController,
  key: string,
): { stored: T | undefined; restored: boolean; discard: () => void } {
  const [stored] = useState(() => controller.getFormDraft?.<T>(key))
  const [restored, setRestored] = useState(stored !== undefined)
  return {
    stored,
    restored,
    discard: () => { controller.discardFormDraft?.(key); setRestored(false) },
  }
}

/**
 * Persist a modal's form into the controller's seat when the popup goes away —
 * the way an accidental click next to the popup, Escape, Cancel, or the board
 * view itself disappearing all keep what was typed. Values are read through a
 * ref, so the last render's state is what lands in the seat. A form nobody
 * touched leaves no draft behind, and `spend` retires a form whose task was
 * created or saved — even when that confirmation arrives after the popup closed.
 */
export function useFormDraftSeat<T>(
  controller: BoardController,
  key: string,
  seat: {
    /** The modal's latest field values. */
    snapshot: () => T
    /** Whether the form holds anything worth restoring (a pristine form is not a draft). */
    dirty: () => boolean
  },
): {
  /** The form became a task: drop the seat and never restore this form again. */
  spend: () => void
} {
  const latest = useRef(seat)
  latest.current = seat
  const spent = useRef(false)
  useEffect(() => () => {
    const current = latest.current
    if (!spent.current && current.dirty()) controller.saveFormDraft?.(key, current.snapshot())
    else controller.discardFormDraft?.(key)
  }, [controller, key])
  return {
    spend: () => {
      spent.current = true
      controller.discardFormDraft?.(key)
    },
  }
}

/**
 * "Draft restored" note of a modal that reopened on the form an earlier visit
 * left behind, with the one explicit way to throw it away. It sits at the top
 * of the form so a restored draft is never mistaken for a fresh, empty form.
 */
export function DraftNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <p className={css.draftNotice} data-draft-notice="">
      <span>{t('draft.restored')}</span>
      <button type="button" className={css.linkButton} onClick={onDiscard}>
        {t('draft.discard')}
      </button>
    </p>
  )
}

/** Modal overlay: closes on backdrop press or Escape, submits through the form. */
export function ModalShell({
  ariaLabel,
  title,
  error,
  pending,
  submitLabel,
  onSubmit,
  onClose,
  children,
}: {
  ariaLabel: string
  title: string
  error: string | undefined
  pending: boolean
  submitLabel: string
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}) {
  // Escape is the keyboard's click next to the popup: it closes the overlay and
  // nothing else — whatever was typed is kept as a draft by the owning modal.
  // The callback is read through a ref so the listener survives re-renders
  // (the board re-renders on every Host poll).
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [])

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <form
        className={css.modal}
        role="dialog"
        aria-label={ariaLabel}
        onSubmit={event => { event.preventDefault(); onSubmit() }}
      >
        <h2 className={css.modalTitle}>{title}</h2>

        {children}

        {error !== undefined && <p className={css.formError}>{error}</p>}

        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} onClick={onClose}>
            {t('new.cancel')}
          </button>
          <button type="submit" className={css.primaryButton} disabled={pending}>
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>
  )
}

/**
 * Opening text of an existing task's "Parse with AI" box: the source text the
 * card was created with, or — when that text is gone (cards from before the
 * box was stored, or a cleared box) — the card's own title, description, and
 * prompt as one editable block. The user can then rewrite that block and run
 * "Parse and fill" again.
 */
export function parseSourceText(task: Pick<TaskRecord, 'title' | 'description' | 'prompt' | 'parseText'>): string {
  const stored = task.parseText?.trim()
  if (stored !== undefined && stored !== '') return stored
  return [task.title, task.description, task.prompt]
    .map(part => part.trim())
    .filter(part => part !== '')
    .join('\n\n')
}

/**
 * State and actions behind one "Parse with AI" box. The owner supplies the
 * opening text and decides what a successful draft does (the create form fills
 * its three fields; the edit form overwrites the task's).
 */
export function useAiParse(
  controller: BoardController,
  initialText: string,
  onDraft: (draft: TaskBoardParseDraft) => void,
) {
  const [text, setText] = useState(initialText)
  const [models, setModels] = useState(controller.getSnapshot().executionOptions.models ?? [])
  const [model, setModel] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const abort = useRef<AbortController | undefined>(undefined)

  // The model roster arrives from the runtime after mount; follow it so the
  // picker never freezes on an empty snapshot.
  useEffect(
    () => controller.subscribe(() => setModels(controller.getSnapshot().executionOptions.models ?? [])),
    [controller],
  )

  // Default to the roster's first entry, which the user can change before parsing.
  useEffect(() => {
    if (model === '' && models.length > 0) setModel(models[0]!.id)
  }, [model, models])

  // A closing popup stops a parse that is still running: its result would land
  // in a form nobody is looking at. The pasted text itself stays in the draft.
  useEffect(() => () => { abort.current?.abort() }, [])

  const run = async (): Promise<void> => {
    const value = text.trim()
    if (value === '') {
      setError(t('new.aiParseEmpty'))
      return
    }
    const request = new AbortController()
    abort.current = request
    setPending(true)
    setError(undefined)
    try {
      onDraft(await controller.parseTaskDraft({ text: value, ...(model === '' ? {} : { model }) }, request.signal))
    } catch (failure) {
      // A cancelled parse reports nothing: the user asked for it to stop.
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      abort.current = undefined
      setPending(false)
    }
  }

  return {
    text,
    setText,
    models,
    model,
    setModel,
    pending,
    error,
    setError,
    run,
    cancel: (): void => { abort.current?.abort() },
  }
}

/**
 * The "Parse with AI" box: a source textarea, the route picker, and the
 * run/cancel button. `hintKey` lets the edit form explain that the text is the
 * card's stored source rather than a fresh paste.
 */
export function AiParseSection({
  parse,
  hintKey = 'new.aiParseHint',
}: {
  parse: ReturnType<typeof useAiParse>
  hintKey?: TaskBoardKey
}) {
  return (
    <section className={css.aiParse} data-dsh-part="ai-parse">
      <span className={css.fieldLabel}>{t('new.aiParse')}</span>
      <p className={css.fieldHint}>{t(hintKey)}</p>
      <textarea
        className={css.input}
        rows={3}
        value={parse.text}
        placeholder={t('new.aiParsePlaceholder')}
        spellCheck={false}
        onChange={event => { parse.setText(event.target.value); parse.setError(undefined) }}
      />
      <div className={css.aiParseRow}>
        <select
          className={css.select}
          value={parse.model}
          aria-label={t('new.aiParseModel')}
          onChange={event => { parse.setModel(event.target.value) }}
        >
          {parse.models.map(option => (
            <option key={option.id} value={option.id}>{option.name ?? option.id}</option>
          ))}
        </select>
        {parse.pending
          ? (
            <button type="button" className={css.ghostButton} onClick={() => { parse.cancel() }}>
              {t('new.aiParseCancel')}
            </button>
            )
          : (
            <button
              type="button"
              className={css.primaryButton}
              disabled={parse.text.trim() === ''}
              onClick={() => { void parse.run() }}
            >
              {t('new.aiParseRun')}
            </button>
            )}
      </div>
      {parse.error !== undefined && <p className={css.formError}>{parse.error}</p>}
    </section>
  )
}

/** Title + description + prompt fields shared by the new and edit task forms. */
export function TaskContentFields({
  title,
  description,
  prompt,
  onTitleChange,
  onDescriptionChange,
  onPromptChange,
}: {
  title: string
  description: string
  prompt: string
  /** Receives the new title; the owner also clears its error state. */
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onPromptChange: (value: string) => void
}) {
  return (
    <>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.title')}</span>
        <input
          className={css.input}
          value={title}
          autoFocus
          placeholder={t('new.titlePlaceholder')}
          onChange={event => onTitleChange(event.target.value)}
        />
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.description')}</span>
        <textarea
          className={css.input}
          rows={3}
          value={description}
          placeholder={t('new.descriptionPlaceholder')}
          onChange={event => onDescriptionChange(event.target.value)}
        />
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.prompt')}</span>
        <textarea
          className={css.input}
          rows={4}
          value={prompt}
          placeholder={t('new.promptPlaceholder')}
          onChange={event => onPromptChange(event.target.value)}
        />
      </label>
    </>
  )
}

/**
 * Task labels (issue #1521): one row per label holding the badge name and an
 * optional execution hint. The name inputs offer the labels already used on the
 * board through a datalist, and picking one adopts its hint when the row has
 * none — so a business line is defined once and reused by every later task.
 */
export function TaskTagFields({
  tags,
  knownTags,
  onChange,
}: {
  tags: TaskTag[]
  /** Labels already carried elsewhere on the board. */
  knownTags: TaskTag[]
  onChange: (tags: TaskTag[]) => void
}) {
  const update = (index: number, patch: Partial<TaskTag>): void => {
    onChange(tags.map((tag, position) => (position === index ? { ...tag, ...patch } : tag)))
  }

  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{t('new.tags')}</span>
      <span className={css.fieldHint}>{t('new.tagsHint')}</span>
      {tags.map((tag, index) => (
        <div className={css.tagRow} key={index}>
          <input
            className={css.input}
            list={TAG_NAME_LIST_ID}
            value={tag.name}
            maxLength={TAG_NAME_MAX_LENGTH}
            placeholder={t('new.tagNamePlaceholder')}
            aria-label={t('new.tagName')}
            onChange={(event) => {
              const name = event.target.value
              const known = knownTags.find(candidate => candidate.name === name)
              const adoptsHint = known?.promptPrefix !== undefined && (tag.promptPrefix ?? '').trim() === ''
              update(index, adoptsHint ? { name, promptPrefix: known.promptPrefix } : { name })
            }}
          />
          <input
            className={css.input}
            value={tag.promptPrefix ?? ''}
            maxLength={TAG_PROMPT_MAX_LENGTH}
            placeholder={t('new.tagPromptPlaceholder')}
            aria-label={t('new.tagPrompt')}
            onChange={event => { update(index, { promptPrefix: event.target.value }) }}
          />
          <button
            type="button"
            className={css.ghostButton}
            aria-label={t('new.tagRemove', { name: tag.name })}
            onClick={() => { onChange(tags.filter((_, position) => position !== index)) }}
          >
            ×
          </button>
        </div>
      ))}
      <datalist id={TAG_NAME_LIST_ID}>
        {knownTags.map(tag => <option key={tag.name} value={tag.name} />)}
      </datalist>
      <button
        type="button"
        className={css.ghostButton + ' ' + css.tagAddButton}
        disabled={tags.length >= TASK_TAG_LIMIT}
        onClick={() => { onChange([...tags, { name: '' }]) }}
      >
        + {t('new.tagAdd')}
      </button>
    </div>
  )
}

/**
 * Clean a tag list via normalizeTags: trim, drop blanks and duplicates, cap
 * lengths and count, so the wire always carries a valid tag list.
 */
export function cleanTags(tags: readonly TaskTag[]): TaskTag[] {
  return normalizeTags(tags) ?? []
}
