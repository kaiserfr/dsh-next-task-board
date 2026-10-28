/**
 * Launch gate under machine pressure: on a sustained overload the Host holds
 * new runs back instead of adding another agent turn to a saturated machine —
 * and says so on the card, so the queue is visible rather than looking stuck.
 * When the load drops, the very next pump starts the queued run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { PressureMonitor } from '../src/core/pressure.ts'

const roots: string[] = []
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-pressure-'))
  roots.push(value)
  return value
}

type GatewayRequest = { namespace: string; method: string; args: Record<string, unknown> }

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

describe('launch gate', () => {
  it('holds a queued run while the machine is overloaded, marks it, and starts it after the load drops', async () => {
    let load = 40
    let clock = 25_000
    const pressure = new PressureMonitor({ now: () => clock, load1: () => load, cores: () => 3 })
    const create = vi.fn(async (_request: GatewayRequest) => ({ sessionId: 'session-held' }))
    const prompt = vi.fn(async (_request: GatewayRequest) => ({ accepted: true }))
    const gateway = {
      invoke: vi.fn(async (request: GatewayRequest) => {
        if (request.namespace !== 'session') throw new Error(`unexpected namespace ${request.namespace}`)
        if (request.method === 'create') return create(request)
        if (request.method === 'rename') return { title: 'Held', seq: 1 }
        if (request.method === 'prompt') return prompt(request)
        throw new Error(`unexpected gateway call ${request.method}`)
      }),
      stream: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    } as unknown as TypertGateway
    const ledger = new HostTaskLedger(root())
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      pressure,
      eventLoopP95: () => 0,
    })
    // Three samples of 40 load on 3 cores: a sustained overload.
    pressure.sample(0)
    clock = 15_000
    pressure.sample(0)
    clock = 25_000
    pressure.sample(0)
    expect(pressure.isOverloaded()).toBe(true)

    ledger.applyRequest('create-1', { kind: 'create', id: 'held', input: { title: 'Held', description: '', prompt: 'work' } })
    // backlog → clarification opens a run; the gate holds it before a session.
    service.acceptAction('go', { kind: 'move', taskId: 'held', status: 'clarification' })
    await flush()
    expect(create).not.toHaveBeenCalled()
    expect(service.eventPayload().queued).toEqual({ held: { reason: 'pressure', since: expect.any(Number) } })

    // The load drops: the next pump (any ledger change triggers it) starts it.
    load = 0.2
    clock = 40_000
    pressure.sample(0)
    clock = 55_000
    pressure.sample(0)
    expect(pressure.isOverloaded()).toBe(false)
    service.acceptAction('nudge', { kind: 'resume-all' })
    await flush()
    await flush()
    expect(create).toHaveBeenCalledOnce()
    expect(service.eventPayload().queued).toEqual({})
    service.dispose()
  })
})
