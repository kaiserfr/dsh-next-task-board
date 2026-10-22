/**
 * The outbox: UI actions are accepted immediately, queued per card and handed
 * to the Host in the background. These tests pin the three promises the board
 * makes to the user (no blocking, no timeout, no silent refusal) plus the two
 * safety properties that make the retry safe (idempotent request ids, no
 * optimistic state).
 */
import { describe, expect, it, vi } from 'vitest'
import { BoardController, type SessionsControllerFace, type TaskBoardTransport } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { HostApiError } from '../src/client/host-api.ts'
import type { TaskBoardAction, TaskBoardSnapshot } from '../src/protocol.ts'

const NOW = 1_700_000_000_000

function snapshot(revision: number, tasks: readonly TaskRecord[] = []): TaskBoardSnapshot {
  return {
    schemaVersion: 3,
    revision,
    tasks: [...tasks],
    scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' },
    power: {
      platform: 'linux', phase: 'unsupported', enabled: false,
      runningSessions: 0, armedSchedules: 0, sessionStateKnown: true,
    },
  }
}

function sessions(): SessionsControllerFace {
  return {
    list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => undefined },
    open: vi.fn(),
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function makeController(action: TaskBoardTransport['action'], initial: TaskRecord, tasks: readonly TaskRecord[] = [initial]): BoardController {
  const transport: TaskBoardTransport = {
    bootstrap: async () => snapshot(1, tasks),
    state: async () => snapshot(1, tasks),
    action,
    subscribe: () => () => undefined,
  }
  const controller = new BoardController({
    store: new InMemoryTaskStore(), sessions: sessions(), transport, now: () => NOW,
    uuid: (() => { let index = 0; return () => `request-${++index}` })(),
  })
  controller.start()
  return controller
}

describe('controller outbox', () => {
  it('accepts a second action while the first is in flight and keeps the state unconfirmed', async () => {
    const initial = createTask({ title: 'A', description: '', prompt: '' }, NOW, 'task-a')
    const first = deferred<TaskBoardSnapshot>()
    const second = deferred<TaskBoardSnapshot>()
    const calls: Array<{ action: TaskBoardAction; requestId: string | undefined }> = []
    const action = vi.fn(async (value: TaskBoardAction, _initiator?: string, requestId?: string) => {
      calls.push({ action: value, requestId })
      return await (calls.length === 1 ? first.promise : second.promise)
    })
    const controller = makeController(action, initial)
    await controller.retryHostSync()

    // Both actions are accepted at once; the card does not jump on its own.
    controller.moveTask('task-a', 'clarification')
    controller.moveTask('task-a', 'running')
    expect(controller.getSnapshot().tasks[0]!.status).toBe('backlog')
    expect(controller.getSnapshot().pendingTaskIds).toEqual(['task-a'])
    await vi.waitFor(() => { expect(action).toHaveBeenCalledTimes(1) })

    // The card's queue sends the second action only after the first settles.
    first.resolve(snapshot(2, [{ ...initial, status: 'clarification', updatedAt: NOW + 1 }]))
    await vi.waitFor(() => { expect(action).toHaveBeenCalledTimes(2) })
    second.resolve(snapshot(3, [{ ...initial, status: 'running', updatedAt: NOW + 2 }]))
    await controller.whenIdle()
    expect(controller.getSnapshot().tasks[0]!.status).toBe('running')
    expect(controller.getSnapshot().pendingTaskIds).toEqual([])
    controller.dispose()
  })

  it('does not hold another card behind a blocked send', async () => {
    const a = createTask({ title: 'A', description: '', prompt: '' }, NOW, 'task-a')
    const b = createTask({ title: 'B', description: '', prompt: '' }, NOW, 'task-b')
    const gate = deferred<TaskBoardSnapshot>()
    const sent: string[] = []
    const action = vi.fn(async (value: TaskBoardAction, _initiator?: string, requestId?: string) => {
      sent.push(requestId ?? '?')
      const taskId = 'taskId' in value ? value.taskId : ''
      if (taskId === 'task-a') return await gate.promise
      return snapshot(2, [a, { ...b, status: 'clarification', updatedAt: NOW + 1 }])
    })
    const controller = makeController(action, a, [a, b])
    await controller.retryHostSync()
    controller.moveTask('task-a', 'clarification')
    controller.moveTask('task-b', 'clarification')
    await vi.waitFor(() => { expect(action).toHaveBeenCalledTimes(2) })
    expect(controller.getSnapshot().tasks.find(task => task.id === 'task-b')?.status).toBe('clarification')
    gate.resolve(snapshot(2, [a, b]))
    await controller.whenIdle()
    controller.dispose()
  })

  it('retries a lost connection with the same requestId instead of duplicating the action', async () => {
    vi.useFakeTimers()
    try {
      const initial = createTask({ title: 'A', description: '', prompt: '' }, NOW, 'task-a')
      const calls: string[] = []
      const action = vi.fn(async (_value: TaskBoardAction, _initiator?: string, requestId?: string) => {
        calls.push(requestId ?? '?')
        if (calls.length === 1) throw new HostApiError('unreachable', 'connection reset')
        return snapshot(2, [{ ...initial, status: 'clarification', updatedAt: NOW + 1 }])
      })
      const controller = makeController(action, initial)
      await controller.retryHostSync()
      controller.moveTask('task-a', 'clarification')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(1)
      expect(controller.getSnapshot().outbox?.error).toBe('connection reset')
      // The card is still in its old column: the user was never shown a false state.
      expect(controller.getSnapshot().tasks[0]!.status).toBe('backlog')

      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toBe(calls[0])
      await controller.whenIdle()
      expect(controller.getSnapshot().tasks[0]!.status).toBe('clarification')
      expect(controller.getSnapshot().outbox?.error).toBeUndefined()
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the card FIFO while its head waits for a retry", async () => {
    vi.useFakeTimers()
    try {
      const initial = createTask({ title: 'A', description: '', prompt: '' }, NOW, 'task-a')
      const calls: Array<{ action: TaskBoardAction; requestId: string | undefined }> = []
      const action = vi.fn(async (value: TaskBoardAction, _initiator?: string, requestId?: string) => {
        calls.push({ action: value, requestId })
        if (calls.length === 1) throw new HostApiError('unreachable', 'connection reset')
        if (calls.length === 2) return snapshot(2, [{ ...initial, status: 'clarification', updatedAt: NOW + 1 }])
        return snapshot(3, [{ ...initial, status: 'running', updatedAt: NOW + 2 }])
      })
      const controller = makeController(action, initial)
      await controller.retryHostSync()
      controller.moveTask('task-a', 'clarification')
      controller.moveTask('task-a', 'running')
      await vi.advanceTimersByTimeAsync(0)
      // The second action must not overtake the waiting first one.
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      await controller.whenIdle()
      expect(calls).toHaveLength(3)
      expect(calls[0]!.action).toMatchObject({ kind: 'move', status: 'clarification' })
      expect(calls[1]!.action).toMatchObject({ kind: 'move', status: 'clarification' })
      expect(calls[1]!.requestId).toBe(calls[0]!.requestId)
      expect(calls[2]!.action).toMatchObject({ kind: 'move', status: 'running' })
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discarding a blocked action lets the next action of the card proceed', async () => {
    vi.useFakeTimers()
    try {
      const initial = createTask({ title: 'A', description: '', prompt: '' }, NOW, 'task-a')
      const calls: TaskBoardAction[] = []
      const action = vi.fn(async (value: TaskBoardAction) => {
        calls.push(value)
        if (calls.length === 1) throw new HostApiError('unreachable', 'connection reset')
        return snapshot(2, [{ ...initial, status: 'running', updatedAt: NOW + 1 }])
      })
      const controller = makeController(action, initial)
      await controller.retryHostSync()
      controller.moveTask('task-a', 'clarification')
      controller.moveTask('task-a', 'running')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(1)
      controller.discardOutbox()
      await controller.whenIdle()
      expect(calls).toHaveLength(2)
      expect(calls[1]).toMatchObject({ kind: 'move', status: 'running' })
      expect(controller.getSnapshot().tasks[0]!.status).toBe('running')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a definitive refusal as a notice and never retries it', async () => {
    const initial = createTask({ title: 'A', description: '', prompt: '' }, NOW, 'task-a')
    const action = vi.fn(async () => {
      throw new HostApiError('rejected', 'invalid state transition: backlog → done')
    })
    const controller = makeController(action, initial)
    await controller.retryHostSync()
    controller.moveTask('task-a', 'done')
    await controller.whenIdle()
    expect(action).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().tasks[0]!.status).toBe('backlog')
    expect(controller.getSnapshot().outbox?.pending).toBe(0)
    expect(controller.getSnapshot().notices?.some(notice => notice.message.includes('invalid state transition'))).toBe(true)
    controller.dispose()
  })
})
