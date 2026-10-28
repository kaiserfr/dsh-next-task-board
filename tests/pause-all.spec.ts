/**
 * Bulk pause/resume: the Host derives the list from its own ledger.
 *
 * The reported failure was a board whose event stream had stalled: the browser
 * sent the (stale, empty) list of running cards, the Host applied an empty
 * pause and answered "ok" — the button did nothing. These tests pin the
 * contract that made that impossible: `pause-all` suspends every open run
 * (clarification included) and `resume-all` releases every paused card.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'

const roots: string[] = []
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-pause-all-'))
  roots.push(value)
  return value
}

function create(ledger: HostTaskLedger, id: string, title: string): void {
  ledger.applyRequest(`create-${id}`, {
    kind: 'create',
    id,
    input: { title, description: '', prompt: 'work' },
  })
}

describe('pause-all / resume-all', () => {
  it('pauses every open run, derivation included in the Host', () => {
    const now = 1_000
    const ledger = new HostTaskLedger(root(), () => now)
    create(ledger, 'a', 'A')
    create(ledger, 'b', 'B')
    const a = ledger.openScheduled('a', undefined, now)!
    const b = ledger.openScheduled('b', undefined, now)!
    ledger.attachSession('a', a.execution.id, 'session-a')
    ledger.attachSession('b', b.execution.id, 'session-b')

    const result = ledger.applyRequest('pause-all-1', { kind: 'pause-all' })
    expect(result.paused?.map(entry => [entry.taskId, entry.sessionId])).toEqual([
      ['a', 'session-a'],
      ['b', 'session-b'],
    ])
    const tasks = ledger.state().tasks
    expect(tasks.every(task => task.pausedAt !== undefined)).toBe(true)

    // Idempotent: a second click is a no-op, not an error.
    const again = ledger.applyRequest('pause-all-2', { kind: 'pause-all' })
    expect(again.paused).toBeUndefined()
  })

  it('resumes every paused card and hands the runs back to the service', () => {
    const now = 2_000
    const ledger = new HostTaskLedger(root(), () => now)
    create(ledger, 'a', 'A')
    create(ledger, 'b', 'B')
    const a = ledger.openScheduled('a', undefined, now)!
    const b = ledger.openScheduled('b', undefined, now)!
    ledger.attachSession('a', a.execution.id, 'session-a')
    ledger.attachSession('b', b.execution.id, 'session-b')
    ledger.applyRequest('pause-1', { kind: 'pause-all' })

    const result = ledger.applyRequest('resume-all-1', { kind: 'resume-all' })
    expect(result.resumed?.map(entry => [entry.task.id, entry.execution.sessionId])).toEqual([
      ['a', 'session-a'],
      ['b', 'session-b'],
    ])
    expect(ledger.state().tasks.every(task => task.pausedAt === undefined)).toBe(true)
  })

  it('leaves cards without an open run alone', () => {
    const now = 3_000
    const ledger = new HostTaskLedger(root(), () => now)
    create(ledger, 'idle', 'Idle')
    const result = ledger.applyRequest('pause-all-empty', { kind: 'pause-all' })
    expect(result.paused).toBeUndefined()
    expect(ledger.state().tasks[0]!.pausedAt).toBeUndefined()
  })

  it('pauses a clarification run like any other run', () => {
    const now = 4_000
    const ledger = new HostTaskLedger(root(), () => now)
    create(ledger, 'c', 'Clarify')
    // backlog → clarification is the declared transition and opens the clarify run.
    const result = ledger.applyRequest('move-clarify', { kind: 'move', taskId: 'c', status: 'clarification' })
    expect(result.clarification?.execution.kind).toBe('clarify')
    ledger.attachSession('c', result.clarification!.execution.id, 'session-c')

    const paused = ledger.applyRequest('pause-all-clarify', { kind: 'pause-all' })
    expect(paused.paused?.map(entry => entry.sessionId)).toEqual(['session-c'])
  })
})
