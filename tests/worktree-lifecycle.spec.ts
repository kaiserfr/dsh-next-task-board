/**
 * The card worktree's lifecycle: it is cut with the feature branch, it
 * **outlives the merge** (a done card can be reactivated, and that run needs its
 * own checkout), and it is released only when the card leaves the board —
 * archived (explicitly or by the Done-column limit) or deleted. A removal git
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
function mergedCard(ledger: HostTaskLedger, id: string, title: string): string {
  ledger.applyRequest(`create-${id}`, { kind: 'create', id, input: cardInput(title) })
  ledger.applyRequest(`pull-${id}`, { kind: 'move', taskId: id, status: 'clarification' })
  const dir = ledger.state().tasks.find(task => task.id === id)!.git!.worktreePath!
  // The reviewed work the park commits and the release merges.
  writeFileSync(join(dir, `${id}.txt`), `${id}\n`)
  ledger.applyRequest(`park-${id}`, { kind: 'move', taskId: id, status: 'ready_for_test' })
  ledger.applyRequest(`release-${id}`, { kind: 'move', taskId: id, status: 'done' })
  return dir
}

function serviceHarness(repo: string, gitWorkflow: GitWorkflow, ledger: HostTaskLedger): TaskBoardHostService {
  return new TaskBoardHostService({} as unknown as TypertGateway, {
    ledger,
    git: gitWorkflow,
    workspaceRegistry: registryFor(repo),
    compose: new ComposeWorkflow({ file: '' }),
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
  })
}

/** One Host poll's worktree reconciliation (the poll itself needs a session roster). */
function sweep(service: TaskBoardHostService): void {
  (service as unknown as { reconcileArchivedWorktrees(): void }).reconcileArchivedWorktrees()
}

describe.skipIf(!hasGit)('card worktree lifecycle', () => {
  it('releases the worktree of the card the Done-column limit archives when the next card lands', () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => NOW, { git: gitWorkflow })
    try {
      const first = mergedCard(ledger, 'card-a', 'First')
      ledger.setMaxDoneTasks(1)
      expect(existsSync(first)).toBe(true)
      // Landing the second card exceeds the Done limit, so the move itself
      // archives the first one — and that archive releases its worktree.
      const second = mergedCard(ledger, 'card-b', 'Second')
      expect(existsSync(first)).toBe(false)
      expect(existsSync(second)).toBe(true)
      expect(ledger.state().tasks.find(task => task.id === 'card-a')?.archivedAt).toBe(NOW)
    } finally {
      ledger.dispose()
    }
  })

  it('releases the worktree of cards an already over-limit Done column archives', () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => NOW, { git: gitWorkflow })
    try {
      const first = mergedCard(ledger, 'card-a', 'First')
      const second = mergedCard(ledger, 'card-b', 'Second')
      expect(existsSync(first)).toBe(true)
      expect(existsSync(second)).toBe(true)
      // Lowering the limit converges the column immediately (the Host start
      // path does the same): the oldest card is archived and released.
      ledger.setMaxDoneTasks(1)
      expect(ledger.state().tasks.find(task => task.id === 'card-a')?.archivedAt).toBe(NOW)
      expect(existsSync(first)).toBe(false)
      expect(existsSync(second)).toBe(true)
    } finally {
      ledger.dispose()
    }
  })

  it('releases the worktree of an unmerged archived card and keeps its branch', () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => NOW, { git: gitWorkflow })
    try {
      ledger.applyRequest('create', { kind: 'create', id: 'card', input: cardInput('Unmerged') })
      ledger.applyRequest('pull', { kind: 'move', taskId: 'card', status: 'clarification' })
      const task = ledger.state().tasks[0]
      const dir = task.git!.worktreePath!
      expect(existsSync(dir)).toBe(true)

      ledger.applyRequest('archive', { kind: 'archive', taskId: 'card' })
      expect(ledger.state().tasks[0].archivedAt).toBe(NOW)
      expect(existsSync(dir)).toBe(false)
      expect(git(repo, ['branch', '--list', task.git!.branch])).toContain(task.git!.branch)
    } finally {
      ledger.dispose()
    }
  })

  it('retries a refused removal on the poll and logs it once, without unlocking the worktree', () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => NOW, { git: gitWorkflow })
    const service = serviceHarness(repo, gitWorkflow, ledger)
    try {
      const dir = mergedCard(ledger, 'card-a', 'Locked')
      git(repo, ['worktree', 'lock', dir])
      // Archiving never fails because of git: the card leaves the board and the
      // directory stays for the poll to retry.
      ledger.applyRequest('archive-a', { kind: 'archive', taskId: 'card-a' })
      expect(ledger.state().tasks[0].archivedAt).toBe(NOW)
      expect(existsSync(dir)).toBe(true)

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      sweep(service)
      sweep(service)
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toContain('retrying on every poll')
      // A locked worktree is the human's: the sweep reports it, it never
      // overrides the lock.
      expect(existsSync(dir)).toBe(true)

      git(repo, ['worktree', 'unlock', dir])
      sweep(service)
      expect(existsSync(dir)).toBe(false)
    } finally {
      service.dispose()
      ledger.dispose()
    }
  })

  it('sweeps the worktree of a card archived before archiving released it', () => {
    const repo = createRepo()
    const gitWorkflow = workflowFor(repo)
    const base = createTask(cardInput('Legacy'), NOW, 'legacy')
    const legacyState = gitWorkflow.openBranch(base)!
    // A card row written by an older Host: already archived, its worktree still
    // on disk. The Host start / poll reconciles that state like any other.
    const legacy: TaskRecord = {
      ...base,
      status: 'done',
      archivedAt: NOW,
      git: legacyState,
    }
    const ledger = new HostTaskLedger(tempDir('worktree-lifecycle-ledger-'), () => NOW, { git: gitWorkflow })
    const service = serviceHarness(repo, gitWorkflow, ledger)
    try {
      ledger.applyRequest('import-legacy', { kind: 'import', sourceId: 'legacy', tasks: [legacy] })
      expect(existsSync(legacyState.worktreePath!)).toBe(true)
      sweep(service)
      expect(existsSync(legacyState.worktreePath!)).toBe(false)
    } finally {
      service.dispose()
      ledger.dispose()
    }
  })
})
