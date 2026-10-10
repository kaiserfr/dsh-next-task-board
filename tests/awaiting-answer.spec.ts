/**
 * Waiting questions: a card whose conversation holds a question the agent asked
 * and stopped on. The Host reads that state off the conversation (a blocking
 * `ask_user_question` call nothing answered, or an agent that ended its turn
 * with its own message while the session rests), publishes card → session to the
 * board, and drops the entry again the moment the human answers — the question
 * lives in the chat, the board only points at it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { TaskRecord } from '../src/core/tasks.ts'
import { createTask, settleExecution, startExecution } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { HostExecutionRunner, questionState } from '../src/host-runner.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-question-'))
  roots.push(root)
  return root
}

type GatewayRequest = {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

/** One history record of the shape `session/follow` serves. */
function event(type: string, seq: number, data: unknown): unknown {
  return { type: 'event' as const, event: { type, seq, time: seq, data } }
}

/** An `ask_user_question` call the model made. */
function askCall(seq: number, callId = 'call-1'): unknown {
  return event('tool/call', seq, { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: '{"questions":[]}' })
}

/** The result that answers `callId` (any tool result, including the question tool's). */
function toolResult(seq: number, callId = 'call-1'): unknown {
  return event('tool/result', seq, { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [] } })
}

/** One message of the assistant (the shape the fold reads the text of). */
function assistantMessage(seq: number, text = 'Wie soll ich das archivieren?'): unknown {
  return event('assistant/message', seq, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

/** One human turn. */
function userMessage(seq: number): unknown {
  return event('user/message', seq, { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: 'Antwort' }] })
}

function followStream(records: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', header: {}, cursor: 100, records, hasMore: false, projections: {} }
    },
  }
}

/** A runner over a fake gateway: one history window plus an optional projection read. */
function makeRunner(records: readonly unknown[], options: { projections?: unknown | 'unavailable' | 'fail'; followFails?: boolean } = {}) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const invokes: string[] = []
  const gateway = {
    invoke: vi.fn(async (request: GatewayRequest) => {
      invokes.push(request.method)
      if (request.method !== 'projections') throw new Error('unexpected gateway call: ' + request.method)
      if (options.projections === 'unavailable') throw Object.assign(new Error('projections unavailable'), { code: 'session/projections-unavailable' })
      if (options.projections === 'fail') throw new Error('offline')
      return options.projections ?? { asOfSeq: 100, values: {} }
    }),
    stream: vi.fn(async () => {
      if (options.followFails === true) throw new Error('offline')
      return followStream(records)
    }),
  } as unknown as TypertGateway
  return { runner: new HostExecutionRunner(gateway), invokes, warn }
}

describe('questionState folds the newest surface event', () => {
  it('reports an unanswered ask_user_question call as open', () => {
    expect(questionState([userMessage(1), askCall(2)] as never)).toEqual({ openQuestion: true, yielded: false })
  })

  it('drops the question once a tool result answers the call', () => {
    expect(questionState([askCall(2), toolResult(3)] as never)).toEqual({ openQuestion: false, yielded: false })
    // Any result newer than the call means the agent went on working.
    expect(questionState([askCall(2, 'call-1'), toolResult(3, 'call-2')] as never)).toEqual({ openQuestion: false, yielded: false })
  })

  it('ignores tool calls that are not questions', () => {
    expect(questionState([event('tool/call', 2, { callId: 'c', name: 'bash', arguments: '{}' })] as never))
      .toEqual({ openQuestion: false, yielded: false })
  })

  it('reads the agent speaking last as a yielded turn', () => {
    expect(questionState([userMessage(1), assistantMessage(2)] as never)).toEqual({ openQuestion: false, yielded: true })
    // The turn end after the message frames it and must not change the verdict.
    expect(questionState([assistantMessage(2), event('turn/end', 3, { reason: { kind: 'completed' } })] as never))
      .toEqual({ openQuestion: false, yielded: true })
  })

  it('does not count a human turn or a dangling tool result as a question', () => {
    expect(questionState([assistantMessage(1), userMessage(2)] as never)).toEqual({ openQuestion: false, yielded: false })
    expect(questionState([assistantMessage(1), toolResult(2, 'other')] as never)).toEqual({ openQuestion: false, yielded: false })
    expect(questionState([] as never)).toEqual({ openQuestion: false, yielded: false })
  })
})

describe('HostExecutionRunner.awaitingAnswer', () => {
  it('reports a blocking question while the session is still running, without a projection read', async () => {
    const { runner, invokes } = makeRunner([userMessage(1), askCall(2)])
    await expect(runner.awaitingAnswer('session-a', true)).resolves.toBe(true)
    expect(invokes).toEqual([])
  })

  it('reports an agent that ended its turn at rest', async () => {
    const { runner, invokes } = makeRunner([userMessage(1), assistantMessage(2)])
    await expect(runner.awaitingAnswer('session-a', false)).resolves.toBe(true)
    expect(invokes).toEqual([])
  })

  it('does not call a running agent that merely spoke last a wait', async () => {
    const { runner, invokes } = makeRunner([assistantMessage(2)])
    await expect(runner.awaitingAnswer('session-a', true)).resolves.toBe(false)
    // The structural verdict must still be able to find a timed question: the
    // projection is read exactly then.
    expect(invokes).toEqual(['projections'])
  })

  it('reports a timed question the projection still offers', async () => {
    const projections = { asOfSeq: 100, values: { userQuestions: { active: [{ callId: 'c', questions: [], state: 'continued' }], settled: [] } } }
    const open = makeRunner([userMessage(1)], { projections })
    await expect(open.runner.awaitingAnswer('session-a', true)).resolves.toBe(true)
    const settled = makeRunner([userMessage(1)], { projections: { asOfSeq: 100, values: { userQuestions: { active: [], settled: [] } } } })
    await expect(settled.runner.awaitingAnswer('session-a', true)).resolves.toBe(false)
  })

  it('treats an absent projection as no evidence and a failed read as unknown', async () => {
    const absent = makeRunner([userMessage(1)], { projections: 'unavailable' })
    await expect(absent.runner.awaitingAnswer('session-a', true)).resolves.toBe(false)
    const broken = makeRunner([userMessage(1)], { projections: 'fail' })
    await expect(broken.runner.awaitingAnswer('session-a', true)).resolves.toBeUndefined()
    const noHistory = makeRunner([], { followFails: true })
    await expect(noHistory.runner.awaitingAnswer('session-a', false)).resolves.toBeUndefined()
    expect(noHistory.warn).toHaveBeenCalledWith(
      '[dsh-task-board] session/follow failed while checking for a waiting question; will retry',
      expect.any(Error),
    )
  })
})

describe('HostTaskLedger.awaitingAnswerWatch', () => {
  /** Import one hand-built card (no run starts, nothing settles). */
  function ledgerWith(task: TaskRecord): HostTaskLedger {
    const ledger = new HostTaskLedger(tempRoot(), () => 1_000)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'test', tasks: [task] })
    return ledger
  }

  it('follows an open run and a todo card that ran its clarification round', () => {
    const base = createTask({ title: 'A', description: '', prompt: '' }, 1_000, 'task-a')
    const running = startExecution(base, 1_100, 'run-1')
    const attached: TaskRecord = { ...running.task, executions: running.task.executions.map(execution => ({ ...execution, sessionId: 'session-run' })) }
    expect(ledgerWith(attached).awaitingAnswerWatch()).toEqual([{ taskId: 'task-a', sessionId: 'session-run' }])

    const clarify = startExecution({ ...base, status: 'todo' }, 1_100, 'clarify-1', undefined, 'clarify')
    const settled = settleExecution({ ...clarify.task, clarificationSessionId: 'session-clarify' }, 'clarify-1', 'succeeded', 1_200, undefined)
    expect(settled.status).toBe('todo')
    expect(ledgerWith(settled).awaitingAnswerWatch()).toEqual([{ taskId: 'task-a', sessionId: 'session-clarify' }])
  })

  it('leaves out settled cards, paused cards, archived cards and runs without a session', () => {
    const base = createTask({ title: 'A', description: '', prompt: '' }, 1_000, 'task-a')
    const running = startExecution(base, 1_100, 'run-1')
    const attached: TaskRecord = { ...running.task, executions: running.task.executions.map(execution => ({ ...execution, sessionId: 'session-run' })) }
    // Settled: the run is over, so nothing of the card waits.
    expect(ledgerWith(settleExecution(attached, 'run-1', 'succeeded', 1_200, undefined)).awaitingAnswerWatch()).toEqual([])
    // Paused: the session was stopped deliberately, which is not a wait.
    expect(ledgerWith({ ...attached, pausedAt: 1_300 }).awaitingAnswerWatch()).toEqual([])
    // Archived: read-only.
    expect(ledgerWith({ ...attached, archivedAt: 1_300 }).awaitingAnswerWatch()).toEqual([])
    // An open run that has not attached a session yet has no conversation.
    expect(ledgerWith(running.task).awaitingAnswerWatch()).toEqual([])
  })
})

describe('TaskBoardHostService publishes waiting questions', () => {
  /** A todo card whose clarification round asked and settled, session attached. */
  function clarifyingCard(): TaskRecord {
    const base = createTask({ title: 'A', description: '', prompt: '' }, 1_000, 'task-a')
    const clarify = startExecution({ ...base, status: 'todo' }, 1_100, 'clarify-1', undefined, 'clarify')
    return settleExecution({ ...clarify.task, clarificationSessionId: 'session-clarify' }, 'clarify-1', 'succeeded', 1_200, undefined)
  }

  /** A running card with a session: the roster still calls it working. */
  function runningCard(): TaskRecord {
    const base = createTask({ title: 'A', description: '', prompt: '' }, 1_000, 'task-a')
    const running = startExecution(base, 1_100, 'run-1')
    return { ...running.task, executions: running.task.executions.map(execution => ({ ...execution, sessionId: 'session-run' })) }
  }

  /**
   * A service over a scripted Host: the scenario can change between polls, which
   * is exactly what a conversation does.
   */
  function makeService(card: TaskRecord, scenario: { records: readonly unknown[] | 'fail'; updatedAt: number; running: boolean; listFails?: boolean }) {
    const invoke = vi.fn(async (request: GatewayRequest) => {
      if (request.namespace !== 'session') throw new Error('unexpected namespace')
      if (request.method === 'list') {
        if (scenario.listFails === true) throw new Error('offline')
        return {
          items: [{
            sessionId: card.executions[card.executions.length - 1]?.sessionId ?? 'session-clarify',
            running: scenario.running,
            updatedAt: scenario.updatedAt,
            agentAvailable: true,
            blank: false,
          }],
        }
      }
      if (request.method === 'projections') {
        // The wire contract of that read: one `request` object carrying the id.
        expect(Object.keys(request.args)).toEqual(['request'])
        return { asOfSeq: 100, values: { userQuestions: { active: [], settled: [] } } }
      }
      throw new Error('unexpected gateway call: ' + request.method)
    })
    const stream = vi.fn(async (request: GatewayRequest) => {
      if (request.method !== 'follow') throw new Error('unexpected stream call: ' + request.method)
      if (scenario.records === 'fail') throw new Error('offline')
      return followStream(scenario.records)
    })
    const ledger = new HostTaskLedger(tempRoot(), () => 2_000)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'test', tasks: [card] })
    const service = new TaskBoardHostService({ invoke, stream } as unknown as TypertGateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => 2_000,
    })
    return {
      service,
      invoke,
      stream,
      scenario,
      poll: async (): Promise<void> => { await (service as unknown as { pollSessions(): Promise<void> }).pollSessions() },
    }
  }

  it('shows the card with the question, holds it through a read failure, clears it with the answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const view = makeService(clarifyingCard(), { records: [userMessage(1), assistantMessage(2)], updatedAt: 5, running: false })
    const frames: Array<Record<string, string> | undefined> = []
    view.service.subscribe(() => { frames.push(view.service.eventPayload().awaitingAnswer) })

    await view.poll()
    expect(view.service.snapshot().awaitingAnswer).toEqual({ 'task-a': 'session-clarify' })
    // The SSE frame carries the map: it never bumps the revision the frame is
    // gated on, so this is the only push the browser gets.
    expect(frames.at(-1)).toEqual({ 'task-a': 'session-clarify' })

    // The conversation moved on but the read fails: the verdict holds (the human
    // still owes the answer until the answer itself is visible).
    view.scenario.records = 'fail'
    view.scenario.updatedAt = 6
    await view.poll()
    expect(view.service.snapshot().awaitingAnswer).toEqual({ 'task-a': 'session-clarify' })
    expect(warn).toHaveBeenCalledWith(
      '[dsh-task-board] session/follow failed while checking for a waiting question; will retry',
      expect.any(Error),
    )

    // The human answered: the newest event is the human's own turn.
    view.scenario.records = [assistantMessage(1), userMessage(2)]
    view.scenario.updatedAt = 7
    await view.poll()
    expect(view.service.snapshot().awaitingAnswer).toEqual({})
    expect(frames.at(-1)).toEqual({})
    view.service.dispose()
  })

  it('keeps the verdict while the roster is unknown and reads no history twice for one row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = makeService(clarifyingCard(), { records: [assistantMessage(2)], updatedAt: 5, running: false })
    await view.poll()
    expect(view.service.snapshot().awaitingAnswer).toEqual({ 'task-a': 'session-clarify' })
    const reads = view.stream.mock.calls.length

    // An unchanged roster row cannot carry a new event: no second read.
    await view.poll()
    expect(view.stream.mock.calls.length).toBe(reads)

    // An unreadable roster is no evidence: the card keeps its symbol.
    view.scenario.listFails = true
    await view.poll()
    expect(view.service.snapshot().awaitingAnswer).toEqual({ 'task-a': 'session-clarify' })
    view.service.dispose()
  })

  it('publishes an open run whose agent asked and waits, without a projection read', async () => {
    const view = makeService(runningCard(), { records: [userMessage(1), askCall(2)], updatedAt: 5, running: true })
    await view.poll()
    expect(view.service.snapshot().awaitingAnswer).toEqual({ 'task-a': 'session-run' })
    expect(view.invoke.mock.calls.filter(call => (call[0] as GatewayRequest).method === 'projections')).toEqual([])
    view.service.dispose()
  })
})
