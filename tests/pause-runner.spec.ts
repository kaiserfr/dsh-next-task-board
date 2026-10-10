/**
 * Pause/resume on the Host side: pausing stops the run's session (the card
 * keeps its column and its open execution), resuming writes the "continue"
 * turn into that same conversation, and a run that never got a session simply
 * never starts while it is paused.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { HostExecutionRunner, promptText } from '../src/host-runner.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []

type GatewayRequest = { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-pause-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function makeGateway(handler: (request: GatewayRequest) => unknown | Promise<unknown>) {
  const invoke = vi.fn(async (request: GatewayRequest) => handler(request))
  const gateway = { invoke } as unknown as TypertGateway
  return { gateway, invoke }
}

function card(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Card', description: '', prompt: 'work' }, 0, 'card'), ...overrides }
}

function wireRequestOf(invoke: ReturnType<typeof vi.fn>, call: number): { sessionId: string; content?: Array<{ text: string }> } {
  return (invoke.mock.calls[call]?.[0] as unknown as { args: { request: { sessionId: string; content?: Array<{ text: string }> } } }).args.request
}

describe('promptText resume turn', () => {
  it('writes the continue turn instead of the card body', () => {
    const text = promptText(card(), { continued: true, resume: true })
    expect(text).toContain('Weitermachen')
    expect(text).not.toContain('work')
  })

  it('takes precedence over a rework round', () => {
    expect(promptText(card({ reworkAt: 1, reworkCount: 1 }), { continued: true, resume: true, rework: true }))
      .not.toContain('返工要求')
  })
})

describe('HostExecutionRunner.cancel', () => {
  it('stops the session through the live session control endpoint', async () => {
    const { gateway, invoke } = makeGateway(() => ({ accepted: true }))
    const runner = new HostExecutionRunner(gateway)
    await runner.cancel('session-a')
    expect(invoke).toHaveBeenCalledOnce()
    const call = invoke.mock.calls[0][0] as unknown as { namespace: string; method: string }
    expect(call.namespace).toBe('session')
    expect(call.method).toBe('cancel')
    expect(wireRequestOf(invoke, 0).sessionId).toBe('session-a')
  })
})

describe('TaskBoardHostService pause/resume', () => {
  function serviceWith(ledger: HostTaskLedger, handler: (request: GatewayRequest) => unknown, now = 0) {
    const { gateway, invoke } = makeGateway(handler)
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
    })
    return { service, invoke }
  }

  async function flush(): Promise<void> {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }

  /** A running card whose open execution holds `session-a`. */
  function runningLedger(): HostTaskLedger {
    const ledger = new HostTaskLedger(root(), () => 0)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    const opened = ledger.applyRequest('run', { kind: 'run', taskId: 'card' }).run
    ledger.attachSession('card', opened!.execution.id, 'session-a')
    return ledger
  }

  it('stops the session of a paused card and leaves it in progress', async () => {
    const ledger = runningLedger()
    const { service, invoke } = serviceWith(ledger, request => request.method === 'cancel' ? { accepted: true } : { accepted: true })

    service.apply('pause', { kind: 'pause', taskIds: ['card'] })
    await flush()

    expect(invoke).toHaveBeenCalledOnce()
    expect((invoke.mock.calls[0][0] as unknown as { method: string }).method).toBe('cancel')
    expect(wireRequestOf(invoke, 0).sessionId).toBe('session-a')
    const task = ledger.state().tasks[0]
    expect(task.status).toBe('running')
    expect(task.pausedAt).toBe(0)
    service.dispose()
  })

  it('continues the paused conversation with the continue turn', async () => {
    const ledger = runningLedger()
    const { service, invoke } = serviceWith(ledger, () => ({ accepted: true }))
    service.apply('pause', { kind: 'pause', taskIds: ['card'] })
    await flush()

    service.apply('resume', { kind: 'resume', taskIds: ['card'] })
    await flush()

    const methods = invoke.mock.calls.map(call => (call[0] as unknown as { method: string }).method)
    expect(methods).toEqual(['cancel', 'prompt'])
    const prompt = wireRequestOf(invoke, 1)
    expect(prompt.sessionId).toBe('session-a')
    expect(prompt.content?.[0].text).toContain('Weitermachen')
    const task = ledger.state().tasks[0]
    expect(task.pausedAt).toBeUndefined()
    expect(task.status).toBe('running')
    expect(task.executions[0].sessionId).toBe('session-a')
    service.dispose()
  })

  it('undoes the pause when the session cannot be stopped', async () => {
    const ledger = runningLedger()
    const { service } = serviceWith(ledger, () => { throw new Error('session "session-a" not found (not attached)') })

    service.apply('pause', { kind: 'pause', taskIds: ['card'] })
    await flush()

    expect(ledger.isPaused('card')).toBe(false)
    expect(ledger.runtimeView().openExecutions).toHaveLength(1)
    service.dispose()
  })

  it('never starts a run that was paused while it waited in the queue', async () => {
    const ledger = new HostTaskLedger(root(), () => 0)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    const opened = ledger.applyRequest('run', { kind: 'run', taskId: 'card' }).run
    const { service, invoke } = serviceWith(ledger, () => ({ accepted: true }))
    service.apply('pause', { kind: 'pause', taskIds: ['card'] })
    await flush()

    // The queue entry of a paused run is dropped by the pump; the launch guard
    // is the second line of defence.
    await (service as unknown as { launch(run: unknown): Promise<void> }).launch(opened)
    expect(invoke).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0].executions[0].sessionId).toBeUndefined()
    service.dispose()
  })
})
