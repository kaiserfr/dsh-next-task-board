import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = new Date(2026, 10, 3, 10, 0, 0).getTime()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-follow-up-service-'))
  roots.push(root)
  return root
}

type GatewayRequest = { namespace: string; method: string; args: Record<string, unknown> }

function sourceTask(): TaskRecord {
  return {
    ...createTask({ title: 'Alte Aufgabe', description: 'alte Beschreibung', prompt: 'alter Prompt' }, NOW - 1000, 'src'),
    status: 'done',
    executions: [{
      id: 'exec-src',
      sessionId: 'session-src',
      startedAt: NOW - 900,
      endedAt: NOW - 800,
      result: 'succeeded',
      error: undefined,
    }],
    git: { branch: 'task/src', base: 'main', repoPath: '/repo', worktreePath: '/repo/worktrees/src' },
  }
}

describe('follow-up launch', () => {
  it('framed the first run in a fresh conversation and stamps it', async () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('seed', { kind: 'import', sourceId: 'seed', tasks: [sourceTask()] })
    ledger.applyRequest('create-fu', {
      kind: 'create',
      id: 'fu',
      input: { title: 'Follow-up: Alte Aufgabe', description: 'neu', prompt: 'behebe das', followUpOf: 'src' },
    })

    const prompts: string[] = []
    const create = vi.fn(async () => ({ sessionId: 'session-fresh' }))
    const gateway = {
      invoke: vi.fn(async (request: GatewayRequest) => {
        if (request.namespace === 'session') {
          if (request.method === 'create') return create()
          if (request.method === 'rename') return { title: 'Follow-up: Alte Aufgabe', seq: 1 }
          if (request.method === 'prompt') {
            const body = request.args.request as { content?: { text?: string }[] } | undefined
            prompts.push(body?.content?.[0]?.text ?? '')
            return { accepted: true }
          }
          if (request.method === 'list') return { items: [] }
          return {}
        }
        if (request.namespace === 'agentPresets') return { presets: [] }
        return { items: [] }
      }),
      stream: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    } as unknown as TypertGateway

    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => NOW,
    })
    try {
      // Through the service's action lane, which schedules the opened
      // clarification run (a direct ledger call would bypass it).
      service.acceptAction('to-clarify', { kind: 'move', taskId: 'fu', status: 'clarification' })
      // The launch queue starts asynchronously from the ledger subscription.
      const deadline = Date.now() + 2000
      while (prompts.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => { setTimeout(resolve, 10) })
      }
      expect(create).toHaveBeenCalledOnce()
      expect(prompts).toHaveLength(1)
      expect(prompts[0].startsWith('FOLLOW-UP:')).toBe(true)
      expect(prompts[0]).toContain('Follow-up zum vorherigen Task „Alte Aufgabe"')
      expect(prompts[0]).toContain('Hinweis: Die vorherige Session ist nicht mehr verfügbar')
      expect(prompts[0]).toContain('alter Prompt')
      const followUp = ledger.state().tasks.find(task => task.id === 'fu')
      expect(followUp?.followUp?.injectedAt).toBe(NOW)
      expect(followUp?.clarificationSessionId).toBe('session-fresh')
    } finally {
      service.dispose()
    }
  })

  it('continues the source conversation when it is idle and does not repeat its text', async () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('seed', { kind: 'import', sourceId: 'seed', tasks: [sourceTask()] })
    ledger.applyRequest('create-fu', {
      kind: 'create',
      id: 'fu',
      input: { title: 'Follow-up: Alte Aufgabe', description: 'neu', prompt: 'behebe das', followUpOf: 'src' },
    })

    const prompts: string[] = []
    const create = vi.fn(async () => ({ sessionId: 'session-fresh' }))
    const gateway = {
      invoke: vi.fn(async (request: GatewayRequest) => {
        if (request.namespace === 'session') {
          if (request.method === 'list') return { items: [{ sessionId: 'session-src', running: false }] }
          if (request.method === 'create') return create()
          if (request.method === 'rename') return { title: 'Follow-up: Alte Aufgabe', seq: 1 }
          if (request.method === 'prompt') {
            const body = request.args.request as { content?: { text?: string }[] } | undefined
            prompts.push(body?.content?.[0]?.text ?? '')
            return { accepted: true }
          }
          return {}
        }
        if (request.namespace === 'agentPresets') return { presets: [] }
        return { items: [] }
      }),
      stream: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    } as unknown as TypertGateway

    const service = new TaskBoardHostService(gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => NOW,
    })
    try {
      // Teach the service the roster first: the source conversation must be
      // known to be present and idle for the reuse rule to pick it.
      await (service as unknown as { pollSessions(): Promise<void> }).pollSessions()
      service.acceptAction('to-clarify', { kind: 'move', taskId: 'fu', status: 'clarification' })
      const deadline = Date.now() + 2000
      while (prompts.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => { setTimeout(resolve, 10) })
      }
      expect(create).not.toHaveBeenCalled()
      expect(prompts).toHaveLength(1)
      expect(prompts[0].startsWith('FOLLOW-UP:')).toBe(true)
      expect(prompts[0]).not.toContain('Hinweis: Die vorherige Session ist nicht mehr verfügbar')
      expect(prompts[0]).not.toContain('alter Prompt')
      const followUp = ledger.state().tasks.find(task => task.id === 'fu')
      expect(followUp?.followUp?.injectedAt).toBe(NOW)
      expect(followUp?.clarificationSessionId).toBe('session-src')
    } finally {
      service.dispose()
    }
  })
})
