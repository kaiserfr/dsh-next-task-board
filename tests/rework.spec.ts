/**
 * Rework without a board-side note: sending a card back from `ready_for_test`
 * (or `failed`) to `todo` stamps it, and the correction itself is the human's
 * own turn in the card's conversation — the next run continues that chat and
 * opens with the rework framing instead of repeating the card body.
 */
import { describe, expect, it } from 'vitest'
import { createTask, isReworkReturn, pendingRework, startExecution, withReworkStamp, type TaskRecord } from '../src/core/tasks.ts'
import { parseLedger } from '../src/core/store.ts'
import { promptText } from '../src/host-runner.ts'
import { parseActionEnvelope } from '../src/protocol.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'Fix the login', description: 'd', prompt: 'Implement the login redirect' }, 1, 'task-a'),
    ...overrides,
  }
}

describe('rework return', () => {
  it('is exactly the way back from the review and failure columns', () => {
    expect(isReworkReturn('ready_for_test', 'todo')).toBe(true)
    expect(isReworkReturn('failed', 'todo')).toBe(true)
    // Accepting the work, or moving on from any other column, is no rework.
    expect(isReworkReturn('ready_for_test', 'done')).toBe(false)
    expect(isReworkReturn('todo', 'todo')).toBe(false)
    expect(isReworkReturn('done', 'todo')).toBe(false)
  })

  it('stamps when it happened and counts the rounds', () => {
    const once = withReworkStamp(task(), 100)
    expect(once.reworkAt).toBe(100)
    expect(once.reworkCount).toBe(1)
    const twice = withReworkStamp(once, 200)
    expect(twice.reworkAt).toBe(200)
    expect(twice.reworkCount).toBe(2)
  })
})

describe('pendingRework', () => {
  it('stays pending until a run opens after the send-back', () => {
    const sentBack = task({ reworkAt: 50, reworkCount: 1 })
    expect(pendingRework(sentBack)).toBe(true)
    const ran = startExecution(sentBack, 60, 'exec-1')
    expect(ran.execution.rework).toBe(true)
    expect(pendingRework(ran.task)).toBe(false)
  })

  it('does not let a clarification round eat the marker', () => {
    const sentBack = task({ reworkAt: 50, reworkCount: 1 })
    const clarified = startExecution(sentBack, 60, 'exec-1', undefined, 'clarify')
    expect(clarified.execution.rework).toBeUndefined()
    expect(pendingRework(clarified.task)).toBe(true)
  })

  it('is not pending on a card that was never sent back', () => {
    expect(pendingRework(task())).toBe(false)
    expect(startExecution(task(), 60, 'exec-1').execution.rework).toBeUndefined()
  })
})

describe('promptText of a rework round', () => {
  it('frames the continued conversation instead of repeating the card body', () => {
    const text = promptText(task({ reworkAt: 50, reworkCount: 1 }), { continued: true, rework: true })
    // The session already holds the original instruction, the work and the
    // human's own correction: repeating the ask would misrepresent it.
    expect(text).not.toContain('Implement the login redirect')
    expect(text).toContain('返工要求')
  })

  it('keeps the card body when the run cannot continue the conversation', () => {
    const text = promptText(task({ reworkAt: 50, reworkCount: 1 }), { rework: true })
    expect(text).toContain('Implement the login redirect')
    expect(text).not.toContain('返工要求')
  })

  it('keeps the historical prompt body for a plain continued run', () => {
    const plain = task()
    for (const text of [promptText(plain, { continued: true }), promptText(plain)]) {
      expect(text.startsWith('Implement the login redirect')).toBe(true)
      expect(text).not.toContain('返工要求')
    }
  })
})

describe('the wire gate no longer carries a rework action', () => {
  it('refuses the removed action', () => {
    // The board writes the send-back as an ordinary, machine-validated move.
    expect(parseActionEnvelope({ requestId: 'rework-a', action: { kind: 'rework', taskId: 'task-a', note: 'fix it' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'move-a', action: { kind: 'move', taskId: 'task-a', status: 'todo' } })?.action)
      .toEqual({ kind: 'move', taskId: 'task-a', status: 'todo' })
  })
})

describe('rework persistence', () => {
  it('round-trips the stamp through the ledger parser', () => {
    const stored = task({ reworkAt: 120, reworkCount: 3, status: 'todo' })
    const [parsed] = parseLedger(JSON.stringify([stored]))
    expect(parsed?.reworkAt).toBe(120)
    expect(parsed?.reworkCount).toBe(3)
  })

  it('repairs a torn or malformed stamp instead of dropping the card', () => {
    const torn = { ...task(), reworkCount: 2 }
    const malformed = { ...task(), reworkAt: 'yesterday', reworkCount: -1 }
    const parsed = parseLedger(JSON.stringify([torn, malformed]))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.reworkAt).toBeUndefined()
    expect(parsed[0]?.reworkCount).toBeUndefined()
    expect(parsed[1]?.reworkAt).toBeUndefined()
    expect(parsed[1]?.reworkCount).toBeUndefined()
  })

  it('carries the round mark on the execution record through a reload', () => {
    const opened = startExecution(task({ reworkAt: 50, reworkCount: 1 }), 60, 'exec-1')
    const [parsed] = parseLedger(JSON.stringify([opened.task]))
    expect(parsed?.executions[0]?.rework).toBe(true)
  })
})
