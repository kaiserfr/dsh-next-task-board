// @vitest-environment jsdom
/**
 * Follow-up UI: the detail's follow-up button opens an empty new-task dialog
 * (linked to the source), the source card shows what it continues, the source
 * of a follow-up renders the reverse reference and has its run/release buttons
 * disabled, and the board card carries the small badge.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskCard } from '../src/client/board/TaskCard.tsx'
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
    description: 'old description',
    prompt: 'old prompt',
    status: 'done',
    createdAt: 0,
    updatedAt: 0,
    executions: [{ id: 'e1', sessionId: 'session-run', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined }],
    ...overrides,
  }
}

function followUpCard(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return card({
    id: 'card-fu',
    title: 'Follow-up: Login flow',
    status: 'backlog',
    followUp: {
      sourceTaskId: 'card-1',
      sessionId: 'session-run',
      title: 'Login flow',
      description: 'old description',
      prompt: 'old prompt',
      createdAt: 1,
    },
    ...overrides,
  })
}

function controller(tasks: TaskRecord[], overrides: Partial<BoardController> = {}): BoardController {
  const state: ControllerSnapshot = {
    tasks,
    boardOpen: true,
    archiveView: false,
    selectedTaskId: tasks[0]?.id,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    host: {
      revision: 1,
      scheduler: { timeZone: 'UTC' },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      sessionDefaultPermission: 'read-only',
    },
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeTask: () => {},
    moveTask: () => {},
    openTask: vi.fn(),
    createTaskConfirmed: vi.fn().mockResolvedValue({ id: 'card-new' }),
    discardFormDraft: vi.fn(),
    saveFormDraft: vi.fn(),
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

function field(container: HTMLElement, placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`)
  if (element === null) throw new Error(`no field with placeholder ${placeholder}`)
  return element
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('follow-up detail and modal', () => {
  it('offers a follow-up button on a settled source card', () => {
    const container = render(<TaskDetail controller={controller([card()])} task={card()} />)
    const button = container.querySelector('[data-dsh-part="detail-follow-up-button"]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)
    expect(button!.textContent).toBe(t('detail.followUp'))
  })

  it('opens the new-task dialog empty and submits only the follow-up task', async () => {
    const current = card()
    const fake = controller([current])
    const container = render(<TaskDetail controller={fake} task={current} />)

    const button = container.querySelector('[data-dsh-part="detail-follow-up-button"]') as HTMLButtonElement
    await act(async () => { button.click() })

    expect(container.querySelector('[data-dsh-part="new-follow-up"]')).not.toBeNull()
    // Unlike a duplicate, a follow-up carries only its own, yet-to-be-written
    // task: none of the source's text may sit in the boxes.
    const title = field(container, t('new.titlePlaceholder')) as HTMLInputElement
    expect(title.value).toBe('')
    expect(field(container, t('new.descriptionPlaceholder')).value).toBe('')
    expect(field(container, t('new.promptPlaceholder')).value).toBe('')

    const submit = [...container.querySelectorAll('button')].find(item => item.textContent === t('new.submit'))
    expect(submit).toBeDefined()
    // An unnamed follow-up is not created; the reason is the form's error line.
    await act(async () => { submit!.click() })
    expect(fake.createTaskConfirmed).not.toHaveBeenCalled()
    expect(container.textContent).toContain(t('new.required'))

    typeInto(title, 'Fix the logout redirect')
    await act(async () => { submit!.click() })

    expect(fake.createTaskConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fix the logout redirect',
      description: '',
      prompt: '',
      followUpOf: 'card-1',
    }))
  })

  it('disables the follow-up button while the source still runs or already has an active follow-up', () => {
    const running = card({
      id: 'card-run',
      // A `tested` card can still own an open test run: the follow-up button is
      // offered there, but disabled until the conversation is free.
      status: 'tested',
      executions: [{ id: 'open', sessionId: 's', startedAt: 0, endedAt: undefined, result: undefined, error: undefined }],
    })
    const first = render(<TaskDetail controller={controller([running])} task={running} />)
    const runningButton = first.querySelector('[data-dsh-part="detail-follow-up-button"]') as HTMLButtonElement
    expect(runningButton.disabled).toBe(true)
    expect(runningButton.title).toBe(t('detail.followUp.blocked.openRun'))

    const source = card()
    const active = followUpCard()
    const second = render(<TaskDetail controller={controller([source, active])} task={source} />)
    const activeButton = second.querySelector('[data-dsh-part="detail-follow-up-button"]') as HTMLButtonElement
    expect(activeButton.disabled).toBe(true)
    expect(activeButton.title).toBe(t('detail.followUp.blocked.active'))
  })

  it('shows the frozen previous task on a follow-up card', () => {
    const source = card()
    const followUp = followUpCard()
    const container = render(<TaskDetail controller={controller([source, followUp])} task={followUp} />)
    const section = container.querySelector('[data-dsh-part="detail-follow-up"]')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('Login flow')
    expect(section!.textContent).toContain('old description')
    expect(section!.textContent).toContain('old prompt')
  })

  it('links the follow-ups of a source card and locks the transition into the merge', () => {
    const source = card({ status: 'tested', merge: undefined })
    const followUp = followUpCard()
    const container = render(<TaskDetail controller={controller([source, followUp])} task={source} />)

    expect(container.querySelector('[data-dsh-part="detail-follow-ups"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="detail-follow-up-lock"]')).not.toBeNull()
    const release = container.querySelector('[data-dsh-part="transition-button"][data-target="done"]') as HTMLButtonElement | null
    expect(release).not.toBeNull()
    expect(release!.disabled).toBe(true)
    expect(release!.getAttribute('data-blocker')).toBe('followup')
  })
})

describe('follow-up card badge', () => {
  it('marks a follow-up card and its source with their own badges', () => {
    const container = render(
      <TaskCard
        task={followUpCard()}
        pending={false}
        selected={false}
        dragging={false}
        sessionRunning={false}
        hasFollowUpSource
        followUpSourceHint={t('card.followUpSourceHint', { titles: 'Follow-up: Login flow' })}
        onClick={() => {}}
        onKeyDown={() => {}}
        onDoubleClick={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onOpenSession={() => {}}
        onTogglePause={() => {}}
        onStopSession={() => {}}
        onStep={() => {}}
      />,
    )
    expect(container.querySelector('[data-dsh-part="card-follow-up"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-part="card-follow-up-source"]')).not.toBeNull()
  })
})
