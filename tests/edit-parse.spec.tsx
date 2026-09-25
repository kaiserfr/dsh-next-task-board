// @vitest-environment jsdom
/**
 * The edit-task form's "Parse with AI" box: a task waiting in backlog/todo
 * keeps the source text it was created with, so the user can change it and run
 * "Parse and fill" again. When that text is gone the box opens on the card's
 * own title/description/prompt instead of an empty field.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditTaskModal } from '../src/client/board/EditTaskModal.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskUpdatePatch } from '../src/core/use-cases/task-update.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

const draft = { title: 'Parsed title', description: 'Parsed description', prompt: 'Parsed prompt' }

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'Task A', description: 'desc', prompt: 'do it' }, 0, 't1'),
    ...overrides,
  }
}

function renderEdit(
  taskRecord: TaskRecord,
  options: { canParseTask?: boolean; parseTaskDraft?: ReturnType<typeof vi.fn> } = {},
): { container: HTMLElement; updateTask: ReturnType<typeof vi.fn>; parseTaskDraft: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const updateTask = vi.fn(async () => true)
  const parseTaskDraft = (options.parseTaskDraft ?? vi.fn(async () => draft)) as ReturnType<typeof vi.fn>
  const snapshot: ControllerSnapshot = {
    tasks: [taskRecord],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: taskRecord.id,
    executionOptions: {
      workspaces: [],
      presets: [],
      models: [{ id: 'deepseek/deepseek-chat', name: 'deepseek-chat' }],
    },
    pendingTaskIds: [],
    ...(options.canParseTask === false ? {} : { canParseTask: true }),
  }
  const onClose = vi.fn()
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    updateTask,
    parseTaskDraft,
  } as unknown as BoardController
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<EditTaskModal controller={controller} task={taskRecord} onClose={onClose} />) })
  return { container, updateTask, parseTaskDraft, onClose }
}

function parseBox(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>(`[data-dsh-part="ai-parse"] [placeholder="${t('new.aiParsePlaceholder')}"]`)
  if (element === null) throw new Error('no parse box')
  return element
}

function parseButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === t('new.aiParseRun'))
  if (button === undefined) throw new Error('no parse button')
  return button as HTMLButtonElement
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button[type="submit"]') as HTMLButtonElement
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('edit-task parse box', () => {
  it('opens on the source text the card was created with', () => {
    const { container } = renderEdit(task({ parseText: 'stored source text' }))
    expect(parseBox(container).value).toBe('stored source text')
  })

  it('seeds the box from title, description, and prompt when the source is gone', () => {
    const { container } = renderEdit(task())
    expect(parseBox(container).value).toBe('Task A\n\ndesc\n\ndo it')
  })

  it('skips blank parts of the seed', () => {
    const { container } = renderEdit(task({ description: '   ' }))
    expect(parseBox(container).value).toBe('Task A\n\ndo it')
  })

  it('parses and fills again from the stored text', async () => {
    const { container, parseTaskDraft } = renderEdit(task({ parseText: 'stored source text' }))
    await act(async () => { parseButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(parseTaskDraft).toHaveBeenCalledOnce()
    expect(parseTaskDraft.mock.calls[0]![0]).toEqual({ text: 'stored source text', model: 'deepseek/deepseek-chat' })
    const textareas = container.querySelectorAll('textarea')
    // The parse box comes first, then description and prompt.
    expect((textareas[1] as HTMLTextAreaElement).value).toBe(draft.description)
    expect((textareas[2] as HTMLTextAreaElement).value).toBe(draft.prompt)
    expect((container.querySelector('input') as HTMLInputElement).value).toBe(draft.title)
  })

  it('saves the edited source text with the content patch', async () => {
    const { container, updateTask, onClose } = renderEdit(task({ parseText: 'stored source text' }))
    typeInto(parseBox(container), 'rewritten source')
    await act(async () => { saveButton(container).click() })

    const patch = updateTask.mock.calls[0]![1] as TaskUpdatePatch
    expect(updateTask.mock.calls[0]![0]).toBe('t1')
    expect(patch).toEqual({ title: 'Task A', description: 'desc', prompt: 'do it', parseText: 'rewritten source' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('leaves the stored source alone when the box was not touched', async () => {
    const { container, updateTask } = renderEdit(task({ parseText: 'stored source text' }))
    typeInto(container.querySelector('input') as HTMLInputElement, 'Renamed')
    await act(async () => { saveButton(container).click() })

    expect(updateTask.mock.calls[0]![1]).toEqual({ title: 'Renamed', description: 'desc', prompt: 'do it' })
  })

  it('does not turn the derived fallback into a stored source', async () => {
    const { container, updateTask } = renderEdit(task())
    typeInto(container.querySelector('input') as HTMLInputElement, 'Renamed')
    await act(async () => { saveButton(container).click() })

    expect(updateTask.mock.calls[0]![1]).not.toHaveProperty('parseText')
  })

  it('stays hidden when the deployment cannot parse', () => {
    const { container } = renderEdit(task({ parseText: 'stored source text' }), { canParseTask: false })
    expect(container.querySelector('[data-dsh-part="ai-parse"]')).toBeNull()
  })
})
