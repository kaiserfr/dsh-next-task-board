/**
 * The clarification step: pulling a card out of the backlog starts its run in
 * the `todo` column — the run column's execution (same queue, same WIP limit,
 * same session link, pausable) whose prompt asks the card's open questions
 * first and stops. The agent asks them in the card's own chat, the human
 * answers there, and the go-ahead (the drag on to the run column or the Run
 * button) continues that very conversation with the implementation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTask, hasOpenRun, settleExecution, startExecution, type TaskRecord } from '../src/core/tasks.ts'
import { reusableSessionId } from '../src/core/session-reuse.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { CLARIFICATION_ADDENDUM, COMPLETION_MARKER, promptText } from '../src/host-runner.ts'
import { DEFAULT_STATE_MACHINE, StateMachine } from '../src/core/state-machine.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-clarify-'))
  roots.push(root)
  return root
}

/** A ledger holding one backlog card. */
function seeded(): HostTaskLedger {
  const ledger = new HostTaskLedger(tempRoot(), () => NOW)
  ledger.applyRequest('seed', {
    kind: 'create',
    id: 'a',
    input: { title: 'A', description: 'the card', prompt: 'implement it' },
  })
  return ledger
}

function card(id = 'a'): TaskRecord {
  return createTask({ title: id, description: '', prompt: 'implement it' }, NOW, id)
}

describe('a clarification execution never moves the card', () => {
  it('opens without a status change and settles without one', () => {
    const todo: TaskRecord = { ...card(), status: 'todo' }
    const opened = startExecution(todo, NOW, 'clarify-1', undefined, 'clarify')
    expect(opened.task.status).toBe('todo')
    expect(opened.execution.kind).toBe('clarify')
    expect(hasOpenRun(opened.task)).toBe(false)

    const settled = settleExecution(opened.task, 'clarify-1', 'succeeded', NOW + 1, undefined)
    expect(settled.status).toBe('todo')
    expect(settled.executions[0].result).toBe('succeeded')

    // Even a failed clarification keeps the card where it was: the human
    // retries from the same column instead of hunting a card in `failed`.
    const failed = settleExecution(opened.task, 'clarify-1', 'failed', NOW + 1, 'no session')
    expect(failed.status).toBe('todo')
  })

  it('keeps a real run on its own path', () => {
    const run = startExecution(card(), NOW, 'run-1')
    expect(run.task.status).toBe('running')
    expect(hasOpenRun(run.task)).toBe(true)
    expect(settleExecution(run.task, 'run-1', 'succeeded', NOW + 1, undefined).status).toBe('ready_for_test')
  })
})

describe('the clarification step starts the card own run', () => {
  it('has no transition from backlog to the run column at all', () => {
    expect(new StateMachine(DEFAULT_STATE_MACHINE).canTransition('backlog', 'running')).toBe(false)
    const ledger = seeded()
    expect(() => ledger.applyRequest('straight-to-running', { kind: 'move', taskId: 'a', status: 'running' }))
      .toThrow('invalid state transition: backlog → running')
    ledger.dispose()
  })

  it('reports a run on backlog → todo and keeps the card there', () => {
    const ledger = seeded()
    const result = ledger.applyRequest('clarify-step', { kind: 'move', taskId: 'a', status: 'todo' })
    expect(result.clarification?.task.status).toBe('todo')
    expect(result.clarification?.execution.kind).toBe('clarify')
    expect(result.run).toBeUndefined()
    // A real execution: the card reads Running/Queued and the Host monitor
    // settles it, but its column never changes.
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
    expect(ledger.state().tasks[0].status).toBe('todo')
    expect(ledger.runtimeView().openExecutions[0]?.taskId).toBe('a')
    ledger.dispose()
  })

  it('starts the run for every card, questions listed or not', () => {
    // The todo column *is* the clarification step: the agent asks what it needs
    // to know, so no card has to announce questions beforehand.
    const ledger = seeded()
    const first = ledger.applyRequest('first-todo', { kind: 'move', taskId: 'a', status: 'todo' })
    expect(first.clarification?.execution.kind).toBe('clarify')
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
    ledger.dispose()
  })

  it('re-enters the card own conversation when the card passes the step again', () => {
    const ledger = seeded()
    const first = ledger.applyRequest('first-todo', { kind: 'move', taskId: 'a', status: 'todo' })
    // The Host launched and stamped the card's conversation; a later round trip
    // opens the run again but reuses that conversation instead of minting a
    // second session.
    ledger.attachSession('a', first.clarification!.execution.id, 'session-clarify')
    ledger.settle('a', first.clarification!.execution.id, 'succeeded')
    expect(ledger.state().tasks[0].clarificationSessionId).toBe('session-clarify')
    ledger.applyRequest('back', { kind: 'move', taskId: 'a', status: 'backlog' })
    const again = ledger.applyRequest('second-todo', { kind: 'move', taskId: 'a', status: 'todo' })
    expect(again.clarification?.execution.kind).toBe('clarify')
    expect(again.clarification?.task.clarificationSessionId).toBe('session-clarify')
    expect(again.clarification?.task.executions).toHaveLength(2)
    ledger.dispose()
  })

  it('lets the card move on while its run is still open, closing the round', () => {
    const ledger = seeded()
    ledger.applyRequest('to-todo', { kind: 'move', taskId: 'a', status: 'todo' })
    // The chat has not settled yet; the human may already pull the card on.
    const opened = ledger.applyRequest('to-running', { kind: 'move', taskId: 'a', status: 'running' })
    expect(opened.run?.task.status).toBe('running')
    // The go-ahead closes the round: a card never holds two open executions
    // (which would also occupy two WIP slots) and never mints two sessions.
    const [round, run] = opened.run!.task.executions
    expect(round?.kind).toBe('clarify')
    expect(round?.endedAt).toBe(NOW)
    expect(round?.result).toBe('cancelled')
    expect(run?.endedAt).toBeUndefined()
    expect(ledger.runtimeView().openExecutions).toHaveLength(1)
    ledger.dispose()
  })

  it('pauses and resumes the round like the run column does', () => {
    const ledger = seeded()
    const moved = ledger.applyRequest('to-todo', { kind: 'move', taskId: 'a', status: 'todo' })
    ledger.attachSession('a', moved.clarification!.execution.id, 'session-clarify')
    // The card is parked in `todo`, but its open run is pausable: the pause
    // stops the session and the monitor leaves the run alone.
    const paused = ledger.applyRequest('pause-clarify', { kind: 'pause', taskIds: ['a'] })
    expect(paused.paused).toEqual([{ taskId: 'a', sessionId: 'session-clarify' }])
    expect(ledger.isPaused('a')).toBe(true)
    expect(ledger.runtimeView().openExecutions).toEqual([])
    const resumed = ledger.applyRequest('resume-clarify', { kind: 'resume', taskIds: ['a'] })
    expect(resumed.resumed?.[0]?.execution.sessionId).toBe('session-clarify')
    expect(ledger.isPaused('a')).toBe(false)
    ledger.dispose()
  })

  it('settles a clarification execution without leaving the column', () => {
    const ledger = seeded()
    const moved = ledger.applyRequest('to-todo', { kind: 'move', taskId: 'a', status: 'todo' })
    ledger.attachSession('a', moved.clarification!.execution.id, 'session-clarify')
    // The agent asked and stopped: the monitor settles the run, the card stays
    // in `todo` and the badge disappears with the open execution.
    ledger.settle('a', moved.clarification!.execution.id, 'succeeded')
    const task = ledger.state().tasks[0]
    expect(task.status).toBe('todo')
    expect(task.executions[0]?.result).toBe('succeeded')
    expect(ledger.runtimeView().openExecutions).toEqual([])
    ledger.dispose()
  })
})

describe('the clarification session is the run conversation', () => {
  it('continues the clarification session instead of minting a new one', () => {
    const task = { ...card(), clarificationSessionId: 'session-clarify' }
    expect(reusableSessionId(task, new Set(['session-clarify']))).toBe('session-clarify')
    // Fail closed while the roster is unknown: a fresh conversation is safe.
    expect(reusableSessionId(task, undefined)).toBeUndefined()
    expect(reusableSessionId(task, new Set(['other']))).toBeUndefined()
  })

  it('prefers the newest settled execution of a rework round', () => {
    const task: TaskRecord = {
      ...card(),
      clarificationSessionId: 'session-clarify',
      executions: [{ id: 'run-1', sessionId: 'session-run', startedAt: NOW, endedAt: NOW + 1, result: 'succeeded', error: undefined }],
    }
    expect(reusableSessionId(task, new Set(['session-clarify', 'session-run']), { rework: true })).toBe('session-run')
    expect(reusableSessionId(task, new Set(['session-clarify', 'session-run']))).toBe('session-clarify')
  })

  it('composes the clarification turn from the run prompt plus the addendum', () => {
    const prompt = promptText(card(), { clarification: true })
    // The full run prompt (the card's own instruction) is the base...
    expect(prompt).toContain('implement it')
    // ...followed by the addendum, verbatim: it forbids implementing, and it
    // covers the answer turns too (ask again and stop, or stop after the last
    // answer) — the implementation is bound to the explicit go-ahead.
    for (const line of CLARIFICATION_ADDENDUM) expect(prompt).toContain(line)
    expect(prompt).toContain('und implementiere noch nichts')
    expect(prompt).toContain('Wenn noch Fragen offen sind, stelle die nächsten und stoppe wieder.')
    expect(prompt).toContain('Die Implementierung beginnt erst mit')
    // The clarification turn implements nothing, so it must not carry the
    // completion contract that tells the agent to report a finished task.
    expect(prompt).not.toContain(COMPLETION_MARKER)
  })

  it('sends the go-ahead plus the completion contract into the continued clarification session', () => {
    const task = { ...card(), clarificationSessionId: 'session-clarify' }
    const prompt = promptText(task, { continued: true, implement: true })
    expect(prompt.startsWith('Bitte jetzt implementieren.')).toBe(true)
    // The go-ahead is the only turn allowed to work: no clarification addendum
    // rides it, and it is not the card prompt repeated. The completion contract
    // does ride it — this turn does the work and reports it when done.
    expect(prompt).toContain(COMPLETION_MARKER)
    for (const line of CLARIFICATION_ADDENDUM) expect(prompt).not.toContain(line)
  })
})
