/**
 * Warm-cache retention of archived cards (`src/core/warm-cache.ts`): archiving
 * keeps the checkout and the conversation for 3 days, a live follow-up that
 * shares either resource keeps it alive, the window of the youngest owner is
 * what counts for a shared resource, an open run is never released under, and a
 * restored/re-archived card starts a fresh window.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { applyArchiveTask, applyRestoreTask } from '../src/core/use-cases/task-archive.ts'
import { expiredWarmTaskIds, WARM_RETENTION_MS, warmSessionIds } from '../src/core/warm-cache.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'

vi.setConfig({ testTimeout: 20_000 })

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-warm-'))
  roots.push(root)
  return root
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Task', description: '', prompt: 'do it' }, NOW - DAY, 't'), ...overrides }
}

function git(worktreePath: string): NonNullable<TaskRecord['git']> {
  return { branch: 'task/t', base: 'main', repoPath: '/repo', worktreePath }
}

function followUp(sessionId: string | undefined): NonNullable<TaskRecord['followUp']> {
  return {
    sourceTaskId: 'src',
    ...(sessionId === undefined ? {} : { sessionId }),
    title: 'Source',
    description: '',
    prompt: '',
    createdAt: NOW - DAY,
  }
}

describe('WARM_RETENTION_MS', () => {
  it('is three days', () => {
    expect(WARM_RETENTION_MS).toBe(3 * DAY)
  })
})

describe('expiredWarmTaskIds', () => {
  it('keeps an archived card warm for the full window and releases it afterwards', () => {
    const archived = task({ id: 'a', status: 'done', archivedAt: NOW, git: git('/wt/a') })
    expect(expiredWarmTaskIds([archived], NOW + WARM_RETENTION_MS - 1)).toEqual([])
    expect(expiredWarmTaskIds([archived], NOW + WARM_RETENTION_MS)).toEqual(['a'])
  })

  it('keeps a card that never had a checkout or a conversation out of the release', () => {
    const archived = task({ id: 'empty', status: 'done', archivedAt: NOW })
    expect(expiredWarmTaskIds([archived], NOW + 10 * DAY)).toEqual([])
  })

  it('keeps the resource while a card on the board still names the checkout', () => {
    const archived = task({ id: 'src', status: 'done', archivedAt: NOW, git: git('/wt/shared') })
    const live = task({ id: 'fu', status: 'backlog', git: git('/wt/shared') })
    expect(expiredWarmTaskIds([archived, live], NOW + 10 * DAY)).toEqual([])
  })

  it('keeps the conversation while a live follow-up continues it', () => {
    const source = task({
      id: 'src',
      status: 'done',
      archivedAt: NOW,
      clarificationSessionId: 'session-src',
    })
    const liveFollowUp = task({ id: 'fu', status: 'clarification', followUp: followUp('session-src') })
    expect(expiredWarmTaskIds([source, liveFollowUp], NOW + 10 * DAY)).toEqual([])
    // The source's own worktree is unprotected here (the follow-up has none);
    // the session reference alone keeps its resource group from being released.
    expect(expiredWarmTaskIds([source], NOW + 10 * DAY)).toEqual(['src'])
  })

  it('counts the youngest archive of a shared resource', () => {
    const source = task({ id: 'src', status: 'done', archivedAt: NOW, git: git('/wt/shared') })
    const followUpCard = task({
      id: 'fu',
      status: 'done',
      archivedAt: NOW + 2 * DAY,
      git: git('/wt/shared'),
      followUp: followUp('session-src'),
    })
    const sourceWithSession = { ...source, clarificationSessionId: 'session-src' }
    // The source's own window passed at NOW + 3 d, but the follow-up's archive
    // restarts it for the shared checkout and conversation.
    expect(expiredWarmTaskIds([sourceWithSession, followUpCard], NOW + 4 * DAY)).toEqual([])
    expect(expiredWarmTaskIds([sourceWithSession, followUpCard], NOW + 5 * DAY).sort()).toEqual(['fu', 'src'])
  })

  it('never releases a card whose run is still open', () => {
    const archived = task({
      id: 'open',
      status: 'done',
      archivedAt: NOW,
      git: git('/wt/open'),
      executions: [{ id: 'e1', sessionId: 's1', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }],
    })
    expect(expiredWarmTaskIds([archived], NOW + 30 * DAY)).toEqual([])
  })

  it('ignores cards that were already released', () => {
    const released = task({
      id: 'released',
      status: 'done',
      archivedAt: NOW,
      warmReleasedAt: NOW + WARM_RETENTION_MS,
      git: git('/wt/released'),
    })
    expect(expiredWarmTaskIds([released], NOW + 10 * DAY)).toEqual([])
  })
})

describe('warmSessionIds', () => {
  it('collects the clarification conversation, the newest execution and the follow-up source', () => {
    const card = task({
      id: 'card',
      clarificationSessionId: 'clarify',
      followUp: followUp('source'),
      executions: [
        { id: 'e1', sessionId: 'older', startedAt: 1, endedAt: 2, result: 'succeeded', error: undefined },
        { id: 'e2', sessionId: 'newest', startedAt: 3, endedAt: undefined, result: undefined, error: undefined },
      ],
    })
    expect(warmSessionIds(card).sort()).toEqual(['clarify', 'newest', 'source'])
  })
})

describe('archive cycle', () => {
  it('starts a fresh warm window when a restored card is archived again', () => {
    const released = task({
      id: 't',
      status: 'done',
      archivedAt: NOW - 10 * DAY,
      warmReleasedAt: NOW - 7 * DAY,
      git: git('/wt/t'),
    })
    const restored = applyRestoreTask([released], 't', NOW)
    expect(restored.tasks[0]!.archivedAt).toBeUndefined()
    expect(restored.tasks[0]!.warmReleasedAt).toBeUndefined()
    const archived = applyArchiveTask(restored.tasks, 't', NOW + 1)
    expect(archived.tasks[0]).toMatchObject({ archivedAt: NOW + 1 })
    expect(expiredWarmTaskIds(archived.tasks, NOW + DAY)).toEqual([])
    expect(expiredWarmTaskIds(archived.tasks, NOW + 1 + WARM_RETENTION_MS)).toEqual(['t'])
  })
})

describe('HostTaskLedger warm-cache projections', () => {
  function ledgerWith(tasks: readonly TaskRecord[], now: () => number = () => NOW): HostTaskLedger {
    const ledger = new HostTaskLedger(tempRoot(), now)
    ledger.applyRequest('seed', { kind: 'import', sourceId: 'test-seed', tasks: [...tasks] })
    return ledger
  }

  it('keeps the checkout until the release marker is stamped', () => {
    const worktreePath = join(tempRoot(), 'worktrees', 'a')
    mkdirSync(worktreePath, { recursive: true })
    const ledger = ledgerWith([task({ id: 'a', status: 'done', archivedAt: NOW, git: git(worktreePath) })])
    expect(ledger.archivedWorktrees()).toEqual([])
    ledger.markWarmReleased(['a'], NOW + WARM_RETENTION_MS)
    expect(ledger.archivedWorktrees().map(item => item.id)).toEqual(['a'])
    expect(ledger.state().tasks[0]!.warmReleasedAt).toBe(NOW + WARM_RETENTION_MS)
  })

  it('reports the sessions of released cards, but not one a live card references again', () => {
    const now = () => NOW
    const source = task({
      id: 'src',
      status: 'done',
      archivedAt: NOW,
      warmReleasedAt: NOW,
      clarificationSessionId: 'session-src',
    })
    const ledger = ledgerWith([source], now)
    expect(ledger.releasedWarmSessions()).toEqual(['session-src'])
    // A restored card (or a new follow-up) references the conversation again:
    // the poll must not stop what the board is using.
    ledger.applyRequest('restore', { kind: 'restore', taskId: 'src' })
    expect(ledger.releasedWarmSessions()).toEqual([])
  })

  it('releases an archived card only after the window and without live references', () => {
    let now = NOW
    const ledger = ledgerWith(
      [task({ id: 'a', status: 'done', archivedAt: NOW, git: git('/wt/a') })],
      () => now,
    )
    expect(ledger.expiredWarmTaskIds()).toEqual([])
    now = NOW + 2 * DAY
    expect(ledger.expiredWarmTaskIds()).toEqual([])
    now = NOW + WARM_RETENTION_MS
    expect(ledger.expiredWarmTaskIds()).toEqual(['a'])
  })
})
