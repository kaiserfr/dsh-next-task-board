// @vitest-environment jsdom
/**
 * The merge side of the review column: the card carries the merge verdict, and
 * the review block offers the release. The release asks first (it is the one
 * action that ends the review), and the button is the card's own action — never a
 * global one.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

const GIT = { branch: 'task/card-1', base: 'main', repoPath: '/repo', worktreePath: '/worktrees/card-1', reviewedCommit: 'abcdef1234567890' }

function card(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'card-1',
    title: 'Card',
    description: '',
    prompt: 'p',
    status: 'tested',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    git: GIT,
    ...overrides,
  }
}

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}

function click(element: Element | null | undefined): void {
  if (element === null || element === undefined) throw new Error('the control is missing')
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** The card badge of a board rendered with the given cards. */
function badgeOf(tasks: TaskRecord[], id = 'card-1'): HTMLElement | null {
  const state: ControllerSnapshot = {
    tasks,
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    host: {
      revision: 1,
      scheduler: { timeZone: 'UTC' },
      power: { platform: 'linux', phase: 'disabled', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      reviewPlans: { [id]: { dir: GIT.worktreePath, worktree: true, available: true, logs: true } },
    },
  }
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: () => {},
    moveTask: () => {},
    moveTasks: async () => false,
    openSession: () => {},
    dismissSessionOpenError: () => {},
  } as unknown as BoardController
  const container = render(<TaskBoard controller={controller} />)
  return container.querySelector(`[data-dsh-part="card"][data-task-id="${id}"] [data-dsh-part="card-merge"]`)
    ?? container.querySelector('[data-dsh-part="card-merge"]')
}

/**
 * A board render of the given cards whose controller records the release call.
 * `options` patches the derived Host fields the card's glyph depends on.
 */
function boardOf(tasks: TaskRecord[], options: { pending?: string[]; releasePending?: boolean } = {}): { container: HTMLElement; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {}
  const state: ControllerSnapshot = {
    tasks,
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: options.pending ?? [],
    host: {
      revision: 1,
      scheduler: { timeZone: 'UTC' },
      power: { platform: 'linux', phase: 'disabled', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      reviewPlans: {},
      ...(options.releasePending === true ? { pendingReleases: { 'card-1': { startedAt: 1 } } } : {}),
    },
  }
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: (id: string) => { calls.openTask = [id] },
    moveTask: () => {},
    moveTasks: async () => false,
    openSession: () => {},
    dismissSessionOpenError: () => {},
    approveMerge: async (id: string) => { calls.approveMerge = [id]; return true },
  } as unknown as BoardController
  return { container: render(<TaskBoard controller={controller} />), calls }
}

/** The card's own release glyph, if the board renders one. */
function releaseGlyphOf(container: HTMLElement): Element | null {
  return container.querySelector('[data-dsh-part="card-release"]')
}

/** A detail render whose controller records the release call. */function detail(task: TaskRecord): { container: HTMLElement; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {}
  const state: ControllerSnapshot = {
    tasks: [task],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: task.id,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    canReviewRead: true,
    host: {
      revision: 1,
      scheduler: { timeZone: 'UTC' },
      power: { platform: 'linux', phase: 'disabled', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      reviewPlans: { [task.id]: { dir: GIT.worktreePath, worktree: true, available: true, logs: true } },
    },
  }
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeTask: () => {},
    approveMerge: async (id: string) => { calls.approveMerge = [id]; return true },
    moveTask: () => {},
  } as unknown as BoardController
  return { container: render(<TaskDetail controller={controller} task={task} />), calls }
}

describe('card merge badge', () => {
  it('states that a reviewed card is not merged yet', () => {
    const badge = badgeOf([card()])
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('data-merge')).toBe('unmerged')
    expect(badge!.textContent).toBe(t('card.merge.unmerged'))
  })

  it('states a merged card and a card without a branch', () => {
    expect(badgeOf([card({ status: 'done', git: { ...GIT, mergedAt: 5 }, merge: { releasedAt: 4, attempts: 0, mergedAt: 5 } })])!.getAttribute('data-merge')).toBe('merged')
    document.body.replaceChildren()
    expect(badgeOf([card({ git: undefined })])!.getAttribute('data-merge')).toBe('no-branch')
  })

  it('states a failed release and a started conflict resolution', () => {
    expect(badgeOf([card({ status: 'failed', merge: { releasedAt: 4, attempts: 0, error: 'boom' } })])!.getAttribute('data-merge')).toBe('failed')
    document.body.replaceChildren()
    const resolving = card({ status: 'running', merge: { releasedAt: 4, attempts: 1, conflict: 'x' } })
    // A running card is not draggable, but its badge still answers the question.
    expect(badgeOf([resolving])!.getAttribute('data-merge')).toBe('resolving')
  })

  it('renders no badge on a card with nothing to say about a merge', () => {
    expect(badgeOf([card({ status: 'clarification', git: undefined })])).toBeNull()
  })
})

describe('release control', () => {
  it('asks for confirmation and sends the release for this card', () => {
    const { container, calls } = detail(card())
    const release = container.querySelector('[data-dsh-part="review"] [data-action="release"]')
    expect(release).not.toBeNull()
    expect(calls.approveMerge).toBeUndefined()
    click(release)
    // Nothing is merged before the dialog is confirmed.
    expect(calls.approveMerge).toBeUndefined()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('main')
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')]
      .find(button => button.textContent === t('review.releaseConfirm'))
    click(confirm)
    expect(calls.approveMerge).toEqual(['card-1'])
  })

  it('merges nothing when the confirmation is cancelled', () => {
    const { container, calls } = detail(card())
    click(container.querySelector('[data-dsh-part="review"] [data-action="release"]'))
    const cancel = [...document.querySelectorAll('[role="alertdialog"] button')]
      .find(button => button.textContent === t('delete.cancel'))
    click(cancel)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(calls.approveMerge).toBeUndefined()
  })

  it('states the merge result of a released card, conflict included', () => {
    const { container } = detail(card({ merge: { releasedAt: 1_700_000_000_000, attempts: 1, conflict: 'main could not be merged: a.txt' } }))
    const block = container.querySelector('[data-dsh-part="review-merge"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain(t('review.merge.released'))
    expect(container.textContent).toContain('main could not be merged: a.txt')
  })

  it('states a failed release with its reason, and offers no second release', () => {
    // The card came out of the release in `failed`: it keeps showing what went
    // wrong (that is what the correction is about) but the review column's
    // controls are gone — the Host would refuse them anyway.
    const { container } = detail(card({ status: 'failed', git: undefined, merge: { releasedAt: 5, attempts: 0, error: 'no reviewed commit' } }))
    expect(container.querySelector('[data-dsh-part="review-merge"]')!.getAttribute('data-merge')).toBe('failed')
    expect(container.textContent).toContain('no reviewed commit')
    expect(container.querySelector('[data-action="release"]')).toBeNull()
    expect(container.querySelector('[data-action="start"]')).toBeNull()
  })

  it('renders nothing for a failed card that never was released', () => {
    const { container } = detail(card({ status: 'failed', git: undefined }))
    expect(container.querySelector('[data-dsh-part="review"]')).toBeNull()
  })
})

describe('card release glyph', () => {
  it('offers the merge on a tested card, asks first and releases after the confirmation', () => {
    const { container, calls } = boardOf([card()])
    const glyph = releaseGlyphOf(container)
    expect(glyph).not.toBeNull()
    expect(glyph!.getAttribute('aria-label')).toBe(t('review.release'))
    // The card reserves its left edge for the glyph (`[data-releasable]` in the
    // stylesheet), so the title never runs under it on a narrow card.
    expect(container.querySelector('[data-dsh-part="card"]')!.getAttribute('data-releasable')).toBe('true')
    // The glyph acts on this card, not on the board: the card's own click (which
    // would open the detail in this render) must never also fire.
    click(glyph)
    expect(calls.openTask).toBeUndefined()
    expect(calls.approveMerge).toBeUndefined()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('main')
    click([...dialog!.querySelectorAll('button')].find(button => button.textContent === t('review.releaseConfirm')))
    expect(calls.approveMerge).toEqual(['card-1'])
  })

  it('merges nothing when the confirmation is cancelled', () => {
    const { container, calls } = boardOf([card()])
    click(releaseGlyphOf(container))
    click([...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === t('delete.cancel')))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(calls.approveMerge).toBeUndefined()
  })

  it('offers the merge on a tested card without a branch too', () => {
    const { container } = boardOf([card({ git: undefined })])
    expect(releaseGlyphOf(container)).not.toBeNull()
  })

  it('is absent in every column where the Host would refuse it', () => {
    for (const status of ['backlog', 'clarification', 'running', 'testing', 'failed', 'done'] as const) {
      const { container } = boardOf([card({ status })])
      expect(releaseGlyphOf(container), status).toBeNull()
    }
    const archived = boardOf([card({ archivedAt: 1 })])
    expect(releaseGlyphOf(archived.container)).toBeNull()
  })

  it('is absent while the release runs and while the card is already in flight', () => {
    expect(releaseGlyphOf(boardOf([card()], { releasePending: true }).container)).toBeNull()
    expect(releaseGlyphOf(boardOf([card()], { pending: ['card-1'] }).container)).toBeNull()
  })

  it('is absent while a follow-up owns the branch', () => {
    const followUp = card({
      id: 'card-2',
      title: 'Follow-up',
      status: 'backlog',
      git: undefined,
      followUp: { sourceTaskId: 'card-1', title: 'Card', description: '', prompt: 'p', createdAt: 0 },
    })
    expect(releaseGlyphOf(boardOf([card(), followUp]).container)).toBeNull()
  })
})
