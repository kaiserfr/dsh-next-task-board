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
  initial: 'clarification',
  states: [{ status: 'backlog' }, { status: 'clarification' }, { status: 'done' }],
  transitions: [
    { from: 'clarification', to: 'done', actions: ['git.mergeBranch'] },
    { from: 'done', to: 'clarification' },
  ],
}

describe('state machine config', () => {
  it('accepts the shipped machine and reports no errors', () => {
    expect(normalizeStateMachine(DEFAULT_STATE_MACHINE).errors).toEqual([])
  })

  it('builds a machine from a settings JSON document', () => {
    const { machine, errors } = resolveStateMachine(custom)
    expect(errors).toEqual([])
    expect(machine?.states.map(state => state.status)).toEqual(['backlog', 'clarification', 'done'])
    expect(machine?.initialStatus).toBe('clarification')
  })

  it('refuses unknown states, unknown actions, self-transitions, bad triggers and duplicates', () => {
    const { machine, errors } = normalizeStateMachine({
      states: [{ status: 'backlog' }, { status: 'nope' }, { status: 'backlog' }],
      transitions: [
        { from: 'backlog', to: 'backlog' },
        { from: 'backlog', to: 'clarification' },
        { from: 'backlog', to: 'done', actions: ['git.rebase'] },
        { from: 'backlog', to: 'failed', trigger: 'sometimes' },
      ],
    })
    expect(machine).toBeUndefined()
    expect(errors).toEqual([
      'stateMachine.states[1]: unknown status',
      'stateMachine.states[2]: duplicate status backlog',
      'stateMachine.transitions[0]: backlog → backlog is not a transition',
      'stateMachine.transitions[1].to: clarification is not a column',
      'stateMachine.transitions[2].to: done is not a column',
      'stateMachine.transitions[2].actions: unknown action "git.rebase"',
      'stateMachine.transitions[3].to: failed is not a column',
      'stateMachine.transitions[3].trigger: expected one of manual, runner, cron',
    ])
  })

  it('falls back to the shipped machine on an invalid config', () => {
    const { machine, errors } = resolveStateMachine({ states: [] })
    expect(errors).not.toEqual([])
    expect(machine.canTransition('backlog', 'clarification')).toBe(true)
  })

  it('requires an explicit initial state once backlog is not a column', () => {
    const withoutInitial = normalizeStateMachine({ states: [{ status: 'clarification' }], transitions: [] })
    expect(withoutInitial.errors).toEqual(['stateMachine.initial: required when "backlog" is not a column'])
    const withInitial = normalizeStateMachine({ initial: 'clarification', states: [{ status: 'clarification' }], transitions: [] })
    expect(withInitial.errors).toEqual([])
  })

  it('orders columns by `order`, with unset columns keeping their declared slot', () => {
    const machine = normalizeStateMachine({
      states: [{ status: 'backlog' }, { status: 'done', order: -1 }, { status: 'clarification' }],
      transitions: [],
    }).machine!
    expect(machine.states.map(state => state.status)).toEqual(['done', 'backlog', 'clarification'])
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
    expect(canMoveManually('clarification', 'running')).toBe(false)
    expect(defaultMachine.acceptsDrop('running')).toBe(false)
  })

  it('refuses a move the configured machine does not list', () => {
    const machine = resolveStateMachine(custom).machine!
    expect(machine.canTransition('clarification', 'done')).toBe(true)
    expect(machine.canTransition('backlog', 'done')).toBe(false)
    expect(machine.targets('clarification')).toEqual(['done'])
  })

  it('separates manual targets from the runner transitions', () => {
    // `running` has only runner transitions; entering it is the `run` action.
    expect(defaultMachine.targets('running')).toEqual([])
    expect(defaultMachine.targets('running', 'runner')).toEqual(['ready_for_test', 'failed', 'clarification'])
    expect(defaultMachine.canTransition('running', 'ready_for_test', 'runner')).toBe(true)
    expect(defaultMachine.canTransition('running', 'clarification', 'runner')).toBe(true)
    // The clarification column and the two corrected columns reach the run
    // column: a card in `clarification` may be dropped onto "In progress" (the
    // action, not the status move, starts it), and a reviewed or failed card may
    // be pulled straight back onto it. A card in `backlog` may not — that drag
    // has no transition at all.
    expect(defaultMachine.actionsFor('clarification', 'running')).toEqual(['run'])
    expect(defaultMachine.actionsFor('ready_for_test', 'running')).toEqual(['run'])
    expect(defaultMachine.actionsFor('failed', 'running')).toEqual(['run'])
    expect(defaultMachine.canTransition('backlog', 'running')).toBe(false)
    expect(defaultMachine.targets('backlog')).not.toContain('running')
  })

  it('treats a same-state move as no transition', () => {
    expect(defaultMachine.canTransition('clarification', 'clarification')).toBe(false)
  })
})

describe('actions hang off transitions', () => {
  it('fires the git hooks on exactly the workflow transitions', () => {
    // `clarify` rides the same transition: pulling a card out of the backlog
    // lands it in the clarification column and opens its round, not just a
    // branch cut. Leaving the column is a plain move or the `run` go-ahead.
    expect(defaultMachine.actionsFor('backlog', 'clarification')).toEqual(['git.openBranch', 'clarify'])
    expect(defaultMachine.actionsFor('clarification', 'backlog')).toEqual([])
    expect(defaultMachine.actionsFor('clarification', 'running')).toEqual(['run'])
    // Every manual way into the review column commits, so no run's work waits
    // uncommitted while the card is reviewed.
    expect(defaultMachine.actionsFor('clarification', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('backlog', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('done', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('failed', 'ready_for_test')).toEqual(['git.commitBranch'])
    expect(defaultMachine.actionsFor('ready_for_test', 'done')).toEqual(['git.mergeBranch'])
    expect(defaultMachine.actionsFor('clarification', 'done')).toEqual([])
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
    expect(diagram).toContain('backlog --> clarification: manual: openBranch, clarify')
    expect(diagram).toContain('clarification --> running: manual: run')
    expect(diagram).toContain('clarification --> ready_for_test: manual: commitBranch')
    expect(diagram).toContain('ready_for_test --> done: manual: mergeBranch')
    expect(diagram).toContain('running --> ready_for_test, failed, clarification: runner')
  })
})

describe('status vocabulary', () => {
  it('keeps isTaskStatus closed', () => {
    expect(ALL_STATUSES.every(isTaskStatus)).toBe(true)
    expect(isTaskStatus('review')).toBe(false)
  })
})
