// @vitest-environment jsdom
/**
 * Specification release in the task detail: an unreleased card shows the gate
 * with the release button, a released one shows the stamp instead, and a card
 * outside the implementation path (done, archived) shows neither.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
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
    title: 'Card',
    description: '',
    prompt: 'p',
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    ...overrides,
  }
}

function controller(approve?: (id: string) => void): BoardController {
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
    confirmPermission: async () => true,
    approveSpec: approve ?? (async () => true),
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

describe('specification release UI', () => {
  it('offers the release button for an unreleased card and calls the controller', () => {
    const approve = vi.fn(async () => true)
    const container = render(<TaskDetail controller={controller(approve)} task={card()} />)
    const gate = container.querySelector('[data-dsh-part="spec-gate"]')
    expect(gate).not.toBeNull()
    const button = gate!.querySelector('button')
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(approve).toHaveBeenCalledWith('card-1')
    document.body.replaceChildren()
  })

  it('shows the released stamp instead of the gate', () => {
    const container = render(<TaskDetail controller={controller()} task={card({ specApprovedAt: 1_700_000_000_000 })} />)
    expect(container.querySelector('[data-dsh-part="spec-gate"]')).toBeNull()
    expect(container.textContent).toContain('规格已放行')
  })

  it('shows no gate on a card that is history', () => {
    const done = render(<TaskDetail controller={controller()} task={card({ status: 'done' })} />)
    expect(done.querySelector('[data-dsh-part="spec-gate"]')).toBeNull()
  })
})
