/**
 * The detail's transition queue: fire-and-forget moves wait for the card's
 * other Host action, replace each other (last click wins), retry a transient
 * failure and drop a stale/hard-blocked intent with a visible reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardController, type SessionsControllerFace, type TaskBoardTransport } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskBoardAction, TaskBoardSnapshot } from '../src/protocol.ts'

function snapshot(revision: number, tasks: TaskRecord[]): TaskBoardSnapshot {
  return {
    schemaVersion: 3,
    revision,
    tasks,
    scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' },
    power: {
      platform: 'linux', phase: 'unsupported', enabled: false,
      runningSessions: 0, armedSchedules: 0, sessionStateKnown: true,
    },
    sessionDefaultPermission: 'read-only',
  }
}

function sessions(): SessionsControllerFace {
  return {
    list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => undefined },
    open: () => {},
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'A', description: '', prompt: 'work' }, 1, 'task-a'), ...overrides }
}

const openRun = (): ExecutionRecord => ({
  id: 'e1', sessionId: undefined, startedAt: 1, endedAt: undefined, result: undefined, error: undefined,
})

interface Request {
  action: TaskBoardAction
  resolve: (snapshot: TaskBoardSnapshot) => void
}

async function makeController(initial: TaskRecord | readonly TaskRecord[], options: {
  action?: (action: TaskBoardAction) => Promise<TaskBoardSnapshot>
  state?: () => Promise<TaskBoardSnapshot>
} = {}): Promise<{ controller: BoardController; requests: Request[]; action: ReturnType<typeof vi.fn> }> {
  const initialTasks = Array.isArray(initial) ? [...initial] : [initial as TaskRecord]
  const requests: Request[] = []
  const action = vi.fn(options.action ?? ((request: TaskBoardAction) => new Promise<TaskBoardSnapshot>(resolve => {
    requests.push({ action: request, resolve })
  })))
  const transport: TaskBoardTransport = {
    bootstrap: async () => snapshot(1, initialTasks),
    state: options.state ?? (async () => snapshot(1, initialTasks)),
    action: action as TaskBoardTransport['action'],
    subscribe: () => () => undefined,
  }
  const controller = new BoardController({
    store: new InMemoryTaskStore(),
    sessions: sessions(),
    transport,
    now: () => 1_700_000_000_000,
  })
  controller.start()
  await controller.retryHostSync()
  return { controller, requests, action }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('transition queue', () => {
  it('waits for the card action in flight and sends the last clicked target', async () => {
    const initial = task({ status: 'backlog' })
    const { controller, requests } = await makeController(initial)
    void controller.updateTask('task-a', { title: 'B' })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })

    controller.moveTask('task-a', 'clarification')
    controller.moveTask('task-a', 'ready_for_test')
    expect(controller.getSnapshot().pendingTransitions).toEqual([
      expect.objectContaining({ taskId: 'task-a', from: 'backlog', to: 'ready_for_test' }),
    ])
    // Only the update is on the wire; the two moves coalesced into one intent.
    expect(requests).toHaveLength(1)

    requests[0]!.resolve(snapshot(2, [{ ...initial, title: 'B', updatedAt: 2 }]))
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    expect(requests[1]!.action).toEqual({ kind: 'move', taskId: 'task-a', status: 'ready_for_test' })

    requests[1]!.resolve(snapshot(3, [{ ...initial, title: 'B', status: 'ready_for_test', updatedAt: 3 }]))
    await vi.waitFor(() => {
      expect(controller.getSnapshot().tasks[0]?.status).toBe('ready_for_test')
      expect(controller.getSnapshot().pendingTransitions).toBeUndefined()
    })
    controller.dispose()
  })

  it('refuses a hard-blocked move instead of queueing it', async () => {
    const initial = task({ status: 'running', executions: [openRun()] })
    const { controller, action } = await makeController(initial)
    controller.moveTask('task-a', 'ready_for_test')
    expect(action).not.toHaveBeenCalled()
    expect(controller.getSnapshot().pendingTransitions).toBeUndefined()
    expect(controller.getSnapshot().transitionErrors?.['task-a']).toMatchObject({ code: 'running' })
    controller.dispose()
  })

  it('refuses a run start while the permission binding is unconfirmed', async () => {
    const initial = task({ status: 'clarification', permission: 'danger-full-access' })
    const { controller, action } = await makeController(initial)
    controller.moveTask('task-a', 'running')
    expect(action).not.toHaveBeenCalled()
    expect(controller.getSnapshot().transitionErrors?.['task-a']).toMatchObject({ code: 'permission' })
    controller.dispose()
  })

  it('retries a transient Host failure with backoff and applies the move later', async () => {
    vi.useFakeTimers()
    const initial = task({ status: 'backlog' })
    const moved = { ...initial, status: 'clarification' as const, updatedAt: 2 }
    let attempt = 0
    const action = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw Object.assign(new Error('host unavailable'), { failure: 'unreachable' })
      return snapshot(2, [moved])
    })
    const { controller } = await makeController(initial, {
      action: action as unknown as (action: TaskBoardAction) => Promise<TaskBoardSnapshot>,
    })
    controller.moveTask('task-a', 'clarification')
    await vi.advanceTimersByTimeAsync(0)
    expect(action).toHaveBeenCalledTimes(1)
    // The outbox owns the retry once the intent leaves the pre-send queue; the
    // card is "in flight" and the host banner carries the reason.
    expect(controller.getSnapshot().pendingTaskIds).toEqual(['task-a'])
    expect(controller.getSnapshot().outbox?.error).toBe('host unavailable')

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(action).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().tasks[0]?.status).toBe('clarification')
    expect(controller.getSnapshot().pendingTaskIds).toEqual([])
    controller.dispose()
  })

  it('records a final Host rejection and drops the intent', async () => {
    const initial = task({ status: 'backlog' })
    const rejection = Object.assign(new Error('no transition'), { failure: 'rejected' })
    const { controller } = await makeController(initial, {
      action: async () => { throw rejection },
    })
    controller.moveTask('task-a', 'clarification')
    await vi.waitFor(() => {
      expect(controller.getSnapshot().transitionErrors?.['task-a']).toMatchObject({
        code: 'rejected',
        message: 'no transition',
      })
    })
    expect(controller.getSnapshot().pendingTransitions).toBeUndefined()
    controller.dispose()
  })

  it('drops an intent when a hard blocker appears while it waits', async () => {
    const initial = task({ status: 'backlog' })
    const { controller, requests } = await makeController(initial)
    void controller.updateTask('task-a', { title: 'B' })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    controller.moveTask('task-a', 'clarification')

    // The card is paused and an implementation run is open while the intent
    // waits: that is a hard blocker, not a transient one.
    requests[0]!.resolve(snapshot(2, [{
      ...initial,
      title: 'B',
      pausedAt: 2,
      executions: [openRun()],
    }]))
    await vi.waitFor(() => {
      expect(controller.getSnapshot().transitionErrors?.['task-a']).toMatchObject({ code: 'paused' })
    })
    expect(requests).toHaveLength(1)
    expect(controller.getSnapshot().pendingTransitions).toBeUndefined()
    controller.dispose()
  })

  it('drops an intent whose source column changed and says so', async () => {
    const initial = task({ status: 'backlog' })
    const { controller, requests } = await makeController(initial)
    void controller.updateTask('task-a', { title: 'B' })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    controller.moveTask('task-a', 'ready_for_test')

    // Someone else moves the card to Clarification while it waits.
    requests[0]!.resolve(snapshot(2, [{ ...initial, title: 'B', status: 'clarification', updatedAt: 2 }]))
    await vi.waitFor(() => {
      expect(controller.getSnapshot().transitionErrors?.['task-a']).toMatchObject({
        code: 'source-changed',
        from: 'backlog',
        to: 'ready_for_test',
      })
    })
    expect(requests).toHaveLength(1)
    expect(controller.getSnapshot().pendingTransitions).toBeUndefined()
    controller.dispose()
  })

  it('treats a target already reached by someone else as done, without an error', async () => {
    const initial = task({ status: 'backlog' })
    const { controller, requests } = await makeController(initial)
    void controller.updateTask('task-a', { title: 'B' })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    controller.moveTask('task-a', 'clarification')

    requests[0]!.resolve(snapshot(2, [{ ...initial, title: 'B', status: 'clarification', updatedAt: 2 }]))
    await vi.waitFor(() => {
      expect(controller.getSnapshot().pendingTransitions).toBeUndefined()
      expect(controller.getSnapshot().tasks[0]?.status).toBe('clarification')
    })
    expect(requests).toHaveLength(1)
    expect(controller.getSnapshot().transitionErrors).toBeUndefined()
    controller.dispose()
  })

  it('cancels a waiting intent without contacting the Host', async () => {
    const initial = task({ status: 'backlog' })
    const { controller, requests } = await makeController(initial)
    void controller.updateTask('task-a', { title: 'B' })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    controller.moveTask('task-a', 'clarification')
    controller.cancelTransition('task-a')
    expect(controller.getSnapshot().pendingTransitions).toBeUndefined()

    requests[0]!.resolve(snapshot(2, [{ ...initial, title: 'B', updatedAt: 2 }]))
    await vi.waitFor(() => { expect(controller.getSnapshot().pendingTaskIds).toEqual([]) })
    expect(requests).toHaveLength(1)
    controller.dispose()
  })

  it('queues a group move per card', async () => {
    const first = task({ id: 'task-a', status: 'backlog' })
    const second = task({ id: 'task-b', status: 'backlog' })
    const actions: TaskBoardAction[] = []
    const { controller } = await makeController([first, second], {
      action: async request => {
        actions.push(request)
        const id = request.kind === 'move' ? request.taskId : ''
        const moved = id === 'task-a' ? { ...first, status: 'clarification' as const } : {
          ...second, status: 'clarification' as const,
        }
        return snapshot(2, id === 'task-a' ? [moved, second] : [first, moved])
      },
    })
    await controller.moveTasks(['task-a', 'task-b'], 'clarification')
    await vi.waitFor(() => { expect(actions).toHaveLength(2) })
    expect(actions.map(request => request.kind === 'move' ? [request.taskId, request.status] : [])).toEqual([
      ['task-a', 'clarification'],
      ['task-b', 'clarification'],
    ])
    controller.dispose()
  })
})
