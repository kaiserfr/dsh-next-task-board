/**
 * The task environment lifecycle as the Host service drives it: the stack comes
 * up before an implementation run gets its prompt, it survives the review, and
 * it is torn down when the card leaves the run/review columns, is deleted or is
 * archived. A failed start fails the run and leaves docker's output on the card.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskCompose } from '../src/core/tasks.ts'
import { GitWorkflow } from '../src/git-workflow.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const NOW = 1_700_000_000_000
const roots: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface ComposeCalls {
  up: Array<{ id: string; dir: string | undefined }>
  down: Array<{ project: string; dir: string }>
}

const hasGit = spawnSync('git', ['--version']).status === 0

/** A temp repository with one commit, so the board really cuts a worktree. */
function createRepo(): string {
  const repo = tempDir('dsh-task-board-repo-')
  const git = (args: readonly string[]): void => {
    const result = spawnSync('git', [...args], { cwd: repo, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`)
  }
  git(['init', '-q'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['config', 'user.email', 'board@example.test'])
  git(['config', 'user.name', 'Task Board'])
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  return repo
}

/**
 * A service whose runner never touches a real session, whose compose is a spy,
 * and whose git is real: the card's worktree (the directory an environment lives
 * in) is cut by the board itself.
 */
async function harness(options: { failUp?: string } = {}) {
  const repo = createRepo()
  const workflow = new GitWorkflow({ list: () => [{ id: 'ws-1', path: repo }] } as unknown as TaskBoardWorkspaceRegistry,
    { worktreesRoot: join(tempDir('dsh-task-board-worktrees-'), 'wt') })
  const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflow })
  ledger.applyRequest('create', {
    kind: 'create',
    id: 'card',
    input: { title: 'Card', description: '', prompt: 'work', workspaceId: 'ws-1' },
  })
  // Backlog → Clarification cuts branch and worktree; that is where a task
  // environment belongs.
  ledger.applyRequest('to-clarify', { kind: 'move', taskId: 'card', status: 'clarification' })
  await ledger.awaitCard('card')
  ledger.settle('card', ledger.state().tasks[0].executions[0].id, 'succeeded')
  await ledger.awaitCard('card')
  const worktree = ledger.state().tasks[0].git!.worktreePath!

  const calls: ComposeCalls = { up: [], down: [] }
  const compose = {
    up: vi.fn(async (task: { id: string; git?: { worktreePath?: string } }): Promise<TaskCompose | undefined> => {
      calls.up.push({ id: task.id, dir: task.git?.worktreePath })
      if (options.failUp !== undefined) throw new Error(options.failUp)
      return { project: `dsh-tb-${task.id}`, file: join(worktree, 'docker-compose.yml'), startedAt: NOW, ports: ['web 8080->80/tcp'] }
    }),
    down: vi.fn(async (project: string, dir: string): Promise<void> => {
      calls.down.push({ project, dir })
    }),
  }

  const service = new TaskBoardHostService({} as unknown as TypertGateway, {
    ledger,
    compose,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
  })
  vi.spyOn(service.runner, 'launch').mockImplementation(async task => `session-${task.id}`)
  vi.spyOn(service.runner, 'listRunning').mockImplementation(async () => ({ known: true, count: 0, items: [] }))
  vi.spyOn(service.runner, 'inspect').mockImplementation(async () => ({ outcome: 'pending' }))
  vi.spyOn(service.runner, 'cancel').mockImplementation(async () => {})

  const flush = async (): Promise<void> => { await new Promise(resolve => { setTimeout(resolve, 0) }) }
  const poll = async (): Promise<void> => { await (service as unknown as { pollSessions(): Promise<void> }).pollSessions(); await flush() }
  return { ledger, service, compose, calls, worktree, flush, poll }
}

describe.skipIf(!hasGit)('task environment lifecycle', () => {
  it('brings the stack up before the run and keeps it through the review', async () => {
    const { ledger, service, calls, worktree, flush, poll } = await harness()

    await service.apply('run-card', { kind: 'run', taskId: 'card' })
    await flush()
    expect(calls.up).toEqual([{ id: 'card', dir: worktree }])
    const started = ledger.state().tasks[0]
    expect(started.status).toBe('running')
    expect(started.compose).toMatchObject({ project: 'dsh-tb-card', ports: ['web 8080->80/tcp'], startedAt: NOW })

    // The card parks in the review column: its environment stays, the human
    // still has to test against it.
    ledger.settle('card', started.executions.at(-1)!.id, 'succeeded')
    await flush()
    await poll()
    expect(ledger.state().tasks[0].status).toBe('ready_for_test')
    expect(calls.down).toEqual([])
    expect(ledger.state().tasks[0].compose?.project).toBe('dsh-tb-card')

    // Accepting the card ends the environment.
    await service.apply('done', { kind: 'move', taskId: 'card', status: 'done' })
    await ledger.awaitCard('card')
    await flush()
    await poll()
    expect(calls.down).toEqual([{ project: 'dsh-tb-card', dir: worktree }])
    expect(ledger.state().tasks[0].compose).toBeUndefined()
    service.dispose()
  })

  it('tears the stack down when the card goes back to work, is archived or deleted', async () => {
    const { ledger, service, calls, worktree, flush, poll } = await harness()
    await service.apply('run-card', { kind: 'run', taskId: 'card' })
    await flush()
    ledger.settle('card', ledger.state().tasks[0].executions.at(-1)!.id, 'succeeded')
    await flush()

    // Back to To do (a rework return): the next run brings a fresh stack up.
    await service.apply('rework', { kind: 'move', taskId: 'card', status: 'clarification' })
    await flush()
    await poll()
    expect(calls.down.map(entry => entry.project)).toEqual(['dsh-tb-card'])
    expect(ledger.state().tasks[0].compose).toBeUndefined()

    // A deleted card has no record left — the Host still owns the project.
    await service.apply('run-again', { kind: 'move', taskId: 'card', status: 'running' })
    await flush()
    expect(calls.up).toHaveLength(2)
    ledger.settle('card', ledger.state().tasks[0].executions.at(-1)!.id, 'succeeded')
    await flush()
    ledger.applyRequest('delete', { kind: 'delete', taskId: 'card' })
    await ledger.awaitCard('card')
    await poll()
    expect(calls.down).toHaveLength(2)
    expect(ledger.state().tasks).toEqual([])
    service.dispose()
  })

  it('fails the run and records the reason when the stack cannot start', async () => {
    const { ledger, service, worktree, flush } = await harness({ failUp: 'docker compose up failed for dsh-tb-card: port is already allocated' })

    await service.apply('run-card', { kind: 'run', taskId: 'card' })
    await flush()
    const task = ledger.state().tasks[0]
    // No session was created and the card carries docker's own words.
    expect(task.status).toBe('failed')
    expect(task.compose?.error).toMatch(/port is already allocated/)
    expect(task.executions.at(-1)?.result).toBe('failed')
    expect(task.executions.at(-1)?.error).toMatch(/port is already allocated/)
    service.dispose()
  })
})
