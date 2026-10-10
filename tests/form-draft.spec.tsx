// @vitest-environment jsdom
/**
 * Form drafts of the task modals: a popup that is closed by an accidental click
 * next to it — or by Escape, or Cancel — keeps everything that was typed, and
 * reopening it restores that form. The draft lives in the controller's seat, so
 * it survives the popup (and even the board view) disappearing, and it is
 * dropped once the task was created/saved or the user discards it explicitly.
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { EditTagsModal, EditTaskModal } from '../src/client/board/EditTaskModal.tsx'
import { NEW_TASK_DRAFT_KEY } from '../src/client/board/TaskForm.tsx'
import { t } from '../src/client/locales.ts'
import { BoardController, type ControllerSnapshot } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Root[] = []

afterEach(() => {
  while (mounted.length > 0) unmountLast()
  document.body.replaceChildren()
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'Task A', description: 'desc', prompt: 'do it' }, 0, 't1'),
    ...overrides,
  }
}

/**
 * Controller double whose draft seat is a real Map, so save/restore/discard run
 * end to end and the board's mark reads the very keys the modals wrote.
 */
function makeController(options: {
  tasks?: TaskRecord[]
  parseTaskDraft?: (request: unknown, signal?: AbortSignal) => Promise<unknown>
  createTaskConfirmed?: (input: unknown) => Promise<TaskRecord | undefined>
} = {}) {
  const drafts = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  const created: unknown[] = []
  const state: Omit<ControllerSnapshot, 'formDrafts'> = {
    tasks: options.tasks ?? [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: [{ id: 'm1', name: 'm1' }] },
    pendingTaskIds: [],
    canParseTask: true,
  }
  const notify = (): void => { for (const fn of [...listeners]) fn() }
  const controller = {
    getSnapshot: (): ControllerSnapshot => ({
      ...state,
      ...(drafts.size === 0 ? {} : { formDrafts: [...drafts.keys()] }),
    }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getFormDraft: (key: string) => drafts.get(key),
    saveFormDraft: (key: string, value: unknown) => { drafts.set(key, value); notify() },
    discardFormDraft: (key: string) => { if (drafts.delete(key)) notify() },
    createTaskConfirmed: vi.fn(options.createTaskConfirmed ?? (async (input: unknown) => {
      created.push(input)
      return task({ id: 'created' })
    })),
    parseTaskDraft: options.parseTaskDraft ?? vi.fn(async () => ({ title: 'parsed', description: '', prompt: '' })),
    updateTask: vi.fn(async () => true),
    archiveTask: vi.fn(async () => true),
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: () => {},
    moveTask: () => {},
    moveTasks: async () => true,
  } as unknown as BoardController
  return { controller, drafts, created }
}

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push(root)
  act(() => { root.render(element) })
  return container
}

/** Unmount the most recently mounted tree (what closing a popup does). */
function unmountLast(): void {
  const root = mounted.pop()
  if (root === undefined) return
  act(() => { root.unmount() })
}

const click = (element: Element): void => {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
const pressEscape = (): void => {
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
}

const dialogOf = (container: HTMLElement): Element | null => container.querySelector('form[role="dialog"]')
const noticeOf = (container: HTMLElement): Element | null => container.querySelector('[data-draft-notice]')
const parseSection = (container: HTMLElement): Element =>
  container.querySelector('[data-dsh-part="ai-parse"]')!

/** "Click next to the popup": the backdrop is the fixed overlay behind the form. */
function closeNextToPopup(container: HTMLElement): void {
  const dialog = dialogOf(container)
  if (dialog === null) throw new Error('no popup open')
  const backdrop = dialog.parentElement
  if (backdrop === null) throw new Error('popup has no backdrop')
  act(() => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
}

const buttonWith = (container: HTMLElement, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll('button')].find(candidate => (candidate.textContent ?? '').includes(text))
  if (button === undefined) throw new Error(`no button containing ${text}`)
  return button as HTMLButtonElement
}
const fieldByPlaceholder = (container: HTMLElement, placeholder: string): HTMLInputElement | HTMLTextAreaElement => {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`)
  if (element === null) throw new Error(`no field with placeholder ${placeholder}`)
  return element
}
const typeInto = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const parseBox = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>('[data-dsh-part="ai-parse"] textarea')!
const titleField = (container: HTMLElement): HTMLInputElement =>
  fieldByPlaceholder(container, t('new.titlePlaceholder')) as HTMLInputElement
const newTaskButton = (container: HTMLElement): HTMLButtonElement => buttonWith(container, t('board.new'))

describe('a kept new-task draft survives closing the popup', () => {
  it('restores the whole form — parse text included — after a click next to the popup', () => {
    const { controller, drafts } = makeController()
    const container = mount(createElement(TaskBoard, { controller }))

    click(newTaskButton(container))
    typeInto(parseBox(container), 'Notiz: Blütenfarbe bei der Pflanzenauswahl berücksichtigen')
    typeInto(titleField(container), 'Blütenfarbe berücksichtigen')

    closeNextToPopup(container)
    expect(dialogOf(container)).toBeNull()
    // The draft sits in the controller's seat, not in the unmounted popup.
    expect(drafts.get(NEW_TASK_DRAFT_KEY)).toMatchObject({
      title: 'Blütenfarbe berücksichtigen',
      parseText: 'Notiz: Blütenfarbe bei der Pflanzenauswahl berücksichtigen',
    })
    // The board marks the waiting draft before it is opened again.
    expect(newTaskButton(container).getAttribute('data-draft')).toBe('true')

    click(newTaskButton(container))
    expect(dialogOf(container)).not.toBeNull()
    expect(parseBox(container).value).toBe('Notiz: Blütenfarbe bei der Pflanzenauswahl berücksichtigen')
    expect(titleField(container).value).toBe('Blütenfarbe berücksichtigen')
    expect(noticeOf(container)).not.toBeNull()
    expect(noticeOf(container)!.textContent).toContain(t('draft.restored'))
  })

  it('treats Escape like a click next to the popup', () => {
    const container = mount(createElement(TaskBoard, { controller: makeController().controller }))
    click(newTaskButton(container))
    typeInto(titleField(container), 'half typed')
    pressEscape()
    expect(dialogOf(container)).toBeNull()
    click(newTaskButton(container))
    expect(titleField(container).value).toBe('half typed')
  })

  it('a form nobody touched leaves no draft and no mark', () => {
    const { controller, drafts } = makeController()
    const container = mount(createElement(TaskBoard, { controller }))
    click(newTaskButton(container))
    closeNextToPopup(container)
    expect(drafts.size).toBe(0)
    expect(newTaskButton(container).getAttribute('data-draft')).toBeNull()
    click(newTaskButton(container))
    expect(noticeOf(container)).toBeNull()
    expect(titleField(container).value).toBe('')
  })

  it('"discard draft" empties the form and forgets the seat', () => {
    const { controller, drafts } = makeController()
    const container = mount(createElement(TaskBoard, { controller }))
    click(newTaskButton(container))
    typeInto(parseBox(container), 'source text')
    closeNextToPopup(container)
    click(newTaskButton(container))
    expect(noticeOf(container)).not.toBeNull()

    click(buttonWith(container, t('draft.discard')))
    expect(parseBox(container).value).toBe('')
    expect(noticeOf(container)).toBeNull()
    expect(drafts.size).toBe(0)
    closeNextToPopup(container)
    expect(newTaskButton(container).getAttribute('data-draft')).toBeNull()
  })

  it('a created task spends its draft', async () => {
    const { controller, drafts } = makeController()
    const container = mount(createElement(TaskBoard, { controller }))
    click(newTaskButton(container))
    typeInto(titleField(container), 'created once')
    typeInto(parseBox(container), 'note')
    await act(async () => {
      (container.querySelector('button[type="submit"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(dialogOf(container)).toBeNull()
    expect(drafts.size).toBe(0)

    click(newTaskButton(container))
    expect(titleField(container).value).toBe('')
    expect(parseBox(container).value).toBe('')
    expect(noticeOf(container)).toBeNull()
  })

  it('a create confirmed only after the popup closed still leaves no draft', async () => {
    let confirm: ((created: TaskRecord | undefined) => void) | undefined
    const { controller, drafts } = makeController({
      createTaskConfirmed: () => new Promise(resolve => { confirm = resolve }),
    })
    const container = mount(createElement(TaskBoard, { controller }))
    click(newTaskButton(container))
    typeInto(titleField(container), 'slow Host')
    await act(async () => {
      (container.querySelector('button[type="submit"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // The Host is still working; the user clicks next to the popup meanwhile.
    closeNextToPopup(container)
    expect(drafts.get(NEW_TASK_DRAFT_KEY)).toMatchObject({ title: 'slow Host' })

    // The confirmation lands after the popup is gone: the created form must not
    // survive as a draft (it would offer to create the same task twice).
    await act(async () => { confirm?.(task({ id: 'slow-created' })) })
    expect(drafts.size).toBe(0)
    click(newTaskButton(container))
    expect(titleField(container).value).toBe('')
  })

  it('keeps the draft when the whole board view goes away with the popup open', () => {
    const { controller, drafts } = makeController()
    const container = mount(createElement(TaskBoard, { controller }))
    click(newTaskButton(container))
    typeInto(titleField(container), 'switched away')
    // Closing the board (or switching to a session) unmounts the whole tree —
    // the popup's form must land in the seat on the way out, too.
    unmountLast()
    expect(drafts.get(NEW_TASK_DRAFT_KEY)).toMatchObject({ title: 'switched away' })

    const reopened = mount(createElement(TaskBoard, { controller }))
    expect(newTaskButton(reopened).getAttribute('data-draft')).toBe('true')
  })

  it('cancels a parse that is still running and keeps the pasted text', async () => {
    let signal: AbortSignal | undefined
    const { controller } = makeController({
      parseTaskDraft: (_request, requestSignal) => new Promise((_resolve, reject) => {
        signal = requestSignal
        requestSignal?.addEventListener('abort', () => reject(new Error('cancelled by the closing popup')))
      }),
    })
    const container = mount(createElement(TaskBoard, { controller }))
    click(newTaskButton(container))
    typeInto(parseBox(container), 'note to parse')
    await act(async () => { click(buttonWith(container, t('new.aiParseRun'))) })
    expect(signal?.aborted).toBe(false)

    closeNextToPopup(container)
    expect(signal?.aborted).toBe(true)

    click(newTaskButton(container))
    expect(parseBox(container).value).toBe('note to parse')
    // A cancelled parse reports nothing: its failure text never reappears.
    expect(parseSection(container).textContent).not.toContain('cancelled by the closing popup')
  })
})

describe('every card keeps its own edit draft', () => {
  const cardA = task({ id: 'card-a', title: 'Card A' })
  const cardB = task({ id: 'card-b', title: 'Card B' })

  it('restores the edit form of the card it belongs to only', () => {
    const { controller, drafts } = makeController({ tasks: [cardA, cardB] })
    const first = mount(createElement(EditTaskModal, { controller, task: cardA, onClose: () => {} }))
    typeInto(titleField(first), 'A changed')
    unmountLast()
    expect(drafts.get('edit:card-a')).toMatchObject({ title: 'A changed' })

    // Card B opens on its own values, not on A's draft.
    const second = mount(createElement(EditTaskModal, { controller, task: cardB, onClose: () => {} }))
    expect(titleField(second).value).toBe('Card B')
    expect(noticeOf(second)).toBeNull()
    // B untouched: closing it leaves nothing behind.
    unmountLast()
    expect(drafts.has('edit:card-b')).toBe(false)

    // A comes back where it was left.
    const third = mount(createElement(EditTaskModal, { controller, task: cardA, onClose: () => {} }))
    expect(titleField(third).value).toBe('A changed')
    expect(noticeOf(third)).not.toBeNull()
  })

  it('keeps the label edits of one card apart from another card\'s', () => {
    const { controller, drafts } = makeController({ tasks: [cardA, cardB] })
    const first = mount(createElement(EditTagsModal, { controller, task: cardA, onClose: () => {} }))
    click(buttonWith(first, t('new.tagAdd')))
    typeInto(fieldByPlaceholder(first, t('new.tagNamePlaceholder')), 'Arbeit')
    unmountLast()
    expect(drafts.get('tags:card-a')).toMatchObject({ tags: [{ name: 'Arbeit' }] })
    expect(drafts.has('tags:card-b')).toBe(false)
  })
})

describe('the controller owns the draft seat', () => {
  const makeRealController = (): BoardController => new BoardController({
    store: new InMemoryTaskStore(),
    sessions: {
      list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
      open: () => {},
    },
  })

  it('stores, lists and drops drafts, and reports them in the snapshot', () => {
    const controller = makeRealController()
    controller.start()
    const seen: ControllerSnapshot[] = []
    const unsubscribe = controller.subscribe(() => seen.push(controller.getSnapshot()))

    expect(controller.getFormDraft('new')).toBeUndefined()
    controller.saveFormDraft('new', { title: 'kept' })
    expect(controller.getFormDraft<{ title: string }>('new')).toEqual({ title: 'kept' })
    expect(controller.formDraftKeys()).toEqual(['new'])
    expect(controller.getSnapshot().formDrafts).toEqual(['new'])

    controller.discardFormDraft('new')
    expect(controller.getFormDraft('new')).toBeUndefined()
    expect(controller.getSnapshot().formDrafts).toBeUndefined()
    // Draft changes notify subscribers: the board's mark follows them.
    expect(seen).toHaveLength(2)
    unsubscribe()
    controller.dispose()
  })

  it('notifies only when a draft really changed', () => {
    const controller = makeRealController()
    controller.start()
    let notifications = 0
    const unsubscribe = controller.subscribe(() => { notifications += 1 })
    controller.discardFormDraft('never-saved')
    expect(notifications).toBe(0)
    unsubscribe()
    controller.dispose()
  })
})
