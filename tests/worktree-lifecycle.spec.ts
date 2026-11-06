/**
 * The card worktree's lifecycle: it is cut with the feature branch, it
 * **outlives the merge** (a done card can be reactivated, and that run needs its
 * own checkout), and archiving keeps it **warm** for the retention window. Only
 * after that window — and with no card on the board referencing it — does the
 * Host poll release it; deleting the card releases it at once. A removal git
 * refuses is retried by the Host poll, which logs it once and never unlocks a
 * worktree behind the human's back.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { WARM_RETENTION_MS } from '../src/core/warm-cache.ts'
import { GitWorkflow } from '../src/git-workflow.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { ComposeWorkflow } from '../src/compose-workflow.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'

const NOW = 1_700_000_000_000
const roots: string[] = []
const hasGit = spawnSync('git', ['--version']).status === 0

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function createRepo(): string {
  const repo = tempDir('worktree-lifecycle-repo-')
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'board@example.test'])
  git(repo, ['config', 'user.name', 'Task Board'])
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  return repo
}

function registryFor(path: string): TaskBoardWorkspaceRegistry {
  return { list: () => [{ id: 'ws-1', path }] } as unknown as TaskBoardWorkspaceRegistry
}

function workflowFor(repo: string): GitWorkflow {
  return new GitWorkflow(registryFor(repo), { worktreesRoot: join(tempDir('worktree-lifecycle-wt-'), 'wt') })
}

function cardInput(title: string) {
  return { title, description: '', prompt: 'p', workspaceId: 'ws-1' }
}

/**
 * One card all the way onto Done: the clarification pull cuts its worktree, the
 * park commits onto the feature branch, the release merges that branch back.
 */
async function mergedCard(ledger: HostTaskLedger, id: string, title: string): Promise<string> {
  ledger.applyRequest(`create-${id}`, { kind: 'create', id, input: cardInput(title) })
  ledger.applyRequest(`pull-${id}`, { kind: 'move', taskId: id, status: 'clarification' })
  await ledger.awaitCard(id)
  // The clarification round is a real (here session-less) run: settle it, so the
  // archived card later has no open execution that would keep its checkout warm.
  const clarify = ledger.state().tasks.find(task => task.id === id)!.executions.find(execution => execution.endedAt === undefined)
  if (clarify !== undefined) ledger.settle(id, clarify.id, 'succeeded')
  const dir = ledger.state().tasks.find(task => task.id === id)!.git!.worktreePath!
  // The reviewed work the park commits and the release merges.
  writeFileSync(join(dir, `${id}.txt`), `${id}\n`)
  ledger.applyRequest(`park-${id}`, { kind: 'move', taskId: id, status: 'testing' })
  await ledger.awaitCard(id)
  // The merge gate is `tested`; this card is parked by hand (no test run).
  ledger.applyRequest(`tested-${id}`, { kind: 'move', taskId: id, status: 'tested' })
  await ledger.awaitCard(id)
  ledger.applyRequest(`release-${id}`, { kind: 'move', taskId: id, status: 'done' })
  await ledger.awaitCard(id)
  return dir
}

function serviceHarness(
  repo: string,
  gitWorkflow: GitWorkflow,
  ledger: HostTaskLedger,
  now: () => number = () => NOW,
): TaskBoardHostService {
  return new TaskBoardHostService({} as unknown as TypertGateway, {
    ledger,
    git: gitWorkflow,
    workspaceRegistry: registryFor(repo),
    compose: new ComposeWorkflow({ file: '' }),
    power: new PowerInhibitor({ platform: 'linux' }),
    now,
  })
}

/** One Host poll's warm-cache reconciliation (the poll itself needs a session roster). */
async function sweep(service: TaskBoardHostService): Promise<void> {
  await (service as unknown as { reconcileWarmCache(): Promise<void> }).reconcileWarmCache()
  await (service as unknown as { reconcileArchivedWorktrees(): Promise<void> }).reconcileArchivedWorktrees()
}

describe.skipIf(!hasGit)('card worktree lifecycle', () => {
  it('keeps the worktree of the card the Done-column limit archives warm, then releases it', async () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const clock = { now: NOW }
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => clock.now, { git: gitWorkflow })
    const service = serviceHarness(repo, gitWorkflow, ledger, () => clock.now)
    try {
      const first = await mergedCard(ledger, 'card-a', 'First')
      ledger.setMaxDoneTasks(1)
      expect(existsSync(first)).toBe(true)
      // Landing the second card exceeds the Done limit and archives the first —
      // but archiving is not a disposal any more: the checkout stays warm.
      const second = await mergedCard(ledger, 'card-b', 'Second')
      await ledger.awaitCard('card-a')
      expect(ledger.state().tasks.find(task => task.id === 'card-a')?.archivedAt).toBe(NOW)
      expect(existsSync(first)).toBe(true)
      expect(existsSync(second)).toBe(true)

      clock.now = NOW + WARM_RETENTION_MS
      await sweep(service)
      expect(existsSync(first)).toBe(false)
      expect(existsSync(second)).toBe(true)
    } finally {
      service.dispose()
      ledger.dispose()
    }
  }, 20_000)

  it('keeps the worktree of cards an already over-limit Done column archives warm, then releases it', async () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const clock = { now: NOW }
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => clock.now, { git: gitWorkflow })
    const service = serviceHarness(repo, gitWorkflow, ledger, () => clock.now)
    try {
      const first = await mergedCard(ledger, 'card-a', 'First')
      const second = await mergedCard(ledger, 'card-b', 'Second')
      expect(existsSync(first)).toBe(true)
      expect(existsSync(second)).toBe(true)
      // Lowering the limit converges the column immediately (the Host start
      // path does the same): the oldest card is archived but stays warm.
      ledger.setMaxDoneTasks(1)
      await ledger.awaitCard('card-a')
      expect(ledger.state().tasks.find(task => task.id === 'card-a')?.archivedAt).toBe(NOW)
      expect(existsSync(first)).toBe(true)
      expect(existsSync(second)).toBe(true)

      clock.now = NOW + WARM_RETENTION_MS
      await sweep(service)
      expect(existsSync(first)).toBe(false)
      expect(existsSync(second)).toBe(true)
    } finally {
      service.dispose()
      ledger.dispose()
    }
  }, 20_000)

  it('keeps the worktree of an unmerged archived card warm and keeps its branch', async () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const clock = { now: NOW }
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => clock.now, { git: gitWorkflow })
    const service = serviceHarness(repo, gitWorkflow, ledger, () => clock.now)
    try {
      ledger.applyRequest('create', { kind: 'create', id: 'card', input: cardInput('Unmerged') })
      ledger.applyRequest('pull', { kind: 'move', taskId: 'card', status: 'clarification' })
      await ledger.awaitCard('card')
      const clarify = ledger.state().tasks[0].executions.find(execution => execution.endedAt === undefined)
      if (clarify !== undefined) ledger.settle('card', clarify.id, 'succeeded')
      const task = ledger.state().tasks[0]
      const dir = task.git!.worktreePath!
      expect(existsSync(dir)).toBe(true)

      ledger.applyRequest('archive', { kind: 'archive', taskId: 'card' })
      await ledger.awaitCard('card')
      expect(ledger.state().tasks[0].archivedAt).toBe(NOW)
      expect(existsSync(dir)).toBe(true)
      expect(git(repo, ['branch', '--list', task.git!.branch])).toContain(task.git!.branch)

      clock.now = NOW + WARM_RETENTION_MS
      await sweep(service)
      expect(existsSync(dir)).toBe(false)
      expect(git(repo, ['branch', '--list', task.git!.branch])).toContain(task.git!.branch)
    } finally {
      service.dispose()
      ledger.dispose()
    }
  }, 20_000)

  it('retries a refused removal on the poll and logs it once, without unlocking the worktree', async () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const clock = { now: NOW }
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => clock.now, { git: gitWorkflow })
    const service = serviceHarness(repo, gitWorkflow, ledger, () => clock.now)
    try {
      const dir = await mergedCard(ledger, 'card-a', 'Locked')
      git(repo, ['worktree', 'lock', dir])
      // Archiving never fails because of git, and the warm window keeps the
      // directory even after it: the removal only starts once it expired.
      ledger.applyRequest('archive-a', { kind: 'archive', taskId: 'card-a' })
      await ledger.awaitCard('card-a')
      expect(ledger.state().tasks[0].archivedAt).toBe(NOW)
      expect(existsSync(dir)).toBe(true)
      clock.now = NOW + WARM_RETENTION_MS

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await sweep(service)
      await sweep(service)
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toContain('retrying on every poll')
      // A locked worktree is the human's: the sweep reports it, it never
      // overrides the lock.
      expect(existsSync(dir)).toBe(true)

      git(repo, ['worktree', 'unlock', dir])
      await sweep(service)
      expect(existsSync(dir)).toBe(false)
    } finally {
      service.dispose()
      ledger.dispose()
    }
  }, 20_000)

  it('sweeps the worktree of a card archived before the warm cache existed', async () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const base = createTask(cardInput('Legacy'), NOW, 'legacy')
    const legacyState = (await gitWorkflow.openBranch(base))!
    // A card row written by an older Host: archived long ago, its worktree still
    // on disk. The Host start / poll reconciles that state like any other.
    const legacy: TaskRecord = {
      ...base,
      status: 'done',
      archivedAt: NOW - 4 * 24 * 60 * 60 * 1000,
      git: legacyState,
    }
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => NOW, { git: gitWorkflow })
    const service = serviceHarness(repo, gitWorkflow, ledger)
    try {
      ledger.applyRequest('import-legacy', { kind: 'import', sourceId: 'legacy', tasks: [legacy] })
      expect(existsSync(legacyState.worktreePath!)).toBe(true)
      await sweep(service)
      expect(existsSync(legacyState.worktreePath!)).toBe(false)
    } finally {
      service.dispose()
      ledger.dispose()
    }
  }, 20_000)
})
