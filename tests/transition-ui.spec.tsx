// @vitest-environment jsdom
/**
 * Transition buttons and queue feedback in the detail popup and on the card:
 * all machine transitions get a button (including the clarify step and run
 * starts), hard blockers disable it with a reason, and a waiting intent stays
 * visible/cancellable.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-dsh-taskboard-active')
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Task A', description: '', prompt: 'do it' }, 0, 'task-1'), ...overrides }
}

const openRun = (): ExecutionRecord => ({
  id: 'e1', sessionId: undefined, startedAt: 1, endedAt: undefined, result: undefined, error: undefined,
})

function detailController(
  taskRecord: TaskRecord,
  overrides: Partial<ControllerSnapshot> = {},
  calls: { cancel?: (id: string) => void; move?: (id: string, status: string) => void } = {},
): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [taskRecord],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: taskRecord.id,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    ...overrides,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    closeTask: () => {},
    retryHostSync: async () => true,
    openSession: () => {},
    updateTask: async () => true,
    moveTask: (id: string, status: string) => { calls.move?.(id, status) },
    cancelTransition: (id: string) => { calls.cancel?.(id) },
    deleteTask: () => {},
    archiveTask: () => true,
    restoreTask: () => true,
    rerunTask: async () => {},
    pauseTasks: async () => false,
    resumeTasks: async () => false,
    setSchedule: () => true,
    isHostBacked: () => true,
  } as unknown as BoardController
}

function renderDetail(
  taskRecord: TaskRecord,
  overrides: Partial<ControllerSnapshot> = {},
  calls: { cancel?: (id: string) => void; move?: (id: string, status: string) => void } = {},
): { container: HTMLElement; controller: BoardController } {
  const controller = detailController(taskRecord, overrides, calls)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<TaskDetail controller={controller} task={taskRecord} />) })
  return { container, controller }
}

function transitionTargets(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-dsh-part="transition-button"]'))
    .map(button => button.getAttribute('data-target') ?? '')
}

function transitionButton(container: HTMLElement, target: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[data-dsh-part="transition-button"][data-target="${target}"]`)
  if (found === null) throw new Error(`no transition button for ${target}`)
  return found
}

function reasonOf(button: HTMLButtonElement): string | null {
  return button.closest('span')?.getAttribute('title') ?? null
}

function boardController(
  tasks: TaskRecord[],
  snapshotOverrides: Partial<ControllerSnapshot> = {},
  overrides: Partial<BoardController> = {},
): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks,
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    ...snapshotOverrides,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => true,
    openTask: () => {},
    moveTask: () => {},
    moveTasks: async () => true,
    noteTransitionBlocked: () => {},
    archiveTask: () => true,
    deleteTask: () => {},
    pauseTasks: async () => false,
    resumeTasks: async () => false,
    openSession: () => {},
    ...overrides,
  } as unknown as BoardController
}

async function renderBoard(controller: BoardController): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<TaskBoard controller={controller} />) })
  return container
}

const click = async (element: HTMLElement, init: MouseEventInit = {}): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }))
  })
}

function transfer(initial: Record<string, string> = {}): {
  data: Record<string, string>
  setData(type: string, value: string): void
  getData(type: string): string
  effectAllowed: string
  dropEffect: string
} {
  const data = { ...initial }
  return {
    data,
    setData(type, value) { data[type] = value },
    getData(type) { return data[type] ?? '' },
    effectAllowed: 'none',
    dropEffect: 'none',
  }
}

async function dragStart(card: HTMLElement, dataTransfer: ReturnType<typeof transfer>): Promise<void> {
  await act(async () => {
    card.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true, cancelable: true }), { dataTransfer }))
  })
}

async function drop(column: HTMLElement, dataTransfer: ReturnType<typeof transfer>): Promise<void> {
  await act(async () => {
    column.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }))
  })
}

function cardWith(container: HTMLElement, title: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-dsh-part="card"]'))
    .find(card => card.textContent?.includes(title))
  if (found === undefined) throw new Error(`card not rendered: ${title}`)
  return found
}

describe('detail transition buttons', () => {
  it('offers every manual transition of the current column, including clarify and run starts', () => {
    const backlog = renderDetail(task({ status: 'backlog' }))
    expect(transitionTargets(backlog.container)).toEqual(['clarification', 'ready_for_test', 'done', 'failed'])
    expect(transitionTargets(backlog.container)).not.toContain('running')

    const clarification = renderDetail(task({ status: 'clarification' }))
    expect(transitionTargets(clarification.container)).toEqual([
      'running', 'backlog', 'ready_for_test', 'done', 'failed',
    ])
    expect(transitionButton(clarification.container, 'running').getAttribute('data-starts')).toBe('true')
    expect(clarification.container.querySelector('button[data-dsh-part="transition-button"][data-target="clarification"]')).toBeNull()

    const done = renderDetail(task({ status: 'done' }))
    expect(transitionTargets(done.container)).toEqual(['backlog', 'clarification', 'ready_for_test', 'failed'])
    expect(transitionTargets(done.container)).not.toContain('running')
  })

  it('removes the old footer Run button and places the status block before the execution history', () => {
    const { container } = renderDetail(task({ status: 'backlog' }))
    const runLabels = [t('detail.run'), t('detail.rerun')]
    const footerRun = [...container.querySelectorAll('button')]
      .find(button => runLabels.includes(button.textContent?.trim() ?? ''))
    expect(footerRun).toBeUndefined()

    const transitions = container.querySelector('[data-dsh-part="detail-transitions"]')
    expect(transitions).not.toBeNull()
    const executionHeading = [...container.querySelectorAll('h4')].find(heading => heading.textContent === t('detail.execution'))
    expect(executionHeading).toBeDefined()
    expect(transitions!.compareDocumentPosition(executionHeading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('disables a transition while an implementation run owns the card and explains it on hover', () => {
    const { container } = renderDetail(task({ status: 'clarification', executions: [openRun()] }))
    const running = transitionButton(container, 'running')
    expect(running.disabled).toBe(true)
    expect(running.getAttribute('data-blocker')).toBe('running')
    expect(reasonOf(running)).toBe(t('detail.transition.blocked.running'))
  })

  it('disables only the run start when the permission binding is unconfirmed', () => {
    const { container } = renderDetail(task({ status: 'clarification', permission: 'danger-full-access' }))
    const running = transitionButton(container, 'running')
    expect(running.disabled).toBe(true)
    expect(running.getAttribute('data-blocker')).toBe('permission')
    expect(reasonOf(running)).toBe(t('detail.transition.blocked.permission'))
    // A plain move does not execute anything and stays available.
    expect(transitionButton(container, 'backlog').disabled).toBe(false)
  })

  it('shows a waiting intent with its target, disables that button and cancels it', () => {
    const cancel = vi.fn()
    const { container } = renderDetail(
      task({ status: 'clarification' }),
      { pendingTransitions: [{ taskId: 'task-1', from: 'clarification', to: 'running', requestedAt: 1 }] },
      { cancel },
    )
    const running = transitionButton(container, 'running')
    expect(running.disabled).toBe(true)
    expect(running.getAttribute('data-queued')).toBe('true')
    expect(running.textContent).toContain(t('detail.transition.waitingShort'))
    expect(reasonOf(running)).toBe(t('detail.transition.queuedHint'))

    const line = container.querySelector('[data-dsh-part="transition-queued"]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain(t('detail.transition.waiting', { status: t('board.status.running') }))
    const cancelButton = [...line!.querySelectorAll('button')].find(button => button.textContent === t('detail.transition.cancel'))
    expect(cancelButton).toBeDefined()
    act(() => { cancelButton!.click() })
    expect(cancel).toHaveBeenCalledWith('task-1')
  })

  it('shows the reason of a discarded transition', () => {
    const { container } = renderDetail(
      task({ status: 'clarification' }),
      {
        transitionErrors: {
          'task-1': { code: 'rejected', message: 'no way', at: 1 },
        },
      },
    )
    const error = container.querySelector('[data-dsh-part="transition-error"]')
    expect(error).not.toBeNull()
    expect(error!.textContent).toContain('no way')
  })
})

describe('card transition badges and queued drops', () => {
  it('shows the waiting target and the failure mark on the card', async () => {
    const container = await renderBoard(boardController(
      [task({ status: 'clarification' })],
      {
        pendingTransitions: [{ taskId: 'task-1', from: 'clarification', to: 'running', requestedAt: 1 }],
        transitionErrors: {
          'task-1': { code: 'rejected', message: 'no way', at: 2 },
        },
      },
    ))
    const queued = container.querySelector('[data-dsh-part="card-transition-queued"]')
    expect(queued).not.toBeNull()
    expect(queued!.textContent).toContain(t('board.status.running'))
    expect(queued!.getAttribute('title')).toContain(t('detail.transition.waiting', { status: t('board.status.running') }))
    const error = container.querySelector('[data-dsh-part="card-transition-error"]')
    expect(error).not.toBeNull()
    expect(error!.getAttribute('title')).toContain('no way')
  })

  it('keeps a pending card out of the bulk archive action', async () => {
    const archive = vi.fn(() => true)
    const container = await renderBoard(boardController(
      [task({ id: 'task-a', title: 'A', status: 'clarification' })],
      { pendingTaskIds: ['task-a'] },
      { archiveTask: archive },
    ))
    await click(cardWith(container, 'A'))
    const bulkArchive = container.querySelector<HTMLButtonElement>('button[data-dsh-part="bulk-archive"]')
    expect(bulkArchive?.disabled).toBe(true)
    if (bulkArchive !== null) await click(bulkArchive)
    expect(archive).not.toHaveBeenCalled()
  })

  it('queues a drop on a pending card instead of swallowing it', async () => {
    const move = vi.fn()
    const container = await renderBoard(boardController(
      [task({ id: 'task-a', title: 'A', status: 'clarification' })],
      { pendingTaskIds: ['task-a'] },
      { moveTask: move },
    ))
    const dataTransfer = transfer({ 'text/plain': 'task-a' })
    await dragStart(cardWith(container, 'A'), dataTransfer)
    await drop(container.querySelector<HTMLElement>('section[data-status="running"]')!, dataTransfer)
    expect(move).toHaveBeenCalledWith('task-a', 'running')
    expect(container.querySelector('[data-dsh-part="drop-blocked"]')).toBeNull()
  })

  it('refuses a hard-blocked drop with the reason and does not queue it', async () => {
    const move = vi.fn()
    const blocked = vi.fn()
    const refused = vi.fn()
    const container = await renderBoard(boardController(
      [task({ id: 'task-a', title: 'A', status: 'clarification', permission: 'danger-full-access' })],
      {},
      { moveTask: move, noteTransitionBlocked: blocked, refuse: refused },
    ))
    const dataTransfer = transfer({ 'text/plain': 'task-a' })
    await dragStart(cardWith(container, 'A'), dataTransfer)
    await drop(container.querySelector<HTMLElement>('section[data-status="running"]')!, dataTransfer)
    expect(move).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledWith('task-a', 'permission', 'running')
    expect(refused).toHaveBeenCalledTimes(1)
    expect(refused.mock.calls[0]![0]).toContain(t('detail.transition.blocked.permission'))
    expect(refused.mock.calls[0]![1]).toBe('task-a')
  })

  it('carries a pending card in a group drag and queues each card', async () => {
    const batches: string[][] = []
    const container = await renderBoard(boardController(
      [
        task({ id: 'task-a', title: 'A', status: 'clarification' }),
        task({ id: 'task-b', title: 'B', status: 'clarification' }),
      ],
      { pendingTaskIds: ['task-b'] },
      { moveTasks: async (ids) => { batches.push([...ids]); return true } },
    ))
    await click(cardWith(container, 'A'))
    await click(cardWith(container, 'B'), { ctrlKey: true })
    const dataTransfer = transfer()
    await dragStart(cardWith(container, 'A'), dataTransfer)
    expect(JSON.parse(dataTransfer.data['application/x-dsh-taskboard-cards'] ?? '[]')).toEqual(['task-a', 'task-b'])
    await drop(container.querySelector<HTMLElement>('section[data-status="ready_for_test"]')!, dataTransfer)
    expect(batches).toEqual([['task-a', 'task-b']])
  })
})
