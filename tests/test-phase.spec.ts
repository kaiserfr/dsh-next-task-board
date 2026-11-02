/**
 * The two-phase run: an implementation run parks the card in `testing` and
 * opens the WIP-free test run of the same conversation; that run tests and
 * reports, and its settle parks the card in `tested` (the merge gate). A card
 * marked test-free skips the phase entirely, and the manual "start tests"
 * action can re-open the run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTask,
  implementationParkStatus,
  type TaskRecord,
} from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import {
  COMPLETION_INSTRUCTION,
  IMPLEMENTATION_PHASE_INSTRUCTION,
  TEST_INSTRUCTION,
  promptText,
} from '../src/host-runner.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-test-phase-'))
  roots.push(root)
  return root
}

function ledger(): HostTaskLedger {
  const instance = new HostTaskLedger(tempRoot(), () => NOW)
  instance.applyRequest('create', {
    kind: 'create',
    id: 'card',
    input: { title: 'Card', description: '', prompt: 'work' },
  })
  return instance
}

/** Start the card's implementation run, attach a session and settle it. */
function runAndSettle(instance: HostTaskLedger): TaskRecord {
  const opened = instance.applyRequest('run-card', { kind: 'run', taskId: 'card' }).run!
  instance.attachSession('card', opened.execution.id, 'session-card')
  instance.settle('card', opened.execution.id, 'succeeded', undefined)
  return instance.state().tasks[0]!
}

describe('the implementation park opens the test run', () => {
  it('parks in testing and opens the test execution in the same conversation', () => {
    const instance = ledger()
    const parked = runAndSettle(instance)
    expect(parked.status).toBe('testing')
    const testRun = parked.executions.at(-1)!
    expect(testRun.kind).toBe('test')
    expect(testRun.endedAt).toBeUndefined()
    expect(testRun.sessionId).toBeUndefined()
    instance.dispose()
  })

  it('settles the test run into the merge gate, a failed test run into failed', () => {
    const instance = ledger()
    runAndSettle(instance)
    const testRun = instance.state().tasks[0]!.executions.at(-1)!
    instance.settle('card', testRun.id, 'succeeded', undefined)
    expect(instance.state().tasks[0]!.status).toBe('tested')

    const second = ledger()
    runAndSettle(second)
    const failing = second.state().tasks[0]!.executions.at(-1)!
    second.settle('card', failing.id, 'failed', 'the test harness crashed')
    expect(second.state().tasks[0]!.status).toBe('failed')
    second.dispose()
    instance.dispose()
  })

  it('counts neither the test run nor its settle against the implementation park', () => {
    const instance = ledger()
    runAndSettle(instance)
    const operation = instance.runtimeView().openExecutions.find(entry => entry.taskId === 'card')!
    expect(operation.kind).toBe('test')
    instance.dispose()
  })
})

describe('a card marked test-free skips the test phase', () => {
  function imported(instance: HostTaskLedger, overrides: Partial<TaskRecord>): void {
    const base = createTask({ title: 'Card', description: '', prompt: 'work' }, NOW, 'card')
    instance.applyRequest('import', {
      kind: 'import',
      sourceId: 'seed',
      tasks: [{
        ...base,
        ...overrides,
        executions: [{
          id: 'execution-1',
          sessionId: 'session-card',
          startedAt: NOW,
          endedAt: undefined,
          result: undefined,
          error: undefined,
        }],
      }],
    })
    instance.settle('card', 'execution-1', 'succeeded', undefined)
  }

  it('parks straight in tested when the card has a branch and opens no run', () => {
    const instance = new HostTaskLedger(tempRoot(), () => NOW)
    imported(instance, {
      status: 'running',
      skipTests: true,
      git: { branch: 'task/card', base: 'main', repoPath: '/repo' },
    })
    const card = instance.state().tasks[0]!
    expect(card.status).toBe('tested')
    expect(card.executions).toHaveLength(1)
    instance.dispose()
  })

  it('parks straight in done when there is nothing to merge either', () => {
    const instance = new HostTaskLedger(tempRoot(), () => NOW)
    imported(instance, { status: 'running', skipTests: true })
    const card = instance.state().tasks[0]!
    expect(card.status).toBe('done')
    expect(card.doneAt).toBe(NOW)
    instance.dispose()
  })

  it('routes the park target by the mark and the branch', () => {
    const plain = createTask({ title: 'T', description: '', prompt: 'p' }, NOW, 't')
    expect(implementationParkStatus(plain)).toBe('testing')
    expect(implementationParkStatus({ ...plain, skipTests: true })).toBe('done')
    expect(implementationParkStatus({
      ...plain,
      skipTests: true,
      git: { branch: 'task/t', base: 'main', repoPath: '/repo' },
    })).toBe('tested')
  })
})

describe('manual test start', () => {
  it('opens the test run from testing and refuses it elsewhere or twice', () => {
    const instance = ledger()
    instance.applyRequest('park', { kind: 'move', taskId: 'card', status: 'testing' })
    const opened = instance.applyRequest('start-test', { kind: 'start-test', taskId: 'card' })
    expect(opened.run?.execution.kind).toBe('test')
    expect(instance.state().tasks[0]!.status).toBe('testing')
    expect(() => instance.applyRequest('start-test-2', { kind: 'start-test', taskId: 'card' }))
      .toThrow('task already has an open run')
    expect(() => instance.applyRequest('start-test-3', { kind: 'start-test', taskId: 'nope' }))
      .toThrow('task not found')
    instance.dispose()
  })

  it('refuses the manual start outside the testing column', () => {
    const instance = ledger()
    expect(() => instance.applyRequest('start-test', { kind: 'start-test', taskId: 'card' }))
      .toThrow('test-requires-testing')
    instance.dispose()
  })
})

describe('run prompts', () => {
  const task = createTask({ title: 'T', description: '', prompt: 'do it' }, NOW, 't')

  it('keeps the implementation phase distinct from the test phase', () => {
    const implementation = promptText(task)
    expect(implementation).toContain(IMPLEMENTATION_PHASE_INSTRUCTION)
    expect(implementation).toContain(COMPLETION_INSTRUCTION)
    expect(implementation).not.toContain(TEST_INSTRUCTION)
    expect(promptText(task, { test: true })).toContain(TEST_INSTRUCTION)
    expect(promptText(task, { test: true })).not.toContain(IMPLEMENTATION_PHASE_INSTRUCTION)
  })

  it('opens a continued test run with the short test turn and a fresh one with the card body', () => {
    expect(promptText(task, { test: true, continued: true })).toContain('Bitte jetzt testen.')
    expect(promptText(task, { test: true, continued: true })).not.toContain('do it')
    const fresh = promptText(task, { test: true })
    expect(fresh).toContain('do it')
    expect(fresh).toContain(TEST_INSTRUCTION)
  })

  it('does not carry the implementation phase into the conflict-resolution turn', () => {
    const merge = promptText(task, { merge: true })
    expect(merge).not.toContain(IMPLEMENTATION_PHASE_INSTRUCTION)
    expect(merge).toContain(COMPLETION_INSTRUCTION)
  })
})
