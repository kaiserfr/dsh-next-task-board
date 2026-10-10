/**
 * Edit-task modal: title + description + the prompt the next execution will
 * send, pre-filled from the task, plus the task's "Parse with AI" source text
 * so the user can rewrite it and fill the fields again. Shown only for tasks
 * that still sit in a pre-execution column (the detail view gates on
 * canEditTaskContent); the Host still re-checks at submit, so a task that
 * started running while the modal was open fails closed and the error surfaces
 * here.
 */
import { useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { collectKnownTags, type TaskRecord, type TaskTag } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import { AiParseSection, DraftNotice, ModalShell, TaskContentFields, TaskTagFields, cleanTags, editDraftKey, parseSourceText, tagsDraftKey, useAiParse, useFormDraftSeat, useStoredFormDraft } from './TaskForm.tsx'

/** Everything the edit-content form carries (the draft seat's payload). */
interface EditTaskForm {
  title: string
  description: string
  prompt: string
  tags: TaskTag[]
  parseText: string
}

/** Edit-task form overlay. */
export function EditTaskModal({ controller, task, onClose }: { controller: BoardController; task: TaskRecord; onClose: () => void }) {
  const draftKey = editDraftKey(task.id)
  const { stored, restored, discard: forgetDraft } = useStoredFormDraft<EditTaskForm>(controller, draftKey)
  const [canParse] = useState(controller.getSnapshot().canParseTask === true)
  // The box opens on the text the card was created with; when that text is
  // gone it opens on the card's own title/description/prompt, so the user can
  // rewrite that block and run "Parse and fill" again. That fallback is derived
  // and stays frozen for the modal's lifetime, so it can be told apart from a
  // text the user actually worked in.
  const [openingText] = useState(() => parseSourceText(task))
  // The task as it stands: the untouched form here, and what "discard draft"
  // falls back to.
  const [pristine] = useState<EditTaskForm>(() => ({
    title: task.title,
    description: task.description,
    prompt: task.prompt,
    tags: task.tags ?? [],
    parseText: openingText,
  }))
  const [title, setTitle] = useState(stored?.title ?? pristine.title)
  const [description, setDescription] = useState(stored?.description ?? pristine.description)
  const [prompt, setPrompt] = useState(stored?.prompt ?? pristine.prompt)
  const [tags, setTags] = useState<TaskTag[]>(stored?.tags ?? pristine.tags)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const parse = useAiParse(controller, stored?.parseText ?? pristine.parseText, draft => {
    setTitle(draft.title)
    setDescription(draft.description)
    setPrompt(draft.prompt)
  })

  /** The whole form as one value: the draft seat's payload. */
  const form = (): EditTaskForm => ({ title, description, prompt, tags, parseText: parse.text })

  /** Put one whole form on screen (opening on a draft, or discarding it). */
  const applyForm = (value: EditTaskForm): void => {
    setTitle(value.title)
    setDescription(value.description)
    setPrompt(value.prompt)
    setTags(value.tags)
    parse.setText(value.parseText)
  }

  // Closing the popup (backdrop, Escape, Cancel) keeps the edits in the seat.
  const { spend } = useFormDraftSeat(controller, draftKey, {
    snapshot: form,
    dirty: () => JSON.stringify(form()) !== JSON.stringify(pristine),
  })

  /** "Discard draft": forget the seat and show the task's stored values again. */
  const discardDraft = (): void => {
    forgetDraft()
    applyForm(pristine)
    setError(undefined)
  }

  const submit = async (): Promise<void> => {
    if (title.trim() === '') {
      setError(t('new.required'))
      return
    }
    setPending(true)
    // The Host confirms the mutation (and its fail-closed checks); only a
    // confirmed save closes the modal.
    // Labels ride the same patch as the content fields. A task that never
    // carried one is not sent a clearing null: the wire stays minimal, and the
    // no-tags path keeps producing exactly the patch it produced before.
    const tagList = cleanTags(tags)
    const patch = {
      title,
      description,
      prompt,
      // The source round-trips only where the deployment can parse, and only
      // when the user actually worked in the box: an untouched box leaves the
      // stored text as it is, so a card that never used the box does not
      // suddenly carry the derived fallback as its source.
      ...(canParse && parse.text !== openingText ? { parseText: parse.text } : {}),
      ...(tagList.length > 0 ? { tags: tagList } : (task.tags === undefined ? {} : { tags: null })),
    }
    if (await controller.updateTask(task.id, patch)) {
      // The edits are stored: the form's draft is spent.
      spend()
      onClose()
      return
    }
    setPending(false)
    setError(controller.getSnapshot().transportError ?? t('new.required'))
  }

  return (
    <ModalShell
      ariaLabel={t('edit.title')}
      title={t('edit.title')}
      error={error}
      pending={pending}
      submitLabel={t('edit.save')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
    >
      {restored && <DraftNotice onDiscard={discardDraft} />}

      {canParse && <AiParseSection parse={parse} hintKey="edit.aiParseHint" />}

      <TaskContentFields
        title={title}
        description={description}
        prompt={prompt}
        onTitleChange={value => { setTitle(value); setError(undefined) }}
        onDescriptionChange={setDescription}
        onPromptChange={setPrompt}
      />

      <TaskTagFields tags={tags} knownTags={collectKnownTags(controller.getSnapshot().tasks)} onChange={setTags} />

    </ModalShell>
  )
}

/** Edit-tags modal: edit labels only, shown for tasks after first execution. */
export function EditTagsModal({ controller, task, onClose }: { controller: BoardController; task: TaskRecord; onClose: () => void }) {
  const draftKey = tagsDraftKey(task.id)
  const { stored, restored, discard: forgetDraft } = useStoredFormDraft<{ tags: TaskTag[] }>(controller, draftKey)
  const pristine = task.tags ?? []
  const [tags, setTags] = useState<TaskTag[]>(stored?.tags ?? pristine)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  /** The whole form as one value: the draft seat's payload. */
  const form = (): { tags: TaskTag[] } => ({ tags })

  // Closing the popup (backdrop, Escape, Cancel) keeps the label edits.
  const { spend } = useFormDraftSeat(controller, draftKey, {
    snapshot: form,
    dirty: () => JSON.stringify(tags) !== JSON.stringify(pristine),
  })

  /** "Discard draft": forget the seat and show the task's stored labels again. */
  const discardDraft = (): void => {
    forgetDraft()
    setTags(pristine)
    setError(undefined)
  }

  const submit = async (): Promise<void> => {
    setPending(true)
    const tagList = cleanTags(tags)
    const patch = {
      tags: tagList.length > 0 ? tagList : null,
    }
    if (await controller.updateTask(task.id, patch)) {
      spend()
      onClose()
      return
    }
    setPending(false)
    setError(controller.getSnapshot().transportError ?? t('new.required'))
  }

  return (
    <ModalShell
      ariaLabel={t('detail.editTags')}
      title={t('detail.editTags')}
      error={error}
      pending={pending}
      submitLabel={t('edit.save')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
    >
      {restored && <DraftNotice onDiscard={discardDraft} />}

      <TaskTagFields tags={tags} knownTags={collectKnownTags(controller.getSnapshot().tasks)} onChange={setTags} />
    </ModalShell>
  )
}

