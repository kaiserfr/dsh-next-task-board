// @vitest-environment jsdom
/**
 * L2 semantic attributes of the board view (issue #506): the mounted board
 * container, the board root, every status column, and every task card opt
 * into the semantic-attrs/v1 enum (data-dsh-plugin / data-dsh-part) so skins
 * can target them without hash-class selectors.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { mountBoard } from '../src/client/board-mount.tsx'
import { BATCH_DRAG_MIME, TaskBoard, queuedDropNotice } from '../src/client/board/TaskBoard.tsx'
import { zh } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
let disposeMount: (() => void) | undefined

afterEach(() => {
  disposeMount?.()
  disposeMount = undefined
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-dsh-taskboard-active')
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    title: 'Task A',
    description: '',
    prompt: 'do it',
    status: 'clarification',
    createdAt: 0,
    updatedAt: Date.now(),
    executions: [],
    ...overrides,
  }
}

/** The card button of the running column whose title text matches. */
function runningCardWith(container: HTMLElement, title: string): HTMLElement {
  const cards = Array.from(container.querySelectorAll('section[data-status="running"] [data-dsh-part="card"]'))
  const found = cards.find(card => card.textContent?.includes(title))
  if (found === undefined) throw new Error(`no running card titled ${title}`)
  return found as HTMLButtonElement
}

function fakeController(
  snapshot?: Partial<ControllerSnapshot>,
  overrides?: Partial<BoardController>,
): BoardController {
  const state: ControllerSnapshot = {
    tasks: [task()],
    boardOpen: false,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    ...snapshot,
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: () => {},
    moveTask: () => {},
    moveTasks: async () => true,
    ...overrides,
  } as unknown as BoardController
}

describe('TaskBoard L2 semantic attributes (#506)', () => {
  it('tags the board root, the status columns, and the task cards', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController()} />) })

    const board = container.querySelector('[data-dsh-taskboard-board]')
    expect(board).not.toBeNull()
    expect(board!.getAttribute('data-dsh-plugin')).toBe('task-board')
    expect(board!.querySelector('button[data-dsh-center-view-back]')).not.toBeNull()

    const columns = container.querySelectorAll('section[data-status]')
    expect(columns.length).toBeGreaterThan(0)
    for (const column of columns) {
      expect(column.getAttribute('data-dsh-part')).toBe('column')
    }

    const card = container.querySelector('[data-dsh-part="card"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Task A')
  })

  it('tags the archive column as a column too', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const controller = fakeController({
      archiveView: true,
      tasks: [task({ archivedAt: Date.now(), status: 'done' })],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const archive = container.querySelector('section[data-status="archived"]')
    expect(archive).not.toBeNull()
    expect(archive!.getAttribute('data-dsh-part')).toBe('column')
  })
})

describe('TaskBoard card drag-and-drop status changes (#1195)', () => {
  it('marks manual and in-flight tasks as draggable; archived tasks are not, running tasks may be dragged onto Done', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const controller = fakeController({
      tasks: [
        task({ id: 't-todo', status: 'clarification' }),
        task({ id: 't-running', status: 'running' }),
        task({ id: 't-pending', status: 'clarification' }),
      ],
      pendingTaskIds: ['t-pending'],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const cards = container.querySelectorAll('[data-dsh-part="card"]')
    expect(cards).toHaveLength(3)

    // Todo card is draggable
    const todoCard = Array.from(cards).find(c => c.getAttribute('data-status') === 'clarification' && !c.hasAttribute('data-pending'))
    expect(todoCard?.getAttribute('draggable')).toBe('true')

    // A running card may be dragged too: the drop validation only lets it land
    // on Done (the Host settles the open run and stops the session).
    const runningCard = Array.from(cards).find(c => c.getAttribute('data-status') === 'running')
    expect(runningCard?.getAttribute('draggable')).toBe('true')

    // A card with an action in flight stays draggable: the next move queues.
    const pendingCard = Array.from(cards).find(c => c.getAttribute('data-pending') === 'true')
    expect(pendingCard?.getAttribute('draggable')).toBe('true')

    // Archived cards never render on the board; the bulk/selection paths keep
    // them read-only (see `isCardBulkActionable`).
  })

  it('drops a backlog card onto the clarification column and triggers controller.moveTask', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [task({ id: 't-backlog', status: 'backlog', title: 'Task Backlog' })],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    // A backlog card's first stop is the clarification column: the machine has
    // no `backlog → todo` transition any more.
    const todoColumn = container.querySelector('section[data-status="clarification"]')
    expect(todoColumn).not.toBeNull()

    // Simulate drag and drop
    const dataTransfer = {
      data: { 'text/plain': 't-backlog' } as Record<string, string>,
      setData(type: string, val: string) { this.data[type] = val },
      getData(type: string) { return this.data[type] ?? '' },
      dropEffect: 'none',
    }

    await act(async () => {
      todoColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })

    expect(moveCalls).toEqual([{ id: 't-backlog', status: 'clarification' }])
  })

  it('renders Ready for test directly before Failed, with Done last', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController()} />) })

    const statuses = Array.from(container.querySelectorAll('section[data-status]'))
      .map(column => column.getAttribute('data-status'))
    // The full default column order: the swap moved `failed` in front of
    // `done`, every other column kept its slot, and none is lost or doubled.
    expect(statuses).toEqual(['backlog', 'clarification', 'running', 'testing', 'tested', 'failed', 'done'])
  })

  it('drops a tested card onto the done column and triggers controller.moveTask', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      { tasks: [task({ id: 't-ready', status: 'tested' })] },
      { moveTask: (id, status) => { moveCalls.push({ id, status }) } },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const doneColumn = container.querySelector('section[data-status="done"]')
    expect(doneColumn).not.toBeNull()
    const dataTransfer = { getData: (type: string) => (type === 'text/plain' ? 't-ready' : '') }
    await act(async () => {
      doneColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })

    expect(moveCalls).toEqual([{ id: 't-ready', status: 'done' }])
  })

  it('drops a running card onto the done column and moves it, open run or not', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [task({
          id: 't-running', status: 'running',
          executions: [{
            id: 'run-1', sessionId: 'session-run', startedAt: 1, endedAt: undefined,
            result: undefined, error: undefined,
          }],
        })],
      },
      { moveTask: (id, status) => { moveCalls.push({ id, status }) } },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const doneColumn = container.querySelector('section[data-status="done"]')
    expect(doneColumn).not.toBeNull()
    const dataTransfer = { getData: (type: string) => (type === 'text/plain' ? 't-running' : '') }
    await act(async () => {
      doneColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })

    expect(moveCalls).toEqual([{ id: 't-running', status: 'done' }])
  })

  it('drops a todo card onto the running column and starts it through the transition', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [
          task({ id: 't-todo', status: 'clarification' }),
          task({ id: 't-running', status: 'running' }),
          task({ id: 't-pending', status: 'done' }),
        ],
        pendingTaskIds: ['t-pending'],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const runningColumn = container.querySelector('section[data-status="running"]')
    expect(runningColumn).not.toBeNull()

    const drop = async (id: string): Promise<void> => {
      const dataTransfer = {
        getData: (type: string) => (type === 'text/plain' ? id : ''),
      }
      await act(async () => {
        runningColumn!.dispatchEvent(
          Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
        )
      })
    }

    await drop('t-todo')
    expect(moveCalls).toEqual([{ id: 't-todo', status: 'running' }])

    // Already running, unknown, or invalid targets do not move anything.
    await drop('t-running')
    await drop('t-missing')
    await drop('t-pending')
    expect(moveCalls).toEqual([{ id: 't-todo', status: 'running' }])
  })

  it('rejects invalid drops (same column or dropping running tasks)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const refused: Array<{ message: string; taskId: string | undefined }> = []
    const controller = fakeController(
      {
        tasks: [
          task({ id: 't-todo', status: 'clarification' }),
          task({ id: 't-running', status: 'running' }),
        ],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
        refuse: (message, taskId) => { refused.push({ message, taskId }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const todoColumn = container.querySelector('section[data-status="clarification"]')

    // Dropping on the same column does nothing
    const sameColTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-todo' : ''),
    }
    await act(async () => {
      todoColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: sameColTransfer }),
      )
    })
    expect(moveCalls).toHaveLength(0)
    // ... and the drop is no longer swallowed: the board names the reason.
    expect(refused).toHaveLength(1)
    expect(refused[0]!.taskId).toBe('t-todo')

    // Dropping a running task does nothing
    const runningTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-running' : ''),
    }
    await act(async () => {
      todoColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: runningTransfer }),
      )
    })
    expect(moveCalls).toHaveLength(0)
    expect(refused).toHaveLength(2)
    expect(refused[1]!.taskId).toBe('t-running')
  })
})

describe('TaskBoard running-card marking and runner-column order', () => {
  /** An open run; only a run that already attached a session is executing. */
  const openRun = (startedAt: number, sessionId?: string): TaskRecord['executions'][number] => ({
    id: `run-${startedAt}`,
    sessionId,
    startedAt,
    endedAt: undefined,
    result: undefined,
    error: undefined,
  })

  it('marks only the executing card and sorts it above the queue in arrival order', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const controller = fakeController({
      tasks: [
        // Ledger order is deliberately not display order: the executing run is
        // created last, the queued cards before it.
        task({ id: 'q-old', title: 'q-old', status: 'running', executions: [openRun(100)] }),
        task({ id: 'q-new', title: 'q-new', status: 'running', executions: [openRun(300)] }),
        task({ id: 'exec', title: 'exec', status: 'running', executions: [openRun(200, 'session-exec')] }),
        // A column the runner does not own keeps the ledger order, even when
        // the run timestamps would sort differently.
        task({ id: 'todo-1', title: 'todo-1', status: 'clarification', updatedAt: 900 }),
        task({ id: 'todo-2', title: 'todo-2', status: 'clarification', updatedAt: 10 }),
      ],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const running = container.querySelector('section[data-status="running"]')
    expect(running).not.toBeNull()
    const cards = Array.from(running!.querySelectorAll('[data-dsh-part="card"]'))
    expect(cards.map(card => card.textContent)).toEqual([
      expect.stringContaining('exec'),
      expect.stringContaining('q-old'),
      expect.stringContaining('q-new'),
    ])
    expect(cards.map(card => card.getAttribute('data-executing'))).toEqual(['true', null, null])
    // The executing card says so; the waiting ones name the blocker that holds
    // their lane's WIP slot — in the badge and in the card's tooltip.
    const waiting = zh['card.waitingNoWorkspace'].replace('{task}', 'exec')
    expect(cards[0]!.textContent).toContain(zh['card.running'])
    expect(cards[1]!.textContent).toContain(zh['card.waiting'])
    expect(cards[1]!.getAttribute('title')).toBe(waiting)
    expect(cards[2]!.textContent).toContain(zh['card.waiting'])
    expect(cards[2]!.getAttribute('title')).toBe(waiting)
    expect(cards[1]!.querySelector('[data-dsh-part="card-waiting"]')).not.toBeNull()

    const todo = container.querySelector('section[data-status="clarification"]')
    expect(Array.from(todo!.querySelectorAll('[data-dsh-part="card"]'))
      .map(card => card.getAttribute('title'))).toEqual(['todo-1', 'todo-2'])
  })

  it('tells why a card dropped on the running column had to queue', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    // The lane occupant holds the slot (a session is attached); the dropped
    // card is already in the runner column with an open run that has no
    // session — the state the Host's queue leaves it in.
    const tasks: TaskRecord[] = [
      task({ id: 'exec', title: 'Exec card', status: 'running', workspaceId: 'w1', executions: [openRun(100, 'session-exec')] }),
      task({ id: 't-next', title: 'Next card', status: 'running', workspaceId: 'w1', executions: [openRun(200)] }),
      // The card the user drops: still in a movable column, same lane.
      task({ id: 't-drop', title: 'Drop card', status: 'clarification', workspaceId: 'w1' }),
    ]
    const controller = fakeController(
      {
        tasks,
        executionOptions: { workspaces: [{ workspaceId: 'w1', title: 'Comfy' }], presets: [] },
      },
      { moveTask: (id, status) => { moveCalls.push({ id, status }) } },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    // The waiting card names its blocker and the lane, on the card and in a
    // tooltip; the blocking card does not carry the marking.
    const waitingCard = runningCardWith(container, 'Next card')
    const executableCard = runningCardWith(container, 'Exec card')
    expect(waitingCard.getAttribute('data-waiting')).toBe('true')
    expect(executableCard.getAttribute('data-waiting')).toBeNull()
    const reason = zh['card.waitingOn'].replace('{task}', 'Exec card').replace('{workspace}', 'Comfy')
    expect(waitingCard.getAttribute('title')).toBe(reason)
    expect(waitingCard.querySelector('[data-dsh-part="card-waiting"]')).not.toBeNull()

    // A drop of a movable card on the run column while the lane is held gets
    // the same explanation, computed before the Host is asked: the card is
    // handed over all the same (the Host queues it), and the notice names the
    // blocker and its workspace.
    const drop = tasks.find(item => item.id === 't-drop')!
    const notice = queuedDropNotice([drop], tasks, { maxConcurrentRuns: 1, maxTestingRuns: 1 }, new Map([['w1', 'Comfy']]))
    expect(notice).toContain('Exec card')
    expect(notice).toContain('Comfy')
    // A card whose lane is free starts right away: no notice at all.
    expect(queuedDropNotice([drop], [drop], { maxConcurrentRuns: 1, maxTestingRuns: 1 }, new Map())).toBeUndefined()
    // The dropped card still reaches the controller, which is what starts (and
    // queues) it in production.
    const dataTransfer = { getData: (type: string) => (type === 'text/plain' ? 't-drop' : '') }
    await act(async () => {
      container.querySelector('section[data-status="running"]')!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
      await Promise.resolve()
    })
    expect(moveCalls).toEqual([{ id: 't-drop', status: 'running' }])
  })
})

describe('mountBoard lifecycle & interaction (#506, #1233)', () => {
  it('tags the injected board container with data-dsh-plugin', async () => {
    const column = document.createElement('div')
    column.setAttribute('data-pane', 'conversation')
    document.body.appendChild(column)

    await act(async () => { disposeMount = mountBoard(fakeController()) })

    const view = column.querySelector('[data-dsh-taskboard-view]')
    expect(view).not.toBeNull()
    expect(view!.getAttribute('data-dsh-plugin')).toBe('task-board')
  })

  it('clicking the back button calls controller.closeBoard() (#1233)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    let closed = 0
    const controller = fakeController({}, {
      closeBoard: () => { closed += 1 },
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const backButton = container.querySelector('button[data-dsh-center-view-back]') as HTMLButtonElement
    expect(backButton).not.toBeNull()
    await act(async () => { backButton.click() })
    expect(closed).toBe(1)
  })

  it('self-heals and remounts when the conversation column is replaced (#1233)', async () => {
    let column = document.createElement('div')
    column.setAttribute('data-pane', 'conversation')
    document.body.appendChild(column)

    const controller = fakeController({ boardOpen: true })
    await act(async () => { disposeMount = mountBoard(controller) })
    expect(column.querySelector('[data-dsh-taskboard-view]')).not.toBeNull()

    // Replace the column element in DOM (e.g. React re-render of AppFrame)
    column.remove()
    column = document.createElement('div')
    column.setAttribute('data-pane', 'conversation')
    document.body.appendChild(column)

    await act(async () => {
      // Trigger the page-wide body mutation hub, which coalesces its
      // subscribers to the next animation frame (shared/client/body-mutations.ts).
      document.body.appendChild(document.createElement('span'))
      await new Promise(resolve => requestAnimationFrame(() => { resolve(undefined) }))
    })
    expect(column.querySelector('[data-dsh-taskboard-view]')).not.toBeNull()
  })
})

describe('TaskBoard multi-selection and group drag', () => {
  /** Minimal DataTransfer double backed by one string map. */
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

  type Transfer = ReturnType<typeof transfer>

  async function render(tasks: TaskRecord[], overrides?: Partial<BoardController>): Promise<{
    container: HTMLElement
    card(title: string): HTMLElement
    checkbox(title: string): HTMLInputElement
    detail(title: string): HTMLButtonElement
    column(status: string): HTMLElement
    bar(): HTMLElement | null
    marked(): string[]
    bulk(part: string): HTMLButtonElement
  }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController({ tasks }, overrides)} />) })
    const card = (title: string): HTMLElement => {
      const found = Array.from(container.querySelectorAll<HTMLElement>('[data-dsh-part="card"]'))
        .find(entry => entry.querySelector('[data-dsh-part="card-detail-target"]')?.firstElementChild?.textContent === title)
      if (found === undefined) throw new Error(`card not rendered: ${title}`)
      return found
    }
    const checkbox = (title: string): HTMLInputElement => {
      const box = card(title).parentElement?.querySelector<HTMLInputElement>('[data-dsh-part="card-select"]')
      if (box === null || box === undefined) throw new Error(`card checkbox not rendered: ${title}`)
      return box
    }
    const detail = (title: string): HTMLButtonElement => {
      const target = card(title).querySelector<HTMLButtonElement>('[data-dsh-part="card-detail-target"]')
      if (target === null) throw new Error(`card detail target not rendered: ${title}`)
      return target
    }
    const column = (status: string): HTMLElement => {
      const found = container.querySelector<HTMLElement>(`section[data-status="${status}"]`)
      if (found === null) throw new Error(`column not rendered: ${status}`)
      return found
    }
    const bulk = (part: string): HTMLButtonElement => {
      const found = container.querySelector<HTMLButtonElement>(`button[data-dsh-part="${part}"]`)
      if (found === null) throw new Error(`bulk button not rendered: ${part}`)
      return found
    }
    return {
      container,
      card,
      checkbox,
      detail,
      column,
      bulk,
      bar: () => container.querySelector<HTMLElement>('[data-dsh-part="selection-bar"]'),
      marked: () => Array.from(container.querySelectorAll<HTMLElement>('[data-dsh-part="card"][data-selected="true"]'))
        .map(entry => entry.querySelector('[data-dsh-part="card-detail-target"]')?.firstElementChild?.textContent ?? ''),
    }
  }

  // `detail: 1` is what a real mouse click reports; the DOM's synthetic
  // `element.click()` (and a keyboard Enter/Space on the title button) reports
  // `detail: 0` and still reaches the button's own click handler.
  const click = async (element: HTMLElement, init: MouseEventInit = {}): Promise<void> => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }))
    })
  }

  // `element.click()` is what Enter/Space on a focused button produces; it is
  // the keyboard's route to the detail (the title/excerpt button).
  const keyClick = async (element: HTMLElement): Promise<void> => {
    await act(async () => { element.click() })
  }

  const dragStart = async (element: HTMLElement, dataTransfer: Transfer): Promise<void> => {
    await act(async () => {
      element.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true, cancelable: true }), { dataTransfer }))
    })
  }

  const drop = async (element: HTMLElement, dataTransfer: Transfer): Promise<void> => {
    await act(async () => {
      element.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }))
      // Let the controller promise chain (batch move, sequential run starts)
      // settle before the assertions read its side effects.
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
    })
  }

  it('marks exactly one card with its checkbox and offers the count plus a way out', async () => {
    const opened: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' })],
      { openTask: (id) => { opened.push(id) } },
    )

    // The card body is inert: it neither marks nor opens the detail.
    await click(board.card('A'))
    expect(board.marked()).toEqual([])
    expect(opened).toEqual([])

    await click(board.checkbox('A'))
    expect(board.checkbox('A').checked).toBe(true)
    expect(board.checkbox('A').getAttribute('aria-label')).toBe(zh['card.select'])
    expect(board.card('A').getAttribute('data-selected')).toBe('true')
    expect(board.card('B').getAttribute('data-selected')).toBeNull()
    expect(board.bar()?.textContent).toContain('1')
    expect(board.bar()?.textContent).toContain(zh['board.selectionClear'])
    // Marking is the checkbox's own action; it never opens the detail.
    expect(opened).toEqual([])

    await click(board.container.querySelector<HTMLElement>('[data-dsh-part="selection-bar"] button')!)
    expect(board.bar()).toBeNull()
    expect(board.card('A').getAttribute('data-selected')).toBeNull()
  })

  it('marks two cards independently with their checkboxes', async () => {
    const board = await render([task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' })])

    await click(board.checkbox('A'))
    await click(board.checkbox('B'))
    expect(board.marked()).toEqual(['A', 'B'])
    expect(board.bar()?.textContent).toContain('2')

    await click(board.checkbox('A'))
    expect(board.marked()).toEqual(['B'])
    expect(board.bar()?.textContent).toContain('1')
  })

  it('toggles a card in and out with its checkbox', async () => {
    const board = await render([
      task({ id: 't-a', title: 'A' }),
      task({ id: 't-b', title: 'B' }),
      task({ id: 't-c', title: 'C' }),
    ])

    await click(board.checkbox('A'))
    await click(board.checkbox('B'))
    await click(board.checkbox('C'))
    expect(board.marked()).toEqual(['A', 'B', 'C'])
    expect(board.bar()?.textContent).toContain('3')

    await click(board.checkbox('B'))
    expect(board.marked()).toEqual(['A', 'C'])
    expect(board.bar()?.textContent).toContain('2')
  })

  it('marks the range from the anchor to the clicked card with Shift', async () => {
    const board = await render([
      task({ id: 't-a', title: 'A' }),
      task({ id: 't-b', title: 'B' }),
      task({ id: 't-c', title: 'C' }),
      task({ id: 't-d', title: 'D' }),
    ])

    // The anchor is the last toggled checkbox; Shift walks the range and the
    // anchor itself stays put for the next Shift click.
    await click(board.checkbox('B'))
    await click(board.checkbox('D'), { shiftKey: true })
    expect(board.marked()).toEqual(['B', 'C', 'D'])

    await click(board.checkbox('C'), { shiftKey: true })
    expect(board.marked()).toEqual(['B', 'C'])
  })

  it('walks the board order across columns with Shift', async () => {
    const board = await render([
      task({ id: 't-a', title: 'A', status: 'backlog' }),
      task({ id: 't-c', title: 'C', status: 'clarification' }),
      task({ id: 't-d', title: 'D', status: 'clarification' }),
    ])

    await click(board.checkbox('A'))
    await click(board.checkbox('D'), { shiftKey: true })
    // Columns left to right, cards top to bottom: backlog A, then todo C and D.
    expect(board.marked()).toEqual(['A', 'C', 'D'])
  })

  it('marks only the clicked card with Shift while nothing is marked yet', async () => {
    const board = await render([task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' })])
    await click(board.checkbox('B'), { shiftKey: true })
    expect(board.marked()).toEqual(['B'])
  })

  it('clears the selection when free board space is clicked', async () => {
    const board = await render([task({ id: 't-a', title: 'A' })])
    await click(board.checkbox('A'))
    expect(board.bar()).not.toBeNull()

    await click(board.container.querySelector<HTMLElement>('[data-dsh-taskboard-board]')!)
    expect(board.bar()).toBeNull()
  })

  it('opens the detail from the title and its excerpt only, and keeps the selection', async () => {
    const opened: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A', description: 'the short text' })],
      { openTask: (id) => { opened.push(id) } },
    )

    // The checkbox marks; the card body (tags, meta, empty space) stays inert.
    await click(board.checkbox('A'))
    await click(board.card('A'))
    expect(opened).toEqual([])
    expect(board.card('A').getAttribute('data-selected')).toBe('true')

    // Title + excerpt are one button; a mouse click and a keyboard activation
    // (`element.click()` is what Enter/Space on a button produces) both open it.
    await click(board.detail('A'))
    expect(opened).toEqual(['t-a'])
    await keyClick(board.detail('A'))
    expect(opened).toEqual(['t-a', 't-a'])
    // Opening the detail keeps the selection: inspecting a marked card is a
    // separate intention from marking it.
    expect(board.card('A').getAttribute('data-selected')).toBe('true')
  })

  it('toggles with the checkbox and extends the range with Shift', async () => {
    const opened: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' }), task({ id: 't-c', title: 'C' })],
      { openTask: (id) => { opened.push(id) } },
    )

    // A checkbox click toggles this card; the checkbox is the only mark.
    await click(board.checkbox('A'))
    expect(board.marked()).toEqual(['A'])
    await click(board.checkbox('B'))
    expect(board.marked()).toEqual(['A', 'B'])
    await click(board.checkbox('B'))
    expect(board.marked()).toEqual(['A'])
    // Shift+click walks the range from the anchor (the toggled B) to C.
    await click(board.checkbox('C'), { shiftKey: true })
    expect(board.marked()).toEqual(['B', 'C'])
    // Marking never opens the detail; the title button is the keyboard's route.
    expect(opened).toEqual([])
    await keyClick(board.detail('C'))
    expect(opened).toEqual(['t-c'])
  })

  it('carries the whole selection on a marked card and moves it as one batch', async () => {
    const batches: string[][] = []
    const singles: Array<{ id: string; status: string }> = []
    const board = await render(
      [
        task({ id: 't-a', title: 'A', status: 'backlog' }),
        task({ id: 't-b', title: 'B', status: 'backlog' }),
        task({ id: 't-c', title: 'C', status: 'clarification' }),
      ],
      {
        moveTask: (id, status) => { singles.push({ id, status }) },
        moveTasks: async (ids) => { batches.push([...ids]); return true },
      },
    )

    await click(board.checkbox('A'))
    await click(board.checkbox('B'), { shiftKey: true })
    const dataTransfer = transfer()
    await dragStart(board.card('A'), dataTransfer)
    // The lead id keeps `text/plain` compatible; the whole set rides the
    // custom MIME type in display order.
    expect(dataTransfer.data['text/plain']).toBe('t-a')
    expect(JSON.parse(dataTransfer.data[BATCH_DRAG_MIME]!)).toEqual(['t-a', 't-b'])
    expect(board.container.querySelector('[data-dsh-part="drag-count"]')?.textContent).toContain('2')

    // A plain target for the whole batch: the clarification column is refused
    // for a group drop (it would open a round per card), so the batch goes to
    // the review column, whose transition only carries the commit hook.
    await drop(board.column('testing'), dataTransfer)
    expect(batches).toEqual([['t-a', 't-b']])
    expect(singles).toEqual([])
    // A successful move ends the selection and the drag marker.
    expect(board.bar()).toBeNull()
    expect(board.container.querySelector('[data-dsh-part="drag-count"]')).toBeNull()
  })

  it('drags an unmarked card alone while other cards stay marked', async () => {
    const singles: Array<{ id: string; status: string }> = []
    const batches: string[][] = []
    const board = await render(
      [
        task({ id: 't-a', title: 'A', status: 'backlog' }),
        task({ id: 't-c', title: 'C', status: 'clarification' }),
      ],
      {
        moveTask: (id, status) => { singles.push({ id, status }) },
        moveTasks: async (ids) => { batches.push([...ids]); return true },
      },
    )

    await click(board.checkbox('A'))
    const dataTransfer = transfer()
    await dragStart(board.card('C'), dataTransfer)
    expect(JSON.parse(dataTransfer.data[BATCH_DRAG_MIME]!)).toEqual(['t-c'])

    await drop(board.column('backlog'), dataTransfer)
    expect(singles).toEqual([{ id: 't-c', status: 'backlog' }])
    expect(batches).toEqual([])
  })

  it('moves only the cards the machine allows into the target column', async () => {
    const singles: Array<{ id: string; status: string }> = []
    const batches: string[][] = []
    const board = await render(
      [
        task({ id: 't-a', title: 'A', status: 'backlog' }),
        task({ id: 't-b', title: 'B', status: 'testing' }),
      ],
      {
        moveTask: (id, status) => { singles.push({ id, status }) },
        moveTasks: async (ids) => { batches.push([...ids]); return true },
      },
    )

    await click(board.checkbox('A'))
    await click(board.checkbox('B'))
    const dataTransfer = transfer()
    await dragStart(board.card('A'), dataTransfer)
    // testing → testing is not a transition, so B stays behind.
    await drop(board.column('testing'), dataTransfer)
    expect(singles).toEqual([{ id: 't-a', status: 'testing' }])
    expect(batches).toEqual([])
  })

  it('changes nothing on an invalid drop and keeps the selection', async () => {
    const singles: Array<{ id: string; status: string }> = []
    const board = await render(
      [task({ id: 't-b', title: 'B', status: 'testing' })],
      { moveTask: (id, status) => { singles.push({ id, status }) } },
    )

    await click(board.checkbox('B'))
    const dataTransfer = transfer()
    await dragStart(board.card('B'), dataTransfer)
    await drop(board.column('testing'), dataTransfer)
    expect(singles).toEqual([])
    // An aborted drop is no reason to lose the selection.
    expect(board.bar()?.textContent).toContain('1')
  })

  it('starts every dragged card when the group lands on the run column', async () => {
    const started: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A', status: 'clarification' }), task({ id: 't-b', title: 'B', status: 'clarification' })],
      { moveTasks: async (ids) => { started.push(...ids); return true } },
    )

    await click(board.checkbox('A'))
    await click(board.checkbox('B'), { shiftKey: true })
    const dataTransfer = transfer()
    await dragStart(board.card('A'), dataTransfer)
    await drop(board.column('running'), dataTransfer)
    expect(started).toEqual(['t-a', 't-b'])
    expect(board.bar()).toBeNull()
  })

  it('archives the marked cards from the header and stays disabled without a mark', async () => {
    const archived: string[] = []
    const board = await render(
      [
        task({ id: 't-a', title: 'A', status: 'backlog' }),
        task({ id: 't-b', title: 'B', status: 'clarification' }),
        task({ id: 't-c', title: 'C', status: 'clarification' }),
      ],
      { archiveTask: (id) => { archived.push(id); return true } },
    )
    const bulkArchive = board.bulk('bulk-archive')

    expect(bulkArchive.disabled).toBe(true)
    await click(bulkArchive)
    expect(archived).toEqual([])

    await click(board.checkbox('B'))
    await click(board.checkbox('C'), { shiftKey: true })
    expect(bulkArchive.disabled).toBe(false)
    await click(bulkArchive)

    expect(archived).toEqual(['t-b', 't-c'])
    // The bulk action ends the selection like a completed group drag does.
    expect(board.bar()).toBeNull()
  })

  it('leaves a running card out of the bulk actions', async () => {
    const archived: string[] = []
    const board = await render(
      [
        task({ id: 't-run', title: 'Run', status: 'running' }),
        task({ id: 't-todo', title: 'Todo', status: 'clarification' }),
      ],
      { archiveTask: (id) => { archived.push(id); return true } },
    )
    const bulkArchive = board.bulk('bulk-archive')

    await click(board.checkbox('Run'))
    // Nothing in the selection can be archived, so the button stays refused.
    expect(bulkArchive.disabled).toBe(true)

    await click(board.checkbox('Todo'))
    await click(bulkArchive)
    expect(archived).toEqual(['t-todo'])
  })

  it('asks before deleting the marked cards', async () => {
    const deleted: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' })],
      { deleteTask: (id) => { deleted.push(id) } },
    )

    await click(board.checkbox('A'))
    await click(board.checkbox('B'))
    await click(board.bulk('bulk-delete'))
    expect(deleted).toEqual([])

    const dialog = board.container.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain(zh['delete.selectedTitle'])
    expect(dialog?.textContent).toContain('2')

    const confirm = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button'))
      .find(entry => entry.textContent === zh['delete.ok'])!
    await click(confirm)
    expect(deleted).toEqual(['t-a', 't-b'])
    expect(board.container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(board.bar()).toBeNull()
  })

  it('offers the follow-up glyph on a Done card and opens the empty follow-up dialog', async () => {
    const board = await render([task({ id: 't-done', title: 'Done card', status: 'done' })])
    const button = board.container.querySelector<HTMLButtonElement>('[data-dsh-part="card-follow-up-button"]')
    expect(button).not.toBeNull()
    await click(button!)

    expect(board.container.querySelector('[data-dsh-part="new-follow-up"]')).not.toBeNull()
    // A follow-up dialog starts empty: it carries the new task, not the source text.
    const title = board.container.querySelector<HTMLInputElement>(`[placeholder="${zh['new.titlePlaceholder']}"]`)
    expect(title?.value).toBe('')
  })

  it('shows the card follow-up only on Done while the source is free', async () => {
    // An unfinished follow-up owns the source: no second follow-up from the card.
    const source = task({ id: 't-src', title: 'Source', status: 'done' })
    const active = task({
      id: 't-fu',
      title: 'Follow-up',
      status: 'backlog',
      followUp: {
        sourceTaskId: 't-src',
        sessionId: 'session-src',
        title: 'Source',
        description: '',
        prompt: '',
        createdAt: 1,
      },
    })
    const blocked = await render([source, active])
    expect(blocked.container.querySelector('[data-dsh-part="card-follow-up-button"]')).toBeNull()

    // Only Done gets the shortcut; Tested keeps the release arrow and the detail's button.
    const tested = await render([task({ id: 't-tested', title: 'Tested', status: 'tested' })])
    expect(tested.container.querySelector('[data-dsh-part="card-follow-up-button"]')).toBeNull()

    // An open run keeps the source conversation busy: the Host would refuse.
    const open = await render([task({
      id: 't-open',
      title: 'Open run',
      status: 'done',
      executions: [{ id: 'e-open', sessionId: 's', startedAt: 1, endedAt: undefined, result: undefined, error: undefined }],
    })])
    expect(open.container.querySelector('[data-dsh-part="card-follow-up-button"]')).toBeNull()
  })

  describe('clarification step', () => {
    it('links the card own clarification chat', async () => {
      const board = await render([task({
        id: 't-a',
        title: 'A',
        status: 'clarification',
        clarificationSessionId: 'session-clarify',
      })])

      const link = board.container.querySelector<HTMLAnchorElement>('a[data-dsh-part="card-clarify-session"]')!
      expect(link.getAttribute('href')).toBe('#session=session-clarify')
    })

    it('shows the clarification run as running, links its session and offers the pause control', async () => {
      const board = await render([task({
        id: 't-a',
        title: 'A',
        status: 'clarification',
        clarificationSessionId: 'session-clarify',
        executions: [{
          id: 'clarify-1', kind: 'clarify', sessionId: 'session-clarify',
          startedAt: 1, endedAt: undefined, result: undefined, error: undefined,
        }],
      })])

      const card = board.card('A')
      // The card stays in its column but reads like a running one.
      expect(card.getAttribute('data-status')).toBe('clarification')
      expect(card.getAttribute('data-executing')).toBe('true')
      expect(card.textContent).toContain(zh['card.running'])
      expect(board.container.querySelector('a[data-dsh-part="card-session"]')?.getAttribute('href'))
        .toBe('#session=session-clarify')
      // The clarification is a run like any other: it carries the run's pause
      // control, exactly as the same execution would in the run column.
      expect(board.container.querySelector('[data-dsh-part="card-pause"]')).not.toBeNull()
    })

    it('reads a clarification whose session is still missing as queued', async () => {
      const board = await render([task({
        id: 't-a',
        title: 'A',
        status: 'clarification',
        executions: [{
          id: 'clarify-1', kind: 'clarify', sessionId: undefined,
          startedAt: 1, endedAt: undefined, result: undefined, error: undefined,
        }],
      })])

      expect(board.card('A').textContent).toContain(zh['card.queued'])
    })

    it('offers the run drop for cards of the clarification column', async () => {
      const started: string[] = []
      const board = await render(
        [
          task({ id: 't-open', title: 'Open', status: 'clarification' }),
          task({ id: 't-clear', title: 'Clear', status: 'clarification' }),
        ],
        { moveTasks: async (ids) => { started.push(...ids); return true } },
      )

      await click(board.checkbox('Open'))
      await click(board.checkbox('Clear'))
      const dataTransfer = transfer()
      await dragStart(board.card('Open'), dataTransfer)
      await drop(board.column('running'), dataTransfer)

      // Pulling the card on to the run column is the go-ahead: the Host closes
      // the round and continues the card's clarification session.
      expect(started).toEqual(['t-open', 't-clear'])
    })

    it('starts a card whose round already settled', async () => {
      const started: Array<{ id: string; status: string }> = []
      const board = await render(
        [task({ id: 't-a', title: 'A', status: 'clarification', clarificationSessionId: 'session-clarify' })],
        { moveTask: (id, status) => { started.push({ id, status }) } },
      )

      const dataTransfer = transfer()
      await dragStart(board.card('A'), dataTransfer)
      await drop(board.column('running'), dataTransfer)
      expect(started).toEqual([{ id: 't-a', status: 'running' }])
    })
  })
})