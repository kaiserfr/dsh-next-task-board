// @vitest-environment jsdom
/**
 * The review block in the card detail: it appears for cards standing in the
 * review column and nowhere else, it names the card's own directory, its app
 * links point at the card's assigned port, and the controls address that one
 * card — the Host's own plans decide what is offered.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord, TaskReview } from '../src/core/tasks.ts'

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
    status: 'ready_for_test',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    git: { branch: 'task/card-1', base: 'main', repoPath: '/repo', worktreePath: '/worktrees/card-1', reviewedCommit: 'abcdef1234567890' },
    ...overrides,
  }
}

function review(overrides: Partial<TaskReview> = {}): TaskReview {
  return { mode: 'command', source: '/repo', dir: '/worktrees/card-1', ...overrides }
}

interface Harness {
  controller: BoardController
  calls: Record<string, unknown[]>
}

function harness(options: { task?: TaskRecord; plan?: Record<string, unknown> | undefined; canRead?: boolean } = {}): Harness {
  const task = options.task ?? card()
  const calls: Record<string, unknown[]> = {}
  const state: ControllerSnapshot = {
    tasks: [task],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: task.id,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    canReviewRead: options.canRead ?? true,
    host: {
      revision: 1,
      scheduler: { timeZone: 'UTC' },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      sessionDefaultPermission: 'read-only',
      reviewPlans: options.plan === undefined
        ? { [task.id]: { dir: '/worktrees/card-1', worktree: true, workspaceFile: '/worktrees/card-1/proj.code-workspace', available: true, logs: true } }
        : options.plan as ControllerSnapshot['host'] extends undefined ? never : Record<string, { dir?: string; worktree?: boolean; workspaceFile?: string; available: boolean; logs?: boolean; pending?: 'start' | 'stop' | 'restart' }>,
    },
  }
  const record = (name: string) => async (...args: unknown[]): Promise<unknown> => {
    calls[name] = args
    return name === 'openWorktree' ? { ok: true, text: '/worktrees/card-1' } : name === 'loadReviewLogs' ? { ok: true, text: 'log line' } : { ok: true, text: ' app.py | 4 ++\n' }
  }
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeTask: () => {},
    reviewStart: record('reviewStart'),
    reviewStop: record('reviewStop'),
    reviewRestart: record('reviewRestart'),
    openWorktree: record('openWorktree'),
    loadReviewLogs: record('loadReviewLogs'),
    loadReviewDiff: record('loadReviewDiff'),
  } as unknown as BoardController
  return { controller, calls }
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

/** One review control by its marker (labels are localized). */
function control(container: HTMLElement, action: string): HTMLElement | null {
  return container.querySelector(`[data-dsh-part="review"] [data-action="${action}"]`)
}

describe('review block', () => {
  it('renders for a card in the review column and names its own worktree', () => {
    const { controller } = harness()
    const container = render(<TaskDetail controller={controller} task={card()} />)
    const block = container.querySelector('[data-dsh-part="review"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('/worktrees/card-1')
    expect(block!.textContent).toContain('task/card-1')
    expect(block!.textContent).toContain('abcdef1234')
  })

  it('stays hidden in every other column and for archived cards', () => {
    for (const task of [card({ status: 'todo' }), card({ status: 'running' }), card({ status: 'done' }), card({ archivedAt: 1 })]) {
      const { controller } = harness({ task })
      const container = render(<TaskDetail controller={controller} task={task} />)
      expect(container.querySelector('[data-dsh-part="review"]'), task.status).toBeNull()
      document.body.replaceChildren()
    }
  })

  it('sends the start, stop and restart controls to this card', () => {
    const running = review({ startedAt: 1_700_000_000_000 })
    const { controller, calls } = harness({ task: card({ review: running }) })
    const container = render(<TaskDetail controller={controller} task={card({ review: running })} />)
    for (const action of ['start', 'stop', 'restart', 'logs']) {
      expect(control(container, action), action).not.toBeNull()
    }

    click(control(container, 'stop'))
    expect(calls.reviewStop).toEqual(['card-1'])
    click(control(container, 'restart'))
    expect(calls.reviewRestart).toEqual(['card-1'])
  })

  it('disables the action buttons while one is in flight and says what it is', () => {
    const { controller } = harness({ plan: { 'card-1': { dir: '/worktrees/card-1', worktree: true, available: true, logs: true, pending: 'start' } } })
    const container = render(<TaskDetail controller={controller} task={card()} />)
    const block = container.querySelector('[data-dsh-part="review"]')!
    expect(block.textContent).not.toHaveLength(0)
    for (const action of ['start', 'stop', 'restart']) {
      expect((control(container, action) as HTMLButtonElement).disabled, action).toBe(true)
    }
    expect(block.getAttribute('data-state')).toBeNull()
    expect(block.querySelector('[data-dsh-part="review-status"]')?.getAttribute('data-state')).toBe('start')
  })

  it('links the running app at the port the card reports', () => {
    const running = review({ startedAt: 1_700_000_000_000, links: ['http://127.0.0.1:8123'], env: { DSH_COMPOSE_PORT: '8123' } })
    const { controller } = harness({ task: card({ review: running }) })
    const container = render(<TaskDetail controller={controller} task={card({ review: running })} />)
    const link = control(container, 'app-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('http://127.0.0.1:8123')
    // A stopped version offers no app link: the port may belong to nobody.
    const stopped = review({ env: { DSH_COMPOSE_PORT: '8123' }, links: ['http://127.0.0.1:8123'] })
    const second = harness({ task: card({ review: stopped }) })
    const other = render(<TaskDetail controller={second.controller} task={card({ review: stopped })} />)
    expect(other.querySelector('[data-dsh-part="review-links"]')).toBeNull()
  })

  it('starts the editor through the Host read instead of a bare link', async () => {
    const { controller, calls } = harness()
    const container = render(<TaskDetail controller={controller} task={card()} />)
    click(control(container, 'editor'))
    expect(calls.openWorktree).toEqual(['card-1'])
    // The Host answer lands asynchronously; flush it inside act so the notice
    // does not update outside React's test environment.
    await act(async () => { await Promise.resolve() })
  })

  it('shows the logs of the card in a modal', async () => {
    const running = review({ startedAt: 1_700_000_000_000, links: ['http://127.0.0.1:8123'] })
    const { controller, calls } = harness({ task: card({ review: running }) })
    const container = render(<TaskDetail controller={controller} task={card({ review: running })} />)
    click(control(container, 'logs'))
    expect(calls.loadReviewLogs).toEqual(['card-1'])
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-dsh-part="review-logs"]')?.textContent).toContain('log line')
  })

  it('says what is missing when the workspace configures nothing', () => {
    const { controller } = harness({ plan: { 'card-1': { dir: '/worktrees/card-1', worktree: true, available: false, logs: false } } })
    const container = render(<TaskDetail controller={controller} task={card()} />)
    const block = container.querySelector('[data-dsh-part="review"]')!
    // The hint names the setting, and the only control left is the editor jump:
    // there is nothing to start, so no container buttons are offered.
    expect(block.textContent).toContain('reviewEnvironments')
    expect(control(container, 'editor')).not.toBeNull()
    for (const action of ['start', 'stop', 'restart', 'logs']) {
      expect(control(container, action), action).toBeNull()
    }
  })

  it('surfaces the Host failure of the last action', () => {
    const failed = review({ error: 'port 8090 is already in use' })
    const { controller } = harness({ task: card({ review: failed }) })
    const container = render(<TaskDetail controller={controller} task={card({ review: failed })} />)
    expect(container.querySelector('[data-dsh-part="review"]')!.textContent).toContain('port 8090 is already in use')
  })
})
