/**
 * The reported scenario, at the Host: three sessions running while the machine
 * is already overloaded. "Pause all" must still reach every run and answer the
 * browser — the bulk action is not behind the launch gate, it does not depend
 * on the browser's snapshot, and it stops each conversation.
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
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-overload-'))
  roots.push(value)
  return value
}

type GatewayRequest = { namespace: string; method: string; args: Record<string, unknown> }

async function flush(): Promise<void> {
  for (let index = 0; index < 15; index += 1) await Promise.resolve()
}

describe('three parallel sessions under overload', () => {
  it('pauses all three runs and answers the action while the machine is overloaded', async () => {
    let clock = 40_000
    const pressure = new PressureMonitor({ now: () => clock, load1: () => 16, cores: () => 4 })
    pressure.sample(0)
    clock = 20_000
    pressure.sample(0)
    clock = 40_000
    pressure.sample(0)
    expect(pressure.isOverloaded()).toBe(true)

    const ledger = new HostTaskLedger(root())
    const now = 1_000
    const sessions = ['session-a', 'session-b', 'session-c']
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      ledger.applyRequest(`create-${id}`, { kind: 'create', id, input: { title: id.toUpperCase(), description: '', prompt: 'work' } })
      const opened = ledger.openScheduled(id, undefined, now)!
      ledger.attachSession(id, opened.execution.id, sessions[index]!)
    }
    const cancel = vi.fn(async (_request: GatewayRequest) => ({}))
    const gateway = {
      invoke: vi.fn(async (request: GatewayRequest) => {
        if (request.namespace === 'session' && request.method === 'cancel') return cancel(request)
        throw new Error(`unexpected gateway call ${request.namespace}/${request.method}`)
      }),
      stream: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    } as unknown as TypertGateway
    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      pressure,
      eventLoopP95: () => 0,
    })

    // Read the results the way a connected tab does: from the frames the Host
    // pushes (a later frame may replace the pending one, which is exactly why
    // the browser resolves its outbox from the frame it receives, not from a
    // snapshot read after the fact).
    const results: unknown[] = []
    service.subscribe(() => {
      results.push(...(service.eventPayload().actionResults ?? []))
    })
    service.acceptAction('pause-all-1', { kind: 'pause-all' })
    await flush()

    expect(results).toEqual([{ requestId: 'pause-all-1', ok: true, at: expect.any(Number) }])
    expect(ledger.state().tasks.every(task => task.pausedAt !== undefined)).toBe(true)
    // Each conversation is stopped, not just marked paused in the ledger.
    expect(cancel.mock.calls.map(call => (call[0] as GatewayRequest).args)).toEqual([
      { request: { sessionId: 'session-a' } },
      { request: { sessionId: 'session-b' } },
      { request: { sessionId: 'session-c' } },
    ])
    // The pressure verdict rides the snapshot, so the board can explain itself
    // while the machine stays loaded.
    expect(service.snapshot().pressure?.level).toBe('overloaded')
    expect(service.health()).toMatchObject({
      active: true,
      pressure: { level: 'overloaded' },
      // Paused runs release their lane: `open` counts the runs the Host still
      // works on, while `paused` reports the suspended cards.
      runs: { open: 0, paused: 3 },
    })
    service.dispose()
  })
})
