// @vitest-environment jsdom
/**
 * One-column step chevrons on the card itself (never in the task detail): the
 * left/right edge buttons move the card exactly one column, and they are
 * disabled whenever that move is not possible or not allowed — board edges, a
 * missing manual transition, the runner's ownership, a paused run, an
 * unconfirmed elevated permission, or a transition already queued for the same
 * target. The card takes the ordinary move path, so the confirmed controller
 * snapshot is what moves and re-renders it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { ExecutionRecord, TaskRecord } from '../src/core/tasks.ts'
import type { StateMachineConfig } from '../src/core/state-machine.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    title: 'Task A',
    description: '',
    prompt: 'do it',
    status: 'backlog',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    ...overrides,
  }
}

/** An open implementation run (not a clarification run). */
function openRun(startedAt = 1): ExecutionRecord {
  return { id: `run-${startedAt}`, sessionId: undefined, startedAt, endedAt: undefined, result: undefined, error: undefined }
}

const HOST = {
  revision: 1,
  scheduler: { timeZone: 'UTC' },
  power: { platform: 'linux', phase: 'unsupported' as const, enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
  sessionDefaultPermission: 'read-only' as const,
}

function stepButton(container: HTMLElement, direction: 'left' | 'right'): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[data-dsh-part="card-step-${direction}"]`)
  if (found === null) throw new Error(`no ${direction} step button`)
  return found
}

function mount(snapshot: Partial<ControllerSnapshot> = {}, overrides: Partial<BoardController> = {}) {
  const state: ControllerSnapshot = {
    tasks: [task()],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    ...snapshot,
  }
  const moved: Array<[string, string]> = []
  const opened: string[] = []
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: (id: string) => { opened.push(id) },
    moveTask: (id: string, status: string) => { moved.push([id, status]) },
    moveTasks: async () => true,
    ...overrides,
  } as unknown as BoardController
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  return {
    container,
    moved,
    opened,
    controller,
    render: async () => { await act(async () => { root.render(<TaskBoard controller={controller} />) }) },
  }
}

describe('card column-step chevrons', () => {
  it('renders one arrow per card edge and disables the edge without a column', async () => {
    const board = mount({ tasks: [task({ status: 'backlog' })] })
    await board.render()

    expect(board.container.querySelectorAll('button[data-dsh-part^="card-step-"]').length).toBe(2)
    const left = stepButton(board.container, 'left')
    const right = stepButton(board.container, 'right')
    expect(left.disabled).toBe(true)
    expect(left.getAttribute('data-blocker')).toBe('edge')
    expect(left.getAttribute('data-target')).toBeNull()
    expect(right.disabled).toBe(false)
    expect(right.getAttribute('data-target')).toBe('clarification')
    expect(right.getAttribute('data-blocker')).toBeNull()
    expect(board.container.querySelector('button[data-dsh-part="card"]')!.getAttribute('data-has-step')).toBe('true')
  })

  it('uses the directly adjacent column, not the next allowed one', async () => {
    const board = mount({ tasks: [task({ status: 'ready_for_test' })] })
    await board.render()

    expect(stepButton(board.container, 'right').getAttribute('data-target')).toBe('failed')
    expect(stepButton(board.container, 'left').getAttribute('data-target')).toBe('running')
  })

  it('disables the right arrow at the last column', async () => {
    const board = mount({ tasks: [task({ status: 'done' })] })
    await board.render()

    const right = stepButton(board.container, 'right')
    expect(right.disabled).toBe(true)
    expect(right.getAttribute('data-blocker')).toBe('edge')
    expect(stepButton(board.container, 'left').getAttribute('data-target')).toBe('failed')
  })

  it('moves the card one column through the ordinary transition path, without opening the detail', async () => {
    const board = mount({ tasks: [task({ status: 'clarification' })] })
    await board.render()

    await act(async () => { stepButton(board.container, 'left').click() })
    expect(board.moved).toEqual([['t1', 'backlog']])
    expect(board.opened).toEqual([])

    await act(async () => { stepButton(board.container, 'right').click() })
    expect(board.moved).toEqual([['t1', 'backlog'], ['t1', 'running']])
    expect(board.opened).toEqual([])
  })

  it('disables an adjacent column the machine allows no manual transition to', async () => {
    const machine: StateMachineConfig = {
      initial: 'backlog',
      states: [{ status: 'backlog' }, { status: 'clarification' }],
      transitions: [],
    }
    const board = mount({
      tasks: [task({ status: 'backlog' })],
      host: { ...HOST, stateMachine: machine },
    })
    await board.render()

    const right = stepButton(board.container, 'right')
    expect(right.disabled).toBe(true)
    expect(right.getAttribute('data-blocker')).toBe('invalid')
    expect(right.getAttribute('data-target')).toBe('clarification')
  })

  it('disables both arrows while the runner owns the card', async () => {
    const board = mount({ tasks: [task({ status: 'running', executions: [openRun()] })] })
    await board.render()

    for (const direction of ['left', 'right'] as const) {
      const button = stepButton(board.container, direction)
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('data-blocker')).toBe('running')
    }
  })

  it('disables both arrows while the open run is paused', async () => {
    const board = mount({
      tasks: [task({ status: 'clarification', executions: [openRun()], pausedAt: 2 })],
    })
    await board.render()

    expect(stepButton(board.container, 'left').disabled).toBe(true)
    expect(stepButton(board.container, 'left').getAttribute('data-blocker')).toBe('paused')
    expect(stepButton(board.container, 'right').getAttribute('data-blocker')).toBe('paused')
  })

  it('disables a run-starting arrow until the elevated permission is confirmed', async () => {
    const board = mount({
      tasks: [task({ status: 'clarification', permission: 'danger-full-access' })],
      host: HOST,
    })
    await board.render()

    const right = stepButton(board.container, 'right')
    expect(right.getAttribute('data-target')).toBe('running')
    expect(right.disabled).toBe(true)
    expect(right.getAttribute('data-blocker')).toBe('permission')
    // The plain move left does not start a run and stays available.
    expect(stepButton(board.container, 'left').disabled).toBe(false)
  })

  it('disables only the arrow whose target is already queued', async () => {
    const board = mount({
      tasks: [task({ status: 'clarification' })],
      pendingTransitions: [{ taskId: 't1', from: 'clarification', to: 'backlog', requestedAt: 1 }],
    })
    await board.render()

    const left = stepButton(board.container, 'left')
    expect(left.disabled).toBe(true)
    expect(left.getAttribute('data-queued')).toBe('true')
    expect(stepButton(board.container, 'right').disabled).toBe(false)
  })

  it('renders no arrows on archived cards', async () => {
    const board = mount({
      archiveView: true,
      tasks: [task({ status: 'done', archivedAt: 1 })],
    })
    await board.render()

    expect(board.container.querySelector('[data-dsh-part="card"]')).not.toBeNull()
    expect(board.container.querySelector('[data-dsh-part^="card-step-"]')).toBeNull()
  })

  it('re-renders the card in its new column after the controller confirms the move', async () => {
    let current: ControllerSnapshot = {
      tasks: [task({ status: 'clarification' })],
      boardOpen: true,
      archiveView: false,
      selectedTaskId: undefined,
      executionOptions: { workspaces: [], presets: [] },
      pendingTaskIds: [],
    }
    const listeners = new Set<() => void>()
    const controller = {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      closeBoard: () => {},
      toggleArchiveView: () => {},
      retryHostSync: async () => {},
      openTask: () => {},
      moveTask: (id: string, status: TaskRecord['status']) => {
        current = { ...current, tasks: current.tasks.map(entry => entry.id === id ? { ...entry, status, updatedAt: 2 } : entry) }
        for (const listener of listeners) listener()
      },
    } as unknown as BoardController
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    await act(async () => { stepButton(container, 'right').click() })

    const runningColumn = container.querySelector('section[data-status="running"]')
    expect(runningColumn?.textContent).toContain('Task A')
    expect(container.querySelector('section[data-status="clarification"]')?.textContent).not.toContain('Task A')
    // Running is the runner's column: both arrows are disabled there.
    expect(stepButton(container, 'right').disabled).toBe(true)
    expect(stepButton(container, 'right').getAttribute('data-blocker')).toBe('running')
  })
})
