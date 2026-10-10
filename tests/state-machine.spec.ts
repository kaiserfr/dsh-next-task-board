/**
 * The configurable state machine: configuration validation, the transitions a
 * drag & drop is checked against, the actions a transition fires, and the
 * checked-in diagram staying in sync with the definition.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALL_STATUSES,
  DEFAULT_STATE_MACHINE,
  isTaskStatus,
  normalizeStateMachine,
  renderStateMachineMermaid,
  resolveStateMachine,
  StateMachine,
} from '../src/core/state-machine.ts'
import { canMoveManually } from '../src/core/tasks.ts'

const defaultMachine = new StateMachine(DEFAULT_STATE_MACHINE)

/** A minimal valid override built from JSON, i.e. what a settings draft holds. */
const custom = {
  initial: 'todo',
  states: [{ status: 'backlog' }, { status: 'todo' }, { status: 'done' }],
  transitions: [
    { from: 'todo', to: 'done', actions: ['git.mergeBranch'] },
    { from: 'done', to: 'todo' },
  ],
}

describe('state machine config', () => {
  it('accepts the shipped machine and reports no errors', () => {
    expect(normalizeStateMachine(DEFAULT_STATE_MACHINE).errors).toEqual([])
  })

  it('builds a machine from a settings JSON document', () => {
    const { machine, errors } = resolveStateMachine(custom)
    expect(errors).toEqual([])
    expect(machine?.states.map(state => state.status)).toEqual(['backlog', 'todo', 'done'])
    expect(machine?.initialStatus).toBe('todo')
  })

  it('refuses unknown states, unknown actions, self-transitions, bad triggers and duplicates', () => {
    const { machine, errors } = normalizeStateMachine({
      states: [{ status: 'backlog' }, { status: 'nope' }, { status: 'backlog' }],
      transitions: [
        { from: 'backlog', to: 'backlog' },
        { from: 'backlog', to: 'todo' },
        { from: 'backlog', to: 'done', actions: ['git.rebase'] },
        { from: 'backlog', to: 'failed', trigger: 'sometimes' },
      ],
    })
    expect(machine).toBeUndefined()
    expect(errors).toEqual([
      'stateMachine.states[1]: unknown status',
      'stateMachine.states[2]: duplicate status backlog',
      'stateMachine.transitions[0]: backlog → backlog is not a transition',
      'stateMachine.transitions[1].to: todo is not a column',
      'stateMachine.transitions[2].to: done is not a column',
      'stateMachine.transitions[2].actions: unknown action "git.rebase"',
      'stateMachine.transitions[3].to: failed is not a column',
      'stateMachine.transitions[3].trigger: expected one of manual, runner, cron',
    ])
  })

  it('falls back to the shipped machine on an invalid config', () => {
    const { machine, errors } = resolveStateMachine({ states: [] })
    expect(errors).not.toEqual([])
    expect(machine.canTransition('backlog', 'todo')).toBe(true)
  })

  it('requires an explicit initial state once backlog is not a column', () => {
    const withoutInitial = normalizeStateMachine({ states: [{ status: 'todo' }], transitions: [] })
    expect(withoutInitial.errors).toEqual(['stateMachine.initial: required when "backlog" is not a column'])
    const withInitial = normalizeStateMachine({ initial: 'todo', states: [{ status: 'todo' }], transitions: [] })
    expect(withInitial.errors).toEqual([])
  })

  it('orders columns by `order`, with unset columns keeping their declared slot', () => {
    const machine = normalizeStateMachine({
      states: [{ status: 'backlog' }, { status: 'done', order: -1 }, { status: 'todo' }],
      transitions: [],
    }).machine!
    expect(machine.states.map(state => state.status)).toEqual(['done', 'backlog', 'todo'])
  })
})

describe('transitions are the drag & drop rule', () => {
  it('allows exactly the plain status moves the shipped board always had', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const isStatusMove = defaultMachine.canTransition(from, to)
          && !defaultMachine.actionsFor(from, to).includes('run')
        expect(isStatusMove).toBe(canMoveManually(from, to))
      }
    }
    // `running` is entered by a run, never by a status move.
    expect(canMoveManually('todo', 'running')).toBe(false)
    expect(defaultMachine.acceptsDrop('running')).toBe(false)
  })

  it('refuses a move the configured machine does not list', () => {
    const machine = resolveStateMachine(custom).machine!
    expect(machine.canTransition('todo', 'done')).toBe(true)
    expect(machine.canTransition('backlog', 'done')).toBe(false)
    expect(machine.targets('todo')).toEqual(['done'])
  })

  it('separates manual targets from the runner transitions', () => {
    // `running` has only runner transitions; entering it is the `run` action.
    expect(defaultMachine.targets('running')).toEqual([])
    expect(defaultMachine.targets('running', 'runner')).toEqual(['ready_for_test', 'failed', 'todo'])
    expect(defaultMachine.canTransition('running', 'ready_for_test', 'runner')).toBe(true)
    expect(defaultMachine.canTransition('running', 'todo', 'runner')).toBe(true)
    // The clarification step and the two corrected columns reach the run
    // column: a card in `todo` may be dropped onto "In progress" (the action,
    // not the status move, starts it), and a reviewed or failed card may be
    // pulled straight back onto it — a card in `backlog` may not, that drag has
    // no transition at all.
    expect(defaultMachine.actionsFor('todo', 'running')).toEqual(['run'])
    expect(defaultMachine.actionsFor('ready_for_test', 'running')).toEqual(['run'])
    expect(defaultMachine.actionsFor('failed', 'running')).toEqual(['run'])
    expect(defaultMachine.canTransition('backlog', 'running')).toBe(false)
    expect(defaultMachine.targets('backlog')).not.toContain('running')
  })

  it('treats a same-state move as no transition', () => {
    expect(defaultMachine.canTransition('todo', 'todo')).toBe(false)
  })
})

describe('actions hang off transitions', () => {
  it('fires the git hooks on exactly the workflow transitions', () => {
    // `clarify` rides the same transition: pulling a card out of the backlog is
    // its clarification step, not just a branch cut.
    expect(defaultMachine.actionsFor('backlog', 'todo')).toEqual(['git.openBranch', 'clarify'])
    // Every manual way into the review column commits, so no run's work waits
    // uncommitted while the card is reviewed.
    expect(defaultMachine.actionsFor('todo', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('backlog', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('done', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('failed', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('ready_for_test', 'done')).toEqual(['git.mergeBranch'])
    expect(defaultMachine.actionsFor('todo', 'done')).toEqual([])
  })

  it('carries the run action and stamp fields declaratively', () => {
    const machine = resolveStateMachine({
      states: [{ status: 'backlog' }, { status: 'running', drop: false }, { status: 'done' }],
      transitions: [
        { from: 'backlog', to: 'running', actions: ['run'] },
        { from: 'running', to: 'done', trigger: 'runner', actions: [{ kind: 'stamp', field: 'doneAt' }] },
      ],
    }).machine!
    expect(machine.actionsFor('backlog', 'running')).toEqual(['run'])
    expect(machine.actionsFor('running', 'done', 'runner')).toEqual([{ kind: 'stamp', field: 'doneAt' }])
  })

  it('rejects a stamp on an unknown field', () => {
    const { errors } = normalizeStateMachine({
      states: [{ status: 'backlog' }, { status: 'done' }],
      transitions: [{ from: 'backlog', to: 'done', actions: [{ kind: 'stamp', field: 'nope' }] }],
    })
    expect(errors).toEqual(['stateMachine.transitions[0].actions: unknown action {"kind":"stamp","field":"nope"}'])
  })
})

describe('diagram', () => {
  it('matches the checked-in docs/state-machine.md', () => {
    const doc = readFileSync(join(import.meta.dirname, '../docs/state-machine.md'), 'utf8')
    const block = /```mermaid\n([\s\S]*?)\n```/.exec(doc)
    expect(block, 'docs/state-machine.md has no mermaid block').not.toBeNull()
    expect(block![1]).toBe(renderStateMachineMermaid(defaultMachine))
  })

  it('names every column and every transition of the machine', () => {
    const diagram = renderStateMachineMermaid(defaultMachine)
    for (const status of ALL_STATUSES) expect(diagram).toContain(status)
    expect(diagram).toContain('backlog --> todo: manual: openBranch')
    expect(diagram).toContain('todo --> ready_for_test: manual: commitBranch')
    expect(diagram).toContain('ready_for_test --> done: manual: mergeBranch')
    expect(diagram).toContain('running --> ready_for_test, failed, todo: runner')
  })
})

describe('status vocabulary', () => {
  it('keeps isTaskStatus closed', () => {
    expect(ALL_STATUSES.every(isTaskStatus)).toBe(true)
    expect(isTaskStatus('review')).toBe(false)
  })
})
