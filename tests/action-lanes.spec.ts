/**
 * Host action lanes. The incident's second half was structural: every action
 * ran through one global promise chain, so a single slow session stop delayed
 * every later action — including "Pause all". These tests pin the replacement:
 * card actions stay ordered per card, bulk actions have their own lane, and a
 * stuck action is reported (and its lane freed) after the Host timeout.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import type { TaskBoardActionResult } from '../src/protocol.ts'

const roots: string[] = []
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
  vi.useRealTimers()
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-lanes-'))
  roots.push(value)
  return value
}

function makeService(): TaskBoardHostService {
  const gateway = {
    invoke: vi.fn(async () => { throw new Error('no gateway call expected') }),
    stream: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
  } as unknown as TypertGateway
  return new TaskBoardHostService(gateway, {
    ledger: new HostTaskLedger(root()),
    power: new PowerInhibitor({ platform: 'linux' }),
  })
}

/** Let the lane promises run without timers. */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

function results(service: TaskBoardHostService): TaskBoardActionResult[] {
  return service.eventPayload().actionResults ?? []
}

describe('Host action lanes', () => {
  it('does not let one card\'s stuck action delay another card', async () => {
    const service = makeService()
    const releaseA: Array<() => void> = []
    type Apply = (requestId: string, action: { kind: string; taskId?: string }) => Promise<unknown>
    vi.spyOn(service as unknown as { apply: Apply }, 'apply').mockImplementation(async (_requestId, action) => {
      if (action.kind === 'stop-session' && action.taskId === 'a') {
        await new Promise<void>(resolve => { releaseA.push(resolve) })
      }
      return {}
    })
    service.acceptAction('a1', { kind: 'stop-session', taskId: 'a' })
    service.acceptAction('b1', { kind: 'stop-session', taskId: 'b' })
    await flush()
    expect(results(service).map(result => [result.requestId, result.ok])).toEqual([['b1', true]])
    releaseA[0]?.()
    await flush()
    expect(results(service).map(result => [result.requestId, result.ok])).toEqual([['a1', true]])
    service.dispose()
  })

  it('runs a bulk action on its own lane while a card action hangs', async () => {
    const service = makeService()
    vi.spyOn(service as unknown as { apply: (requestId: string, action: { kind: string }) => Promise<unknown> }, 'apply')
      .mockImplementation(async (_requestId, action) => {
        if (action.kind === 'stop-session') await new Promise(() => {})
        return {}
      })
    service.acceptAction('a1', { kind: 'stop-session', taskId: 'a' })
    service.acceptAction('all1', { kind: 'pause-all' })
    await flush()
    // The bulk pause answers although the card action never settles — the
    // exact interaction that used to leave "Pause all" without a result.
    expect(results(service).map(result => [result.requestId, result.ok])).toEqual([['all1', true]])
    service.dispose()
  })

  it('reports a stuck action after the Host timeout and frees its lane', async () => {
    vi.useFakeTimers()
    const service = makeService()
    let hang = true
    vi.spyOn(service as unknown as { apply: (requestId: string, action: { kind: string }) => Promise<unknown> }, 'apply')
      .mockImplementation(async () => {
        if (hang) await new Promise(() => {})
        return {}
      })
    service.acceptAction('a1', { kind: 'stop-session', taskId: 'a' })
    await flush()
    await vi.advanceTimersByTimeAsync(25_000)
    await flush()
    const timedOut = results(service)
    expect(timedOut).toHaveLength(1)
    expect(timedOut[0]).toMatchObject({ requestId: 'a1', ok: false })
    expect(timedOut[0]!.error).toContain('action-timeout')

    // The lane is free again: a later action of the same card is applied.
    hang = false
    service.acceptAction('a2', { kind: 'stop-session', taskId: 'a' })
    await flush()
    expect(results(service).map(result => [result.requestId, result.ok])).toEqual([['a2', true]])
    service.dispose()
  })
})
