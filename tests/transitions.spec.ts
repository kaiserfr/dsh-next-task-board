/**
 * Transition readiness: the single judgement the detail buttons, the card
 * badges and the controller queue share. No Host involved.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_STATE_MACHINE, StateMachine } from '../src/core/state-machine.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'
import { transitionBlockerOf, transitionStartsExecution } from '../src/core/transitions.ts'

const machine = new StateMachine(DEFAULT_STATE_MACHINE)

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'A', description: '', prompt: 'work' }, 0, 'task-a'), ...overrides }
}

const openRun = (kind?: 'clarify'): ExecutionRecord => ({
  id: 'e1', kind, sessionId: undefined, startedAt: 1, endedAt: undefined, result: undefined, error: undefined,
})

describe('transitionBlockerOf', () => {
  it('reports archived, running and paused cards as hard blockers', () => {
    expect(transitionBlockerOf(task({ archivedAt: 5, status: 'clarification' }), machine, 'running')).toBe('archived')
    expect(transitionBlockerOf(task({ status: 'running' }), machine, 'ready_for_test')).toBe('running')
    expect(transitionBlockerOf(task({
      status: 'clarification',
      executions: [openRun()],
    }), machine, 'running')).toBe('running')
    expect(transitionBlockerOf(task({
      status: 'clarification',
      pausedAt: 3,
      executions: [openRun()],
    }), machine, 'running')).toBe('paused')
  })

  it('refuses an unknown transition', () => {
    expect(transitionBlockerOf(task({ status: 'backlog' }), machine, 'running')).toBe('invalid')
  })

  it('does not block a plain move for an unconfirmed permission', () => {
    const card = task({
      status: 'clarification',
      permission: 'danger-full-access',
    })
    expect(transitionBlockerOf(card, machine, 'backlog', 'read-only')).toBeUndefined()
  })

  it('blocks a run start whose permission binding is unconfirmed', () => {
    const card = task({
      status: 'clarification',
      permission: 'danger-full-access',
    })
    expect(transitionBlockerOf(card, machine, 'running', 'read-only')).toBe('permission')
    expect(transitionBlockerOf({ ...card, permissionConfirmedAt: 9 }, machine, 'running', 'read-only')).toBeUndefined()
  })

  it('does not let an open clarification round block moves or the run start', () => {
    const card = task({
      status: 'clarification',
      executions: [openRun('clarify')],
    })
    expect(transitionBlockerOf(card, machine, 'backlog')).toBeUndefined()
    expect(transitionBlockerOf(card, machine, 'running')).toBeUndefined()
  })
})

describe('transitionStartsExecution', () => {
  it('marks the clarify step and the run starts, not plain moves', () => {
    expect(transitionStartsExecution(machine, 'backlog', 'clarification')).toBe(true)
    expect(transitionStartsExecution(machine, 'clarification', 'running')).toBe(true)
    expect(transitionStartsExecution(machine, 'ready_for_test', 'running')).toBe(true)
    expect(transitionStartsExecution(machine, 'failed', 'running')).toBe(true)
    expect(transitionStartsExecution(machine, 'ready_for_test', 'done')).toBe(false)
    expect(transitionStartsExecution(machine, 'done', 'clarification')).toBe(false)
  })
})
