// @vitest-environment jsdom
/**
 * Pause/resume UI: the board's bulk button suspends every card in "In
 * progress" in one click (pause glyph), a card carries the pause/play control
 * of its own run, and the detail's execution button turns into that same
 * control. A paused card keeps its column and only clears the stamp when it is
 * resumed with the "continue" turn.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    title: 'Task A',
    description: '',
    prompt: 'do it',
    status: 'running',
    createdAt: 0,
    updatedAt: 0,
    // An open run holding a session: the card is "in progress" and running.
    executions: [{ id: 'e1', sessionId: 'session-run', startedAt: 0, endedAt: undefined, result: undefined, error: undefined }],
    ...overrides,
  }
}

function fakeController(snapshot?: Partial<ControllerSnapshot>, overrides?: Partial<BoardController>): BoardController {
  const state: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    host: {
      revision: 1,
      scheduler: { timeZone: 'UTC' },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      sessionDefaultPermission: 'read-only',
    },
    ...snapshot,
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    closeTask: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: () => {},
    moveTask: () => {},
    moveTasks: async () => true,
    rerunTask: async () => {},
    pauseTasks: async () => true,
    resumeTasks: async () => true,
    ...overrides,
  } as unknown as BoardController
}

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}

function click(button: Element | null): void {
  expect(button).not.toBeNull()
  act(() => { (button as HTMLButtonElement).click() })
}

describe('board-wide pause/resume', () => {
  it('pauses every in-progress card in one click', () => {
    const pauseTasks = vi.fn(async () => true)
    const controller = fakeController({
      tasks: [
        task({ id: 'a' }),
        task({ id: 'b' }),
        // Queued: in progress without a session, paused with the same action.
        task({ id: 'c', executions: [{ id: 'e2', sessionId: undefined, startedAt: 0, endedAt: undefined, result: undefined, error: undefined }] }),
        task({ id: 'd', status: 'todo', executions: [] }),
      ],
    }, { pauseTasks })
    const container = render(<TaskBoard controller={controller} />)

    const button = container.querySelector('[data-dsh-part="pause-all"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('⏸')
    expect(button.disabled).toBe(false)
    click(button)
    expect(pauseTasks).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  it('turns into the play button and resumes all paused cards', () => {
    const resumeTasks = vi.fn(async () => true)
    const controller = fakeController({
      tasks: [task({ id: 'a', pausedAt: 5 }), task({ id: 'b', pausedAt: 5 })],
    }, { resumeTasks })
    const container = render(<TaskBoard controller={controller} />)

    const button = container.querySelector('[data-dsh-part="pause-all"]') as HTMLButtonElement
    expect(button.textContent).toContain('▶')
    click(button)
    expect(resumeTasks).toHaveBeenCalledWith(['a', 'b'])
  })

  it('is disabled while nothing is in progress', () => {
    const controller = fakeController({ tasks: [task({ id: 'a', status: 'todo', executions: [] })] })
    const container = render(<TaskBoard controller={controller} />)
    expect((container.querySelector('[data-dsh-part="pause-all"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('card pause/resume control', () => {
  it('pauses the card run from the card', () => {
    const pauseTasks = vi.fn(async () => true)
    const controller = fakeController({ tasks: [task({ id: 'a' })] }, { pauseTasks })
    const container = render(<TaskBoard controller={controller} />)

    const button = container.querySelector('[data-dsh-part="card-pause"]') as HTMLButtonElement
    expect(button.textContent).toContain('⏸')
    click(button)
    expect(pauseTasks).toHaveBeenCalledWith(['a'])
  })

  it('marks a paused card and resumes it from the card', () => {
    const resumeTasks = vi.fn(async () => true)
    const controller = fakeController({ tasks: [task({ id: 'a', pausedAt: 5 })] }, { resumeTasks })
    const container = render(<TaskBoard controller={controller} />)

    expect(container.querySelector('[data-dsh-part="card-paused"]')).not.toBeNull()
    // Not running and not queued: the paused card shows neither badge.
    expect(container.querySelector('[data-dsh-part="card"]')?.getAttribute('data-paused')).toBe('true')
    expect(container.querySelector('[data-dsh-part="card"]')?.getAttribute('data-executing')).toBeNull()
    const button = container.querySelector('[data-dsh-part="card-resume"]') as HTMLButtonElement
    expect(button.textContent).toContain('▶')
    click(button)
    expect(resumeTasks).toHaveBeenCalledWith(['a'])
  })
})

describe('detail pause/resume control', () => {
  it('pauses a running card through the execution button', () => {
    const pauseTasks = vi.fn(async () => true)
    const controller = fakeController({ tasks: [task({ id: 't1' })], selectedTaskId: 't1' }, { pauseTasks })
    const container = render(<TaskDetail controller={controller} task={task({ id: 't1' })} />)

    const button = container.querySelector('[data-dsh-part="detail-pause"]') as HTMLButtonElement
    expect(button.textContent).toContain('⏸')
    click(button)
    expect(pauseTasks).toHaveBeenCalledWith(['t1'])
  })

  it('continues a paused card and shows the paused badge', () => {
    const resumeTasks = vi.fn(async () => true)
    const paused = task({ id: 't1', pausedAt: 5 })
    const controller = fakeController({ tasks: [paused], selectedTaskId: 't1' }, { resumeTasks })
    const container = render(<TaskDetail controller={controller} task={paused} />)

    expect(container.querySelector('[data-dsh-part="detail-paused"]')).not.toBeNull()
    const button = container.querySelector('[data-dsh-part="detail-resume"]') as HTMLButtonElement
    expect(button.textContent).toContain('▶')
    click(button)
    expect(resumeTasks).toHaveBeenCalledWith(['t1'])
  })
})
