// @vitest-environment jsdom
/**
 * Rework UI: a card that failed its test can go back to To Do with a
 * correction note, and the note is only offered where it means something.
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

function controller(reworkTask = vi.fn(async () => true)): { controller: BoardController; reworkTask: typeof reworkTask } {
  const state: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: 'card-1',
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    host: { revision: 1, scheduler: { timeZone: 'UTC' }, power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true }, sessionDefaultPermission: 'read-only' },
  }
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeTask: () => {},
    moveTask: () => {},
    reworkTask,
  } as unknown as BoardController
  return { controller, reworkTask }
}

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('rework after a failed test', () => {
  it('offers a correction note on a card parked in ready_for_test', () => {
    const { controller: ctrl } = controller()
    const container = render(<TaskDetail controller={ctrl} task={card()} />)
    expect(container.querySelector('[data-dsh-part="rework"]')).not.toBeNull()
    const textarea = container.querySelector('[data-dsh-part="rework"] textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    const send = container.querySelector('[data-dsh-part="rework"] button') as HTMLButtonElement
    // Nothing to send yet: an empty note never opens a round.
    expect(send.disabled).toBe(true)
    type(textarea, 'the redirect is missing')
    expect(send.disabled).toBe(false)
  })

  it('sends the trimmed note through the controller', async () => {
    const reworkTask = vi.fn(async () => true)
    const { controller: ctrl } = controller(reworkTask)
    const container = render(<TaskDetail controller={ctrl} task={card()} />)
    const textarea = container.querySelector('[data-dsh-part="rework"] textarea') as HTMLTextAreaElement
    type(textarea, '  the redirect is missing  ')
    const send = container.querySelector('[data-dsh-part="rework"] button') as HTMLButtonElement
    await act(async () => { send.click() })
    expect(reworkTask).toHaveBeenCalledWith('card-1', 'the redirect is missing')
    // An accepted note leaves the field empty, ready for the next round.
    expect(textarea.value).toBe('')
  })

  it('hides the note field where it has no meaning and shows a pending note instead', () => {
    const { controller: ctrl } = controller()
    const container = render(<TaskDetail controller={ctrl} task={card({ status: 'todo' })} />)
    expect(container.querySelector('[data-dsh-part="rework"]')).toBeNull()

    const pending = render(<TaskDetail controller={ctrl} task={card({ status: 'todo', reworkNote: 'fix the redirect' })} />)
    const note = pending.querySelector('[data-dsh-part="rework-note"]')
    expect(note).not.toBeNull()
    expect(note!.textContent).toContain('fix the redirect')
  })

  it('keeps the note readable on the execution row after the run consumed it', () => {
    const { controller: ctrl } = controller()
    const consumed = card({
      status: 'ready_for_test',
      executions: [{
        id: 'e2', sessionId: 'session-run', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined,
        reworkNote: 'the redirect is missing',
      }],
    })
    const container = render(<TaskDetail controller={ctrl} task={consumed} />)
    const row = container.querySelector('[data-dsh-part="execution-rework-note"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('the redirect is missing')
  })
})
