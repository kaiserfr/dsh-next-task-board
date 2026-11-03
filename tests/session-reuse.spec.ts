import { describe, expect, it } from 'vitest'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'
import { reusableSessionId } from '../src/core/session-reuse.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'Scheduled', description: '', prompt: 'run' }, 1, 'task-a'),
    ...overrides,
  }
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    sessionId: 'session-a',
    startedAt: 10,
    endedAt: 20,
    result: 'succeeded',
    error: undefined,
    ...overrides,
  }
}

describe('reusableSessionId (#1419)', () => {
  it('continues in the settled session when the task opted in', () => {
    expect(reusableSessionId(task({ reuseSession: true, executions: [execution()] }))).toBe('session-a')
  })

  it('mints a fresh session when the task did not opt in and has no clarification conversation', () => {
    expect(reusableSessionId(task({ executions: [execution()] }))).toBeUndefined()
    expect(reusableSessionId(task({ reuseSession: false, executions: [execution()] }))).toBeUndefined()
  })

  it('reuses the newest settled session while the current run is still open (#1587)', () => {
    // The launch path calls this AFTER startExecution appended this run's own
    // open record, so the array tail is always an unsettled row at that point.
    const launching = task({
      reuseSession: true,
      executions: [
        execution({ id: 'exec-1', sessionId: 'session-done', endedAt: 20 }),
        execution({ id: 'exec-2', sessionId: undefined, startedAt: 30, endedAt: undefined, result: undefined }),
      ],
    })
    expect(reusableSessionId(launching)).toBe('session-done')
  })

  it('skips unsettled and session-less rows when looking back for the newest settled session', () => {
    const skipped = task({
      reuseSession: true,
      executions: [
        execution({ id: 'exec-1', sessionId: undefined, endedAt: 20 }),
        execution({ id: 'exec-2', sessionId: 'session-done', endedAt: 40 }),
        execution({ id: 'exec-3', sessionId: 'session-open', startedAt: 50, endedAt: undefined, result: undefined }),
      ],
    })
    expect(reusableSessionId(skipped)).toBe('session-done')
  })

  it('mints a fresh session when no settled conversation is on record', () => {
    const open = task({ reuseSession: true, executions: [execution({ endedAt: undefined, result: undefined })] })
    expect(reusableSessionId(open)).toBeUndefined()
    const noSession = task({ reuseSession: true, executions: [execution({ sessionId: undefined })] })
    expect(reusableSessionId(noSession)).toBeUndefined()
    expect(reusableSessionId(task({ reuseSession: true }))).toBeUndefined()
  })

  it('follows the newest execution after a reuse chain', () => {
    const chained = task({
      reuseSession: true,
      executions: [execution({ id: 'exec-1' }), execution({ id: 'exec-2', sessionId: 'session-b', startedAt: 30, endedAt: 40 })],
    })
    expect(reusableSessionId(chained)).toBe('session-b')
  })

  describe('rework rounds force the continuation', () => {
    it('continues the correction conversation even without the reuse opt-in', () => {
      const card = task({ executions: [execution()] })
      expect(reusableSessionId(card)).toBeUndefined()
      expect(reusableSessionId(card, { rework: true })).toBe('session-a')
    })

    it('needs a settled session to continue: a card that never ran starts fresh', () => {
      expect(reusableSessionId(task({ reuseSession: true }), { rework: true })).toBeUndefined()
      const open = task({ executions: [execution({ endedAt: undefined, result: undefined })] })
      expect(reusableSessionId(open, { rework: true })).toBeUndefined()
    })
  })

  /**
   * The reported duplicate sessions: the decision must not depend on a roster
   * snapshot. A conversation that ended a moment ago is still listed as running
   * by the last roster read, and the automatic test run opens *inside* the
   * settle of the implementation run — i.e. before any poll could see it at
   * rest. Gating on that snapshot minted a second session per card and paid the
   * full prompt again.
   */
  describe('the card conversation does not wait for a roster snapshot', () => {
    it('continues the clarification conversation right after its round settled', () => {
      const goAhead = task({
        status: 'running',
        clarificationSessionId: 'session-clarify',
        executions: [
          execution({ id: 'clarify-1', sessionId: 'session-clarify', endedAt: 20 }),
          execution({ id: 'run-1', sessionId: undefined, startedAt: 21, endedAt: undefined, result: undefined }),
        ],
      })
      expect(reusableSessionId(goAhead)).toBe('session-clarify')
    })

    it('continues the implementation conversation in the automatic test run', () => {
      const testRun = task({
        status: 'testing',
        reuseSession: false,
        executions: [
          execution({ id: 'run-1', sessionId: 'session-impl', endedAt: 20 }),
          execution({ id: 'test-1', sessionId: undefined, startedAt: 20, endedAt: undefined, result: undefined }),
        ],
      })
      expect(reusableSessionId(testRun, { test: true })).toBe('session-impl')
    })
  })
})
