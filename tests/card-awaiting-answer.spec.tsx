// @vitest-environment jsdom
/**
 * The waiting-question symbol: a card whose conversation holds a question the
 * agent asked and stopped on carries a question-mark anchor in its top-left
 * corner. Clicking it jumps straight into that session (same deep link and
 * click rules as the session link), and the symbol is gone the moment the Host
 * stops naming the card.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { t } from '../src/client/locales.ts'
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

/** A settled clarification run of an `executions` list. */
function clarificationRun(startedAt: number, sessionId: string): ExecutionRecord {
  return { id: `run-${startedAt}`, sessionId, startedAt, endedAt: startedAt + 5, result: 'succeeded', error: undefined, kind: 'clarify' }
}

/** The Host share of a snapshot: only the question map matters here. */
function host(awaitingAnswer: Record<string, string>) {
  return {
    revision: 1,
    scheduler: { timeZone: 'UTC' },
    power: { platform: 'linux', phase: 'disabled' as const, enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
    awaitingAnswer,
  }
}

function render(initial: Partial<ControllerSnapshot>) {
  let state: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    ...initial,
  }
  const opened: string[] = []
  const details: string[] = []
  // The board renders from the controller's snapshot subscription, so a redraw
  // pushes the new state through exactly that channel (a fresh root.render would
  // keep the state React captured at mount).
  let notify: (() => void) | undefined
  let mounted = false
  const controller = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { notify = fn; return () => {} },
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: (id: string) => { details.push(id) },
    moveTask: () => {},
    openSession: (id: string) => { opened.push(id) },
    dismissSessionOpenError: () => {},
  } as unknown as BoardController
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  return {
    container,
    opened,
    details,
    draw: async (next: Partial<ControllerSnapshot>): Promise<void> => {
      state = { ...state, ...next }
      await act(async () => {
        if (mounted) notify?.()
        else {
          mounted = true
          root.render(<TaskBoard controller={controller} />)
        }
      })
    },
  }
}

describe('card → waiting question', () => {
  it('marks the card whose conversation waits and jumps into that session', async () => {
    const view = render({
      tasks: [task({ clarificationSessionId: 'session-q', executions: [clarificationRun(10, 'session-q')] })],
      host: host({ t1: 'session-q' }),
    })
    await view.draw({})

    const symbol = view.container.querySelector('a[data-dsh-part="card-awaiting-answer"]') as HTMLAnchorElement
    expect(symbol).not.toBeNull()
    expect(symbol.getAttribute('href')).toBe('#session=session-q')
    expect(symbol.getAttribute('aria-label')).toBe(t('card.awaitingAnswer'))
    expect(symbol.textContent).toContain('?')
    // The card reserves the corner the symbol sits in.
    expect(view.container.querySelector('[data-dsh-part="card"]')?.getAttribute('data-answering')).toBe('true')

    await act(async () => { symbol.click() })
    expect(view.opened).toEqual(['session-q'])
    // The jump is direct: the detail must not open as a side effect.
    expect(view.details).toEqual([])
  })

  it('shows no symbol while the Host names no card, and drops it when the answer arrives', async () => {
    const card = task({ clarificationSessionId: 'session-q', executions: [clarificationRun(10, 'session-q')] })
    const view = render({ tasks: [card], host: host({}) })
    await view.draw({})
    expect(view.container.querySelector('a[data-dsh-part="card-awaiting-answer"]')).toBeNull()
    // The card's ordinary session link stays in place.
    expect(view.container.querySelector('a[data-dsh-part="card-session"]')).not.toBeNull()

    await view.draw({ host: host({ t1: 'session-q' }) })
    expect(view.container.querySelector('a[data-dsh-part="card-awaiting-answer"]')).not.toBeNull()

    await view.draw({ host: host({}) })
    expect(view.container.querySelector('a[data-dsh-part="card-awaiting-answer"]')).toBeNull()
    expect(view.container.querySelector('[data-dsh-part="card"]')?.getAttribute('data-answering')).toBeNull()
  })

  it('never marks an archived card', async () => {
    const view = render({
      archiveView: true,
      tasks: [task({ status: 'done', archivedAt: 99, executions: [clarificationRun(10, 'session-q')] })],
      host: host({ t1: 'session-q' }),
    })
    await view.draw({})
    expect(view.container.querySelector('a[data-dsh-part="card-awaiting-answer"]')).toBeNull()
  })
})
