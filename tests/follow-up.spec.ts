import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitWorkflow } from '../src/git-workflow.ts'
import {
  canStartFollowUp,
  createTask,
  followUpsOf,
  hasFollowUpLock,
  latestSessionIdOf,
  type TaskRecord,
} from '../src/core/tasks.ts'
import { reusableSessionId } from '../src/core/session-reuse.ts'
import { parseLedger } from '../src/core/store.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { promptText } from '../src/host-runner.ts'
import { parseActionEnvelope } from '../src/protocol.ts'

const NOW = new Date(2026, 10, 3, 10, 0, 0).getTime()
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-follow-up-'))
  roots.push(root)
  return root
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Source', description: 'old description', prompt: 'old prompt' }, NOW - 1000, 'src'), ...overrides }
}

/** A settled source card with a conversation and a feature branch. */
function sourceTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return baseTask({
    id: 'src',
    status: 'done',
    executions: [{
      id: 'exec-src',
      sessionId: 'session-src',
      startedAt: NOW - 900,
      endedAt: NOW - 800,
      result: 'succeeded',
      error: undefined,
    }],
    git: {
      branch: 'task/src',
      base: 'main',
      repoPath: '/repo',
      worktreePath: '/repo/worktrees/src',
      reviewedCommit: 'reviewed-src',
      mergedAt: NOW - 700,
    },
    ...overrides,
  })
}

function ledgerWith(tasks: readonly TaskRecord[], options: ConstructorParameters<typeof HostTaskLedger>[2] = {}): HostTaskLedger {
  const ledger = new HostTaskLedger(tempRoot(), () => NOW, options)
  ledger.applyRequest('seed', { kind: 'import', sourceId: 'test-seed', tasks: [...tasks] })
  return ledger
}

function createFollowUp(ledger: HostTaskLedger, id: string, sourceId: string): TaskRecord {
  const result = ledger.applyRequest(`create-${id}`, {
    kind: 'create',
    id,
    input: { title: `Follow-up ${id}`, description: 'new description', prompt: 'fix it', followUpOf: sourceId },
  })
  const created = result.state.tasks.find(task => task.id === id)
  if (created === undefined) throw new Error('follow-up was not created')
  return created
}

describe('follow-up domain helpers', () => {
  it('finds follow-up cards in both directions and locks the source once one exists', () => {
    const source = baseTask({ id: 'src', status: 'done' })
    const followUp = baseTask({
      id: 'fu',
      status: 'backlog',
      followUp: { sourceTaskId: 'src', sessionId: 'session-src', title: 'Source', description: '', prompt: '', createdAt: NOW },
    })
    const tasks = [source, followUp]
    expect(followUpsOf(source, tasks).map(task => task.id)).toEqual(['fu'])
    expect(hasFollowUpLock(source, tasks)).toBe(true)
    expect(hasFollowUpLock(followUp, tasks)).toBe(false)
  })

  it('allows one follow-up at a time and frees the source once it is done or archived', () => {
    const source = baseTask({ id: 'src', status: 'done' })
    const active: TaskRecord = {
      ...baseTask({ id: 'fu', status: 'backlog' }),
      followUp: { sourceTaskId: 'src', title: 'Source', description: '', prompt: '', createdAt: NOW },
    }
    expect(canStartFollowUp(source, [source])).toBe(true)
    expect(canStartFollowUp(source, [source, active])).toBe(false)
    expect(canStartFollowUp(source, [source, { ...active, status: 'done' }])).toBe(true)
    expect(canStartFollowUp(source, [source, { ...active, status: 'done', archivedAt: NOW }])).toBe(true)
    expect(canStartFollowUp(source, [source, { ...active, status: 'failed', archivedAt: NOW }])).toBe(true)
  })

  it('refuses a source that is archived, still running or not settled', () => {
    expect(canStartFollowUp(baseTask({ id: 'src', status: 'backlog' }), [])).toBe(false)
    expect(canStartFollowUp(baseTask({ id: 'src', status: 'tested' }), [])).toBe(true)
    expect(canStartFollowUp(baseTask({ id: 'src', status: 'failed' }), [])).toBe(true)
    expect(canStartFollowUp(baseTask({ id: 'src', status: 'done', archivedAt: NOW }), [])).toBe(false)
    const running: TaskRecord = {
      ...baseTask({ id: 'src', status: 'done' }),
      executions: [{ id: 'open', sessionId: 's', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }],
    }
    expect(canStartFollowUp(running, [running])).toBe(false)
  })

  it('reads the newest conversation, falling back to the clarification chat', () => {
    expect(latestSessionIdOf(sourceTask())).toBe('session-src')
    expect(latestSessionIdOf(baseTask({ clarificationSessionId: 'session-clarify' }))).toBe('session-clarify')
    expect(latestSessionIdOf(baseTask())).toBeUndefined()
  })
})

describe('follow-up session reuse', () => {
  const followUp = baseTask({
    id: 'fu',
    followUp: { sourceTaskId: 'src', sessionId: 'session-src', title: 'Source', description: '', prompt: '', createdAt: NOW },
  })

  it('continues the source conversation on the first run', () => {
    // No roster snapshot stands between the follow-up and its source chat: the
    // framing has not been written yet, so this run is the one that lands there.
    expect(reusableSessionId(followUp)).toBe('session-src')
  })

  it('stops offering the source conversation once the framing was written', () => {
    const injected: TaskRecord = { ...followUp, followUp: { ...followUp.followUp!, injectedAt: NOW } }
    expect(reusableSessionId(injected)).toBeUndefined()
  })
})

describe('follow-up prompt framing', () => {
  const followUp = baseTask({
    id: 'fu',
    followUp: {
      sourceTaskId: 'src',
      sessionId: 'session-src',
      title: 'Alte Aufgabe',
      description: 'alte Beschreibung',
      prompt: 'alter Prompt',
      createdAt: NOW,
    },
  })

  it('names the previous task and keeps the old body out of the reused conversation', () => {
    const text = promptText(followUp, { clarification: true, continued: true })
    expect(text.startsWith('FOLLOW-UP:')).toBe(true)
    expect(text).toContain('Follow-up zum vorherigen Task „Alte Aufgabe"')
    expect(text).toContain('old prompt')
    expect(text).not.toContain('alte Beschreibung')
    expect(text).not.toContain('alter Prompt')
  })

  it('repeats the frame with the frozen source text when a fresh session is needed', () => {
    const text = promptText({ ...followUp, followUp: { ...followUp.followUp!, injectedAt: NOW } })
    expect(text.startsWith('FOLLOW-UP:')).toBe(true)
    expect(text).toContain('Hinweis: Die vorherige Session ist nicht mehr verfügbar')
    expect(text).toContain('alte Beschreibung')
    expect(text).toContain('alter Prompt')
  })

  it('leaves a continued, already framed conversation alone', () => {
    const text = promptText({ ...followUp, followUp: { ...followUp.followUp!, injectedAt: NOW } }, { continued: true })
    expect(text).not.toContain('FOLLOW-UP:')
  })

  it('never adds the frame to an ordinary card', () => {
    expect(promptText(baseTask())).not.toContain('FOLLOW-UP:')
  })
})

describe('follow-up persistence', () => {
  it('round-trips the frozen snapshot and the framing stamp', () => {
    const task = baseTask({
      id: 'fu',
      followUp: {
        sourceTaskId: 'src',
        sessionId: 'session-src',
        title: 'Source',
        description: 'old description',
        prompt: 'old prompt',
        createdAt: NOW,
        injectedAt: NOW + 1,
      },
    })
    const [parsed] = parseLedger(JSON.stringify([task]))
    expect(parsed.followUp).toEqual(task.followUp)
  })

  it('drops a malformed follow-up field instead of the card', () => {
    const [parsed] = parseLedger(JSON.stringify([{
      ...baseTask({ id: 'fu' }),
      followUp: { sourceTaskId: 'src', title: 42 },
    }]))
    expect(parsed.id).toBe('fu')
    expect(parsed.followUp).toBeUndefined()
  })
})

describe('follow-up protocol gate', () => {
  const envelope = (input: Record<string, unknown>) => ({
    requestId: 'r-1',
    action: { kind: 'create', id: 'fu', input: { title: 't', description: '', prompt: '', ...input } },
  })

  it('accepts a follow-up source id', () => {
    const parsed = parseActionEnvelope(envelope({ followUpOf: 'src' }))
    expect(parsed?.action).toMatchObject({ kind: 'create', input: { followUpOf: 'src' } })
  })

  it('rejects a malformed source id and unknown fields', () => {
    expect(parseActionEnvelope(envelope({ followUpOf: 42 }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ followUpOf: '' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ followUp: { sourceTaskId: 'src' } }))).toBeUndefined()
  })
})

describe('HostTaskLedger follow-up', () => {
  it('creates a linked card with the frozen source text, its conversation and its branch', () => {
    const ledger = ledgerWith([sourceTask()])
    const created = createFollowUp(ledger, 'fu', 'src')
    expect(created.followUp).toEqual({
      sourceTaskId: 'src',
      sessionId: 'session-src',
      title: 'Source',
      description: 'old description',
      prompt: 'old prompt',
      createdAt: NOW,
    })
    expect(created.git).toEqual({
      branch: 'task/src',
      base: 'main',
      repoPath: '/repo',
      worktreePath: '/repo/worktrees/src',
    })
    expect(created.reuseSession).toBe(true)
    expect(created.status).toBe('backlog')
    // The source is untouched (no reverse field), it is only locked by the
    // derived scan.
    const source = ledger.state().tasks.find(task => task.id === 'src')!
    expect(source.followUp).toBeUndefined()
    expect(hasFollowUpLock(source, ledger.state().tasks)).toBe(true)
  })

  it('refuses a source that is not settled, archived, already followed or busy', () => {
    const ledger = ledgerWith([
      baseTask({ id: 'backlog', status: 'backlog' }),
      baseTask({ id: 'archived', status: 'done', archivedAt: NOW }),
      sourceTask({ id: 'busy', executions: [{ id: 'open', sessionId: 's', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }] }),
      sourceTask({ id: 'src' }),
    ])
    expect(() => createFollowUp(ledger, 'f1', 'backlog')).toThrow(/done, tested or failed/)
    expect(() => createFollowUp(ledger, 'f2', 'archived')).toThrow(/archived/)
    expect(() => createFollowUp(ledger, 'f3', 'busy')).toThrow(/open run/)
    expect(() => createFollowUp(ledger, 'f4', 'missing')).toThrow(/not found/)
    createFollowUp(ledger, 'f5', 'src')
    expect(() => createFollowUp(ledger, 'f6', 'src')).toThrow(/unfinished follow-up/)
  })

  it('stamps the framing only when asked, and never twice', () => {
    const ledger = ledgerWith([sourceTask()])
    createFollowUp(ledger, 'fu', 'src')
    expect(ledger.state().tasks.find(task => task.id === 'fu')!.followUp?.injectedAt).toBeUndefined()
    ledger.markFollowUpInjected('fu')
    expect(ledger.state().tasks.find(task => task.id === 'fu')!.followUp?.injectedAt).toBe(NOW)
    const revision = ledger.state().revision
    ledger.markFollowUpInjected('fu')
    expect(ledger.state().revision).toBe(revision)
  })

  it('locks the source against runs and the merge release', () => {
    const ledger = ledgerWith([sourceTask({ id: 'src' })])
    createFollowUp(ledger, 'fu', 'src')
    expect(() => ledger.applyRequest('run-src', { kind: 'run', taskId: 'src' })).toThrow(/source of a follow-up/)
    expect(() => ledger.applyRequest('rerun-src', { kind: 'rerun', taskId: 'src' })).toThrow(/source of a follow-up/)

    const tested = sourceTask({ id: 'src2', status: 'tested', merge: undefined })
    const testedLedger = ledgerWith([tested])
    createFollowUp(testedLedger, 'fu2', 'src2')
    expect(() => testedLedger.applyRequest('move-run', { kind: 'move', taskId: 'src2', status: 'running' })).toThrow(/source of a follow-up/)
    expect(() => testedLedger.applyRequest('release', { kind: 'approve-merge', taskId: 'src2' })).toThrow(/source of a follow-up/)
    // A plain move that starts nothing stays allowed.
    expect(() => testedLedger.applyRequest('move-clarify', { kind: 'move', taskId: 'src2', status: 'clarification' })).not.toThrow()
  })

  it('protects the shared worktree while a follow-up is live and releases it with the last owner', async () => {
    const released: string[] = []
    const git = {
      releaseWorktree: vi.fn(async (task: TaskRecord) => { released.push(task.id); return undefined }),
    } as unknown as GitWorkflow
    const ledger = ledgerWith([sourceTask()], { git })
    createFollowUp(ledger, 'fu', 'src')

    ledger.applyRequest('archive-src', { kind: 'archive', taskId: 'src' })
    await ledger.awaitCard('src')
    expect(released).not.toContain('src')

    ledger.applyRequest('archive-fu', { kind: 'archive', taskId: 'fu' })
    await ledger.awaitCard('fu')
    expect(released).toContain('fu')
  })

  it('refuses to delete a source while a live follow-up exists', () => {
    const ledger = ledgerWith([sourceTask()])
    createFollowUp(ledger, 'fu', 'src')
    expect(() => ledger.applyRequest('delete-src', { kind: 'delete', taskId: 'src' })).toThrow(/live follow-up/)
    expect(() => ledger.applyRequest('delete-fu', { kind: 'delete', taskId: 'fu' })).not.toThrow()
    expect(() => ledger.applyRequest('delete-src-2', { kind: 'delete', taskId: 'src' })).not.toThrow()
  })

  it('frees the source for a second follow-up once the first one reached done', () => {
    const ledger = ledgerWith([sourceTask()])
    createFollowUp(ledger, 'fu', 'src')
    expect(() => ledger.applyRequest('move-done', { kind: 'move', taskId: 'fu', status: 'done' })).not.toThrow()
    expect(() => createFollowUp(ledger, 'fu2', 'src')).not.toThrow()
  })

  it('keeps the source out of the conversation watchers once a follow-up owns its session', () => {
    const ledger = ledgerWith([sourceTask({ id: 'src', status: 'tested' })])
    // The settled source is normally a rework/stop candidate...
    expect(ledger.reworkWatch().some(entry => entry.taskId === 'src')).toBe(true)
    expect(ledger.sessionWatch().some(row => row.taskId === 'src')).toBe(true)
    createFollowUp(ledger, 'fu', 'src')
    // ...but its conversation now belongs to the follow-up: reading a human
    // turn there as the source's rework, or stopping it as an orphan, would
    // fight the follow-up's own run.
    expect(ledger.reworkWatch().some(entry => entry.taskId === 'src')).toBe(false)
    expect(ledger.sessionWatch().some(row => row.taskId === 'src')).toBe(false)
  })

  it('refuses the manual test start on a locked source', () => {
    const ledger = ledgerWith([sourceTask({ id: 'src', status: 'done' })])
    createFollowUp(ledger, 'fu', 'src')
    expect(() => ledger.applyRequest('src-testing', { kind: 'move', taskId: 'src', status: 'testing' })).not.toThrow()
    expect(() => ledger.applyRequest('src-start-test', { kind: 'start-test', taskId: 'src' })).toThrow(/source of a follow-up/)
  })
})
