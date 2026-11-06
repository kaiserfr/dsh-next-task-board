/**
 * Service-level warm cache: the Host poll releases an archived card's checkout
 * and conversation only after the 3-day window and only when no card on the
 * board references them; before that, archive leaves both alone.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { WARM_RETENTION_MS } from '../src/core/warm-cache.ts'
import type { GitWorkflow } from '../src/git-workflow.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

// Service construction and the first poll are cheap, but the full suite runs many
// files in parallel: keep the generous timeout so a slow runner is not a failure.
vi.setConfig({ testTimeout: 20_000 })

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-warm-service-'))
  roots.push(root)
  return root
}

function archivedTask(worktreePath: string): TaskRecord {
  return {
    ...createTask({ title: 'Archived', description: '', prompt: '' }, NOW - 10 * DAY, 'archived'),
    status: 'done',
    archivedAt: NOW,
    executions: [{ id: 'e1', sessionId: 'session-archived', startedAt: NOW - DAY, endedAt: NOW - DAY, result: 'succeeded', error: undefined }],
    git: { branch: 'task/archived', base: 'main', repoPath: '/repo', worktreePath },
  }
}

function makeGateway(sessions: () => unknown[] = () => []) {
  const invoke = vi.fn(async (request: { namespace: string; method: string }) =>
    request.namespace === 'session' && request.method === 'list' ? { items: sessions() } : { items: [] })
  return { invoke, gateway: { invoke, stream: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })) } as unknown as TypertGateway }
}

function makeService(
  ledger: HostTaskLedger,
  options: { now: () => number; git: GitWorkflow; agent?: unknown; sessions?: () => unknown[] },
) {
  const { gateway } = makeGateway(options.sessions)
  return new TaskBoardHostService(gateway, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: options.now,
    git: options.git,
    ...(options.agent === undefined ? {} : { sessionControl: { agent: () => options.agent as never } }),
  })
}

function poll(service: TaskBoardHostService): Promise<void> {
  return (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
}

describe('warm cache (Host poll)', () => {
  it('keeps the checkout and conversation warm inside the window and releases both afterwards', async () => {
    const dir = tempRoot()
    const worktreePath = join(dir, 'worktrees', 'archived')
    mkdirSync(worktreePath, { recursive: true })
    let now = NOW
    const ledger = new HostTaskLedger(dir, () => now)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'test-seed', tasks: [archivedTask(worktreePath)] })
    // The runtime still holds the card's conversation; the release must stop it.
    const agent = { status: 'idle', cancel: vi.fn(), inbox: {} }
    // The roster still reports the archived conversation as running: the
    // watchdog must leave it alone inside the window (and not read the history
    // for it).
    let rosterRunning = true
    const released: string[] = []
    const git = {
      releaseWorktree: vi.fn(async (task: TaskRecord) => { released.push(task.id); return undefined }),
    } as unknown as GitWorkflow
    const service = makeService(ledger, {
      now: () => now,
      git,
      agent,
      sessions: () => rosterRunning ? [{ sessionId: 'session-archived', running: true, updatedAt: NOW }] : [],
    })

    // Inside the window: the poll leaves the checkout alone and does not stop
    // the conversation, even though the roster still lists it as running.
    now = NOW + WARM_RETENTION_MS - 1
    await poll(service)
    expect(released).toEqual([])
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0]!.warmReleasedAt).toBeUndefined()

    // Window passed: the card is stamped released, the worktree removal runs and
    // the conversation is stopped once.
    rosterRunning = false
    now = NOW + WARM_RETENTION_MS
    await poll(service)
    expect(ledger.state().tasks[0]!.warmReleasedAt).toBe(NOW + WARM_RETENTION_MS)
    expect(released).toEqual(['archived'])
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('never releases while a card on the board references the shared checkout', async () => {
    const dir = tempRoot()
    const worktreePath = join(dir, 'worktrees', 'shared')
    mkdirSync(worktreePath, { recursive: true })
    let now = NOW + 10 * DAY
    const ledger = new HostTaskLedger(dir, () => now)
    const liveFollowUp: TaskRecord = {
      ...createTask({ title: 'Follow-up', description: '', prompt: '' }, NOW, 'follow-up'),
      status: 'backlog',
      git: { branch: 'task/archived', base: 'main', repoPath: '/repo', worktreePath },
      followUp: {
        sourceTaskId: 'archived',
        sessionId: 'session-archived',
        title: 'Archived',
        description: '',
        prompt: '',
        createdAt: NOW,
      },
    }
    ledger.applyRequest('import', { kind: 'import', sourceId: 'test-seed', tasks: [archivedTask(worktreePath), liveFollowUp] })
    const released: string[] = []
    const git = {
      releaseWorktree: vi.fn(async (task: TaskRecord) => { released.push(task.id); return undefined }),
    } as unknown as GitWorkflow
    const service = makeService(ledger, { now: () => now, git })

    await poll(service)
    expect(released).toEqual([])
    expect(ledger.state().tasks.find(task => task.id === 'archived')!.warmReleasedAt).toBeUndefined()
    service.dispose()
  })
})
