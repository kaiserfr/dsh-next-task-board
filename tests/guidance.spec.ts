import { describe, expect, it } from 'vitest'
import { TASK_BOARD_GUIDANCE } from '../src/index.ts'
import { CLARIFICATION_ADDENDUM, COMPLETION_INSTRUCTION, COMPLETION_MARKER } from '../src/host-runner.ts'

describe('task-board model guidance', () => {
  it('tells agents to close visible todo_write plans before the final answer', () => {
    expect(TASK_BOARD_GUIDANCE).toContain('todo_write')
    expect(TASK_BOARD_GUIDANCE).toContain('最终回复前')
    expect(TASK_BOARD_GUIDANCE).toContain('completed')
  })

  it('states the clarification rule: open questions first, implementation afterwards', () => {
    // The rule verbatim — the task system prompt has to carry it.
    expect(TASK_BOARD_GUIDANCE)
      .toContain('Offene Fragen werden immer zuerst geklärt, bevor mit der Implementierung begonnen wird.')
    // Plus the shape of the step: pulling a card out of the backlog starts a
    // real run exactly like a drop on the run column (same queue, but WIP-free —
    // todo counts against no lane limit), only its prompt asks first; pulling
    // the card on to the run column releases the questions and continues that
    // same session, and only cron still refuses.
    expect(TASK_BOARD_GUIDANCE).toContain('Der Übergang von Backlog nach Todo ist der Klärungsschritt')
    expect(TASK_BOARD_GUIDANCE).toContain('ohne die WIP-Grenze der Spur')
    expect(TASK_BOARD_GUIDANCE).toContain('待办列无 WIP 名额')
    // The rule keys off the run's own addendum, and it has to spell that
    // addendum out: a trigger the prompt does not contain would never fire, so
    // the guidance interpolates the very lines the clarification run sends.
    for (const line of CLARIFICATION_ADDENDUM) expect(TASK_BOARD_GUIDANCE).toContain(line)
    // And it forbids implementing in that session — in every turn, not just the
    // first one, which is what keeps the agent from implementing after an answer.
    expect(TASK_BOARD_GUIDANCE).toContain('STOPPREGEL FÜR KLÄRUNGSSESSIONS')
    expect(TASK_BOARD_GUIDANCE).toContain('gilt in JEDEM Turn')
    expect(TASK_BOARD_GUIDANCE).toContain('auch nicht, nachdem der Nutzer eine oder alle Fragen beantwortet hat')
    expect(TASK_BOARD_GUIDANCE).toContain('Bitte jetzt implementieren.')
    expect(TASK_BOARD_GUIDANCE).toContain('Ein direktes Ziehen von Backlog nach In Progress ist nicht möglich')
  })

  it('states the completion rule with the very marker the Host recognizes', () => {
    // The rule keys off the run prompt's completion contract, so the guidance
    // interpolates the same constants the runner tells the agent about.
    expect(TASK_BOARD_GUIDANCE).toContain(COMPLETION_MARKER)
    expect(TASK_BOARD_GUIDANCE).toContain(COMPLETION_INSTRUCTION)
    expect(TASK_BOARD_GUIDANCE).toContain('FERTIG-MELDUNG FÜR IMPLEMENTIERUNGSLAUFS')
    // And it keeps the clarification round out of it.
    expect(TASK_BOARD_GUIDANCE).toContain('gilt die Meldung NICHT')
  })
})
