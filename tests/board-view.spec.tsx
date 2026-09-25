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
import { BATCH_DRAG_MIME, TaskBoard } from '../src/client/board/TaskBoard.tsx'
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
    status: 'todo',
    createdAt: 0,
    updatedAt: Date.now(),
    executions: [],
    ...overrides,
  }
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
  it('marks manual tasks as draggable and running/pending/archived tasks as not draggable', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const controller = fakeController({
      tasks: [
        task({ id: 't-todo', status: 'todo' }),
        task({ id: 't-running', status: 'running' }),
        task({ id: 't-pending', status: 'todo' }),
      ],
      pendingTaskIds: ['t-pending'],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const cards = container.querySelectorAll('button[data-dsh-part="card"]')
    expect(cards).toHaveLength(3)

    // Todo card is draggable
    const todoCard = Array.from(cards).find(c => c.getAttribute('data-status') === 'todo' && !c.hasAttribute('data-pending'))
    expect(todoCard?.getAttribute('draggable')).toBe('true')

    // Running card is not draggable
    const runningCard = Array.from(cards).find(c => c.getAttribute('data-status') === 'running')
    expect(runningCard?.getAttribute('draggable')).toBe('false')

    // Pending card is not draggable
    const pendingCard = Array.from(cards).find(c => c.getAttribute('data-pending') === 'true')
    expect(pendingCard?.getAttribute('draggable')).toBe('false')
  })

  it('drops a backlog card onto the todo column and triggers controller.moveTask', async () => {
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

    const todoColumn = container.querySelector('section[data-status="todo"]')
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

    expect(moveCalls).toEqual([{ id: 't-backlog', status: 'todo' }])
  })

  it('renders Ready for test directly before Done', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController()} />) })

    const statuses = Array.from(container.querySelectorAll('section[data-status]'))
      .map(column => column.getAttribute('data-status'))
    expect(statuses[statuses.indexOf('ready_for_test') + 1]).toBe('done')
  })

  it('drops a ready_for_test card onto the done column and triggers controller.moveTask', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      { tasks: [task({ id: 't-ready', status: 'ready_for_test' })] },
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

  it('drops a todo card onto the running column and starts it like Run', async () => {    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const runCalls: string[] = []
    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [
          task({ id: 't-todo', status: 'todo' }),
          task({ id: 't-running', status: 'running' }),
          task({ id: 't-pending', status: 'done' }),
        ],
        pendingTaskIds: ['t-pending'],
      },
      {
        rerunTask: async (id) => { runCalls.push(id) },
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
    expect(runCalls).toEqual(['t-todo'])

    // Already running, unknown, or pending tasks are not started again.
    await drop('t-running')
    await drop('t-missing')
    await drop('t-pending')
    expect(runCalls).toEqual(['t-todo'])
    // The running column never performs a plain status move.
    expect(moveCalls).toHaveLength(0)
  })

  it('rejects invalid drops (same column or dropping running tasks)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [
          task({ id: 't-todo', status: 'todo' }),
          task({ id: 't-running', status: 'running' }),
        ],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const todoColumn = container.querySelector('section[data-status="todo"]')

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
        task({ id: 'todo-1', title: 'todo-1', status: 'todo', updatedAt: 900 }),
        task({ id: 'todo-2', title: 'todo-2', status: 'todo', updatedAt: 10 }),
      ],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const running = container.querySelector('section[data-status="running"]')
    expect(running).not.toBeNull()
    const cards = Array.from(running!.querySelectorAll('button[data-dsh-part="card"]'))
    expect(cards.map(card => card.getAttribute('title'))).toEqual(['exec', 'q-old', 'q-new'])
    expect(cards.map(card => card.getAttribute('data-executing'))).toEqual(['true', null, null])
    // The executing card says so; the waiting ones read as queued.
    expect(cards[0]!.textContent).toContain(zh['card.running'])
    expect(cards[1]!.textContent).toContain(zh['card.queued'])
    expect(cards[2]!.textContent).toContain(zh['card.queued'])

    const todo = container.querySelector('section[data-status="todo"]')
    expect(Array.from(todo!.querySelectorAll('button[data-dsh-part="card"]'))
      .map(card => card.getAttribute('title'))).toEqual(['todo-1', 'todo-2'])
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
    column(status: string): HTMLElement
    bar(): HTMLElement | null
    marked(): string[]
  }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController({ tasks }, overrides)} />) })
    const card = (title: string): HTMLElement => {
      const found = Array.from(container.querySelectorAll<HTMLElement>('button[data-dsh-part="card"]'))
        .find(entry => entry.getAttribute('title') === title)
      if (found === undefined) throw new Error(`card not rendered: ${title}`)
      return found
    }
    const column = (status: string): HTMLElement => {
      const found = container.querySelector<HTMLElement>(`section[data-status="${status}"]`)
      if (found === null) throw new Error(`column not rendered: ${status}`)
      return found
    }
    return {
      container,
      card,
      column,
      bar: () => container.querySelector<HTMLElement>('[data-dsh-part="selection-bar"]'),
      marked: () => Array.from(container.querySelectorAll<HTMLElement>('button[data-selected="true"]'))
        .map(entry => entry.getAttribute('title')!),
    }
  }

  // `detail: 1` is what a real mouse click reports; the DOM's synthetic
  // `element.click()` (and a keyboard Enter) reports `detail: 0`, which the
  // board treats as "open the detail". A keyboard Space never gets that far:
  // the board consumes the keydown itself (see `space` below).
  const click = async (element: HTMLElement, init: MouseEventInit = {}): Promise<void> => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }))
    })
  }

  const keyClick = async (element: HTMLElement): Promise<void> => {
    await act(async () => { element.click() })
  }

  const doubleClick = async (element: HTMLElement): Promise<void> => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
    })
  }

  // Space on a focused card: the board handles the keydown and swallows the
  // click the browser would fire on keyup, so the helper only dispatches the
  // click when the event was not consumed.
  const space = async (element: HTMLElement, init: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...init })
    await act(async () => {
      element.dispatchEvent(event)
      if (!event.defaultPrevented) element.click()
    })
    return event
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

  it('marks exactly one card with a plain click and offers the count plus a way out', async () => {
    const opened: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' })],
      { openTask: (id) => { opened.push(id) } },
    )

    await click(board.card('A'))
    expect(board.card('A').getAttribute('data-selected')).toBe('true')
    expect(board.card('B').getAttribute('data-selected')).toBeNull()
    expect(board.bar()?.textContent).toContain('1')
    expect(board.bar()?.textContent).toContain(zh['board.selectionClear'])
    // The click marks; it no longer opens the detail behind the user's back.
    expect(opened).toEqual([])

    await click(board.container.querySelector<HTMLElement>('[data-dsh-part="selection-bar"] button')!)
    expect(board.bar()).toBeNull()
    expect(board.card('A').getAttribute('data-selected')).toBeNull()
  })

  it('replaces the selection with a plain click on another card', async () => {
    const board = await render([task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' })])

    await click(board.card('A'))
    await click(board.card('B'))
    expect(board.marked()).toEqual(['B'])
    expect(board.bar()?.textContent).toContain('1')
  })

  it('adds a card with Ctrl and removes it with Ctrl again', async () => {
    const board = await render([
      task({ id: 't-a', title: 'A' }),
      task({ id: 't-b', title: 'B' }),
      task({ id: 't-c', title: 'C' }),
    ])

    await click(board.card('A'))
    await click(board.card('B'), { ctrlKey: true })
    await click(board.card('C'), { metaKey: true })
    expect(board.marked()).toEqual(['A', 'B', 'C'])
    expect(board.bar()?.textContent).toContain('3')

    await click(board.card('B'), { ctrlKey: true })
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

    // The anchor is the last plainly clicked card; the range replaces the
    // selection, and the anchor itself stays put for the next Shift click.
    await click(board.card('B'))
    await click(board.card('D'), { shiftKey: true })
    expect(board.marked()).toEqual(['B', 'C', 'D'])

    await click(board.card('C'), { shiftKey: true })
    expect(board.marked()).toEqual(['B', 'C'])
  })

  it('walks the board order across columns with Shift', async () => {
    const board = await render([
      task({ id: 't-a', title: 'A', status: 'backlog' }),
      task({ id: 't-c', title: 'C', status: 'todo' }),
      task({ id: 't-d', title: 'D', status: 'todo' }),
    ])

    await click(board.card('A'))
    await click(board.card('D'), { shiftKey: true })
    // Columns left to right, cards top to bottom: backlog A, then todo C and D.
    expect(board.marked()).toEqual(['A', 'C', 'D'])
  })

  it('marks only the clicked card with Shift while nothing is marked yet', async () => {
    const board = await render([task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' })])
    await click(board.card('B'), { shiftKey: true })
    expect(board.marked()).toEqual(['B'])
  })

  it('clears the selection when free board space is clicked', async () => {
    const board = await render([task({ id: 't-a', title: 'A' })])
    await click(board.card('A'))
    expect(board.bar()).not.toBeNull()

    await click(board.container.querySelector<HTMLElement>('[data-dsh-taskboard-board]')!)
    expect(board.bar()).toBeNull()
  })

  it('opens the detail on a double click and on a keyboard click, not on a plain mark', async () => {
    const opened: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A' })],
      { openTask: (id) => { opened.push(id) } },
    )

    await click(board.card('A'))
    expect(opened).toEqual([])
    await doubleClick(board.card('A'))
    expect(opened).toEqual(['t-a'])

    // `element.click()` is what Enter/Space on a focused button produces; a
    // keyboard has no Ctrl/Shift click, so it keeps the direct route.
    await keyClick(board.card('A'))
    expect(opened).toEqual(['t-a', 't-a'])
    // Opening the detail keeps the selection: inspecting a marked card is a
    // separate intention from marking it.
    expect(board.card('A').getAttribute('data-selected')).toBe('true')
  })

  it('marks from the keyboard: Space takes the same modifiers as the mouse', async () => {
    const opened: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A' }), task({ id: 't-b', title: 'B' }), task({ id: 't-c', title: 'C' })],
      { openTask: (id) => { opened.push(id) } },
    )

    // Plain Space is the keyboard's plain click: this card alone.
    await space(board.card('A'))
    expect(board.marked()).toEqual(['A'])
    // Ctrl+Space adds B, a second Ctrl+Space takes it out again.
    await space(board.card('B'), { ctrlKey: true })
    expect(board.marked()).toEqual(['A', 'B'])
    await space(board.card('B'), { ctrlKey: true })
    expect(board.marked()).toEqual(['A'])
    // Shift+Space walks the range from the anchor (the Ctrl-marked B) to C.
    await space(board.card('C'), { shiftKey: true })
    expect(board.marked()).toEqual(['B', 'C'])
    // Space only marks; the detail stays Enter's job.
    expect(opened).toEqual([])
    // The keydown is consumed, so the button never fires its synthetic click
    // (and the page never scrolls).
    const consumed = await space(board.card('A'))
    expect(consumed.defaultPrevented).toBe(true)
    expect(board.marked()).toEqual(['A'])
    expect(opened).toEqual([])
  })

  it('carries the whole selection on a marked card and moves it as one batch', async () => {
    const batches: string[][] = []
    const singles: Array<{ id: string; status: string }> = []
    const board = await render(
      [
        task({ id: 't-a', title: 'A', status: 'backlog' }),
        task({ id: 't-b', title: 'B', status: 'backlog' }),
        task({ id: 't-c', title: 'C', status: 'todo' }),
      ],
      {
        moveTask: (id, status) => { singles.push({ id, status }) },
        moveTasks: async (ids) => { batches.push([...ids]); return true },
      },
    )

    await click(board.card('A'))
    await click(board.card('B'), { shiftKey: true })
    const dataTransfer = transfer()
    await dragStart(board.card('A'), dataTransfer)
    // The lead id keeps `text/plain` compatible; the whole set rides the
    // custom MIME type in display order.
    expect(dataTransfer.data['text/plain']).toBe('t-a')
    expect(JSON.parse(dataTransfer.data[BATCH_DRAG_MIME]!)).toEqual(['t-a', 't-b'])
    expect(board.container.querySelector('[data-dsh-part="drag-count"]')?.textContent).toContain('2')

    await drop(board.column('todo'), dataTransfer)
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
        task({ id: 't-c', title: 'C', status: 'todo' }),
      ],
      {
        moveTask: (id, status) => { singles.push({ id, status }) },
        moveTasks: async (ids) => { batches.push([...ids]); return true },
      },
    )

    await click(board.card('A'))
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
        task({ id: 't-b', title: 'B', status: 'ready_for_test' }),
      ],
      {
        moveTask: (id, status) => { singles.push({ id, status }) },
        moveTasks: async (ids) => { batches.push([...ids]); return true },
      },
    )

    await click(board.card('A'))
    await click(board.card('B'), { ctrlKey: true })
    const dataTransfer = transfer()
    await dragStart(board.card('A'), dataTransfer)
    // ready_for_test → ready_for_test is not a transition, so B stays behind.
    await drop(board.column('ready_for_test'), dataTransfer)
    expect(singles).toEqual([{ id: 't-a', status: 'ready_for_test' }])
    expect(batches).toEqual([])
  })

  it('changes nothing on an invalid drop and keeps the selection', async () => {
    const singles: Array<{ id: string; status: string }> = []
    const board = await render(
      [task({ id: 't-b', title: 'B', status: 'ready_for_test' })],
      { moveTask: (id, status) => { singles.push({ id, status }) } },
    )

    await click(board.card('B'))
    const dataTransfer = transfer()
    await dragStart(board.card('B'), dataTransfer)
    await drop(board.column('ready_for_test'), dataTransfer)
    expect(singles).toEqual([])
    // An aborted drop is no reason to lose the selection.
    expect(board.bar()?.textContent).toContain('1')
  })

  it('starts every dragged card when the group lands on the run column', async () => {
    const started: string[] = []
    const board = await render(
      [task({ id: 't-a', title: 'A', status: 'todo' }), task({ id: 't-b', title: 'B', status: 'todo' })],
      { rerunTask: async (id) => { started.push(id) } },
    )

    await click(board.card('A'))
    await click(board.card('B'), { shiftKey: true })
    const dataTransfer = transfer()
    await dragStart(board.card('A'), dataTransfer)
    await drop(board.column('running'), dataTransfer)
    expect(started).toEqual(['t-a', 't-b'])
    expect(board.bar()).toBeNull()
  })
})
