// @vitest-environment jsdom
/**
 * Direct card → session jump: a card whose latest execution carries a session
 * offers a link into that session — for a live (running) execution and for a
 * settled (inactive) one alike — without opening the task detail. The link is
 * an anchor so the session is also reachable through its `#session=<id>` deep
 * link (middle-click / copy), which the client boot listener consumes.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { sessionLinkHref, sessionLinkTarget } from '../src/client/session-link.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { ExecutionRecord, TaskRecord } from '../src/core/tasks.ts'

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
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    ...overrides,
  }
}

/** A settled execution (inactive session) of an `executions` list. */
function settledRun(startedAt: number, sessionId?: string): ExecutionRecord {
  return { id: `run-${startedAt}`, sessionId, startedAt, endedAt: startedAt + 5, result: 'succeeded', error: undefined }
}

/** A still-open execution (active session) of an `executions` list. */
function openRun(startedAt: number, sessionId?: string): ExecutionRecord {
  return { id: `run-${startedAt}`, sessionId, startedAt, endedAt: undefined, result: undefined, error: undefined }
}

function render(snapshot: Partial<ControllerSnapshot>, overrides: Partial<BoardController> = {}) {
  const state: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    ...snapshot,
  }
  const opened: string[] = []
  const details: string[] = []
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: (id: string) => { details.push(id) },
    moveTask: () => {},
    openSession: (id: string) => { opened.push(id) },
    dismissSessionOpenError: () => {},
    ...overrides,
  } as unknown as BoardController
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  return { container, controller, opened, details, render: async () => { await act(async () => { root.render(<TaskBoard controller={controller} />) }) } }
}

describe('card → session jump', () => {
  it('links an inactive (settled) execution to its session', async () => {
    const view = render({ tasks: [task({ status: 'done', executions: [settledRun(10, 'session-old')] })] })
    await view.render()

    const link = view.container.querySelector('a[data-dsh-part="card-session"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('#session=session-old')
    expect(link.textContent).toContain('⌁')

    await act(async () => { link.click() })
    expect(view.opened).toEqual(['session-old'])
    // The jump is direct: the detail must not open as a side effect.
    expect(view.details).toEqual([])
  })

  it('links an active (running) execution to its session', async () => {
    const view = render({ tasks: [task({ status: 'running', executions: [openRun(20, 'session-live')] })] })
    await view.render()

    const link = view.container.querySelector('a[data-dsh-part="card-session"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('#session=session-live')

    await act(async () => { link.click() })
    expect(view.opened).toEqual(['session-live'])
    expect(view.details).toEqual([])
  })

  it('links an archived task card too (it stays a reachable session)', async () => {
    const view = render({
      archiveView: true,
      tasks: [task({ status: 'done', archivedAt: 99, executions: [settledRun(10, 'session-archived')] })],
    })
    await view.render()

    const link = view.container.querySelector('a[data-dsh-part="card-session"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('#session=session-archived')
  })

  it('renders no link for a run that has not attached a session yet', async () => {
    const view = render({ tasks: [task({ status: 'running', executions: [openRun(30)] })] })
    await view.render()

    expect(view.container.querySelector('[data-dsh-part="card-session"]')).toBeNull()
  })

  it('keeps the double click opening the detail while a mark does not', async () => {
    const view = render({ tasks: [task({ status: 'todo', executions: [settledRun(10, 'session-old')] })] })
    await view.render()

    const card = view.container.querySelector('button[data-dsh-part="card"]') as HTMLButtonElement
    await act(async () => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    })
    expect(view.details).toEqual([])
    expect(card.getAttribute('data-selected')).toBe('true')

    await act(async () => {
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
    })
    expect(view.details).toEqual(['t1'])
    expect(view.opened).toEqual([])
  })
})

describe('session deep link', () => {
  it('round-trips a session id through the hash target', () => {
    const href = sessionLinkHref('session-abc-123')
    expect(href).toBe('#session=session-abc-123')
    expect(sessionLinkTarget(href)).toBe('session-abc-123')
  })

  it('ignores unrelated or blank fragments', () => {
    expect(sessionLinkTarget('')).toBeUndefined()
    expect(sessionLinkTarget('#')).toBeUndefined()
    expect(sessionLinkTarget('#session=')).toBeUndefined()
    expect(sessionLinkTarget('#other=1')).toBeUndefined()
  })
})
