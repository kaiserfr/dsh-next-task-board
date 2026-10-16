/**
 * The merge release as the Host service drives it: the release action is an
 * ordinary ledger action, but the conflict resolution it may open is a real run —
 * the service has to launch it with the merge framing, in the card's own
 * worktree, and settle it like any other run.
 *
 * The session runner is faked: this file pins the orchestration (which card, which
 * options, which prompt), while the git side is covered by the git-workflow suite.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitWorkflow } from '../src/git-workflow.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { promptText } from '../src/host-runner.ts'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { ComposeWorkflow } from '../src/compose-workflow.ts'

const NOW = 1_700_000_000_000
const roots: string[] = []
const hasGit = spawnSync('git', ['--version']).status === 0

afterEach(() => {
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
  const repo = tempDir('merge-service-repo-')
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'board@example.test'])
  git(repo, ['config', 'user.name', 'Task Board'])
  writeFileSync(join(repo, 'feature.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  return repo
}

describe('merge release on the Host service', () => {
  it('launches the conflict resolution as a merge run with the merge framing', async () => {
    if (!hasGit) return
    const repo = createRepo()
    const registry = { list: () => [{ id: 'ws-1', path: repo }] } as unknown as TaskBoardWorkspaceRegistry
    const gitWorkflow = new GitWorkflow(registry, { worktreesRoot: join(tempDir('merge-service-wt-'), 'wt') })
    const ledger = new HostTaskLedger(tempDir('merge-service-ledger-'), () => NOW, { git: gitWorkflow })
    const service = new TaskBoardHostService({} as unknown as TypertGateway, {
      ledger,
      git: gitWorkflow,
      workspaceRegistry: registry,
      compose: new ComposeWorkflow({ file: '' }),
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => NOW,
    })
    const launches: Array<{ taskId: string; options: Record<string, unknown> }> = []
    vi.spyOn(service.runner, 'launch').mockImplementation(async (task, options = {}) => {
      launches.push({ taskId: task.id, options: options as Record<string, unknown> })
      return 'session-merge'
    })
    vi.spyOn(service.runner, 'listRunning').mockImplementation(async () => ({ known: true, count: 0, items: [] }))
    vi.spyOn(service.runner, 'inspect').mockImplementation(async () => ({ outcome: 'pending' }))

    try {
      service.apply('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'p', workspaceId: 'ws-1' } })
      service.apply('pull', { kind: 'move', taskId: 'card', status: 'clarification' })
      const dir = ledger.state().tasks[0]!.git!.worktreePath!
      writeFileSync(join(dir, 'feature.txt'), 'branch\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-qm', 'branch work'])
      writeFileSync(join(repo, 'feature.txt'), 'main\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-qm', 'main work'])
      service.apply('park', { kind: 'move', taskId: 'card', status: 'ready_for_test' })

      const snapshot = service.apply('release', { kind: 'approve-merge', taskId: 'card' })
      const task = snapshot.tasks[0]!
      expect(task.status).toBe('running')
      expect(task.merge?.attempts).toBe(1)

      // The card's clarification run was launched by the earlier move; the
      // release adds the merge run next to it (the resolution run holds the
      // lane's WIP slot, the question round does not).
      await vi.waitFor(() => {
        expect(launches.some(entry => entry.options.merge === true)).toBe(true)
      })
      const mergeLaunch = launches.find(entry => entry.options.merge === true)!
      expect(mergeLaunch.taskId).toBe('card')
      // The run is an ordinary implementation run structurally, but it carries
      // the merge framing instead of the card body.
      expect(mergeLaunch.options.implement).toBeUndefined()
      expect(mergeLaunch.options.rework).toBeUndefined()
      expect(mergeLaunch.options.clarification).toBeUndefined()

      const prompt = promptText(task, { merge: true })
      expect(prompt).toContain('main')
      expect(prompt).toContain(task.git!.branch)
      expect(prompt).toContain('git merge --abort')
      expect(prompt).toMatch(/FERTIG:/)
    } finally {
      service.dispose()
    }
  })

  it('applies the repoSubpath setting through the service', () => {
    // Its own temporary ledger: the default one is the running Host's.
    const service = new TaskBoardHostService({} as unknown as TypertGateway, {
      ledger: new HostTaskLedger(tempDir('merge-service-ledger-'), () => NOW),
      compose: new ComposeWorkflow({ file: '' }),
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => NOW,
    })
    try {
      const errors = service.setRepoSubpaths(JSON.stringify([{ path: process.cwd(), repo: '.' }]))
      expect(errors).toEqual([])
      expect(service.setRepoSubpaths('{oops')[0]).toMatch(/not valid JSON/)
      expect(service.snapshot().reviewPlans).toEqual({})
    } finally {
      service.dispose()
    }
  })
})
