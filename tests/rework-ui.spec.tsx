// @vitest-environment jsdom
/**
 * Rework UI: a card that failed its test goes back to To Do with the button
 * that is left (the status move), and the correction is written in the card's
 * own chat — the detail view collects no note text any more.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

function card(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'card-1',
    title: 'Login flow',
    description: '',
    prompt: 'open the page',
    status: 'ready_for_test',
    createdAt: 0,
    updatedAt: 0,
    executions: [{ id: 'e1', sessionId: 'session-run', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined }],
    ...overrides,
  }
}

function controller(): BoardController {
  const state: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: 'card-1',
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    host: { revision: 1, scheduler: { timeZone: 'UTC' }, power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true }, sessionDefaultPermission: 'read-only' },
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeTask: () => {},
    moveTask: () => {},
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

describe('rework after a failed test', () => {
  it('offers no correction note field on a card parked in ready_for_test', () => {
    const container = render(<TaskDetail controller={controller()} task={card()} />)
    expect(container.querySelector('[data-dsh-part="rework"]')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('keeps the way back to To Do as a plain status move', () => {
    const container = render(<TaskDetail controller={controller()} task={card()} />)
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(t('status.move.todo')))
    expect(button).toBeDefined()
  })

  it('shows the stamp of a card that was sent back, without any note text', () => {
    const container = render(<TaskDetail controller={controller()} task={card({ status: 'todo', reworkAt: 1_700_000_000_000, reworkCount: 2 })} />)
    const stamp = container.querySelector('[data-dsh-part="rework-stamp"]')
    expect(stamp).not.toBeNull()
    expect(stamp!.textContent).toContain('2')
  })

  it('marks the execution row of a rework round', () => {
    const container = render(<TaskDetail controller={controller()} task={card({
      executions: [{ id: 'e2', sessionId: 'session-run', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined, rework: true }],
    })} />)
    expect(container.querySelector('[data-dsh-part="execution-rework"]')).not.toBeNull()
  })
})
