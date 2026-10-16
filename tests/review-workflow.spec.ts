/**
 * The review workflow itself: which directory a card is reviewed in, which of
 * the two ways (compose file or configured commands) is used, what a start
 * records, and that the commands really run in the card's directory with the
 * assigned ports. The compose integration is faked (its own tests cover the
 * argv); the commands are faked too, so no test process is ever started.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { ReviewWorkflow, pickCodeWorkspace, type ReviewCommandRunner } from '../src/review-workflow.ts'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function card(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Card', description: '', prompt: 'p' }, 0, 'card-1'), ...overrides }
}

/** A command runner that never runs anything and answers with success. */
function fakeRunner(): ReviewCommandRunner & { calls: Array<{ command: string; cwd: string; env: Record<string, string> }> } {
  const calls: Array<{ command: string; cwd: string; env: Record<string, string> }> = []
  const runner = (async (command: string, options: { cwd: string; env: Record<string, string> }) => {
    calls.push({ command, cwd: options.cwd, env: options.env })
    return { code: 0, stdout: 'ok', stderr: '' }
  }) as unknown as ReviewCommandRunner & { calls: typeof calls }
  runner.calls = calls
  return runner
}

function workflow(options: {
  dir: string
  environments?: unknown
  compose?: { file?: string; logs?: boolean; up?: () => Promise<{ project: string; file: string; startedAt?: number; ports?: string[]; env?: Record<string, string> } | undefined>; down?: (project: string, dir: string, o?: { context?: string }) => Promise<void> }
  registry?: TaskBoardWorkspaceRegistry
  runCommand?: ReviewCommandRunner
  launchApp?: (command: string, args: readonly string[]) => Promise<void>
}): ReviewWorkflow {
  const compose = {
    ...(options.compose?.file === undefined ? {} : { fileFor: () => ({ dir: options.dir, file: options.compose!.file! }) }),
    ...(options.compose?.logs === true ? { logs: async () => 'compose logs' } : {}),
    up: options.compose?.up ?? (async () => undefined),
    down: options.compose?.down ?? (async () => {}),
  }
  const wf = new ReviewWorkflow({
    compose,
    ...(options.registry === undefined ? {} : { workspaceRegistry: options.registry }),
    runCommand: options.runCommand ?? fakeRunner(),
    runFixed: async () => ({ code: 0, stdout: ' app.py | 4 ++\n', stderr: '' }),
    launchApp: options.launchApp ?? (async () => {}),
    now: () => 1_700_000_000_000,
  })
  wf.configure(options.environments)
  return wf
}

describe('ReviewWorkflow.plan', () => {
  it('names the card worktree and the configured commands', () => {
    const repo = tempDir('review-repo-')
    const worktree = tempDir('review-worktree-')
    writeFileSync(join(worktree, 'myproj.code-workspace'), '{}')
    const wf = workflow({ dir: worktree, environments: [{ path: repo, start: './start.sh', url: 'http://127.0.0.1:{port}' }] })
    const plan = wf.plan(card({ git: { branch: 'task/x-1', base: 'main', repoPath: repo, worktreePath: worktree } }))
    expect(plan).toMatchObject({ dir: worktree, worktree: true, available: true, logs: false })
    expect(plan.workspaceFile).toBe(join(worktree, 'myproj.code-workspace'))
  })

  it('falls back to the main checkout and says so', () => {
    const repo = tempDir('review-repo-')
    const wf = workflow({ dir: repo, environments: [{ path: repo, start: './start.sh' }] })
    const plan = wf.plan(card({ git: { branch: 'task/x-1', base: 'main', repoPath: repo } }))
    expect(plan.dir).toBe(repo)
    expect(plan.worktree).toBe(false)
  })

  it('resolves a card without git state through the workspace registry', () => {
    const repo = tempDir('review-repo-')
    const registry = { list: () => [{ id: 'ws-1', path: repo }] } as unknown as TaskBoardWorkspaceRegistry
    const wf = workflow({ dir: repo, environments: [{ path: repo, logs: 'tail -f app.log' }], registry })
    const plan = wf.plan(card({ workspaceId: 'ws-1' }))
    expect(plan.dir).toBe(repo)
    // Only a logs command, no start: nothing to launch, nothing to stop.
    expect(plan).toMatchObject({ available: false, logs: true })
  })

  it('offers nothing when no directory exists', () => {
    const wf = workflow({ dir: tempDir('review-repo-'), environments: [{ path: '/nope', start: 'x' }] })
    expect(wf.plan(card({ git: { branch: 'b', base: 'main', repoPath: '/does/not/exist' } }))).toEqual({ available: false, logs: false })
  })

  it('lets a compose file take precedence over configured commands', () => {
    const repo = tempDir('review-repo-')
    writeFileSync(join(repo, 'docker-compose.yml'), 'services: {}\n')
    const wf = workflow({ dir: repo, environments: [{ path: repo, start: './start.sh' }], compose: { file: join(repo, 'docker-compose.yml'), logs: true } })
    expect(wf.plan(card({ git: { branch: 'b', base: 'main', repoPath: repo } }))).toMatchObject({ available: true, logs: true })
    expect(wf.describe(card({ git: { branch: 'b', base: 'main', repoPath: repo } }))?.mode).toBe('compose')
  })
})

describe('ReviewWorkflow.start / stop / logs', () => {
  it('runs the configured commands in the card directory with the assigned port', async () => {
    const repo = tempDir('review-repo-')
    const runner = fakeRunner()
    const wf = workflow({
      dir: repo,
      environments: [{ path: repo, env: 'PORT={port}', start: './start.sh', stop: './start.sh --stop', logs: 'tail -n 5 data/server.log', url: 'http://127.0.0.1:{port}' }],
      runCommand: runner,
    })
    const task = card({ git: { branch: 'b', base: 'main', repoPath: repo } })
    const review = await wf.start(task)
    expect(review).toMatchObject({ mode: 'command', source: repo, dir: repo, startedAt: 1_700_000_000_000 })
    expect(review.env?.DSH_COMPOSE_PORT).toBeDefined()
    expect(review.links).toEqual([`http://127.0.0.1:${review.env!.DSH_COMPOSE_PORT}`])
    expect(runner.calls[0]).toMatchObject({ command: './start.sh', cwd: repo })
    expect(runner.calls[0]!.env.PORT).toBe(review.env!.DSH_COMPOSE_PORT)

    await wf.stop('card-1', review)
    expect(runner.calls[1]).toMatchObject({ command: './start.sh --stop', cwd: repo })
    // The stop runs in the very environment the start used: the card's port.
    expect(runner.calls[1]!.env.PORT).toBe(review.env!.DSH_COMPOSE_PORT)

    expect(await wf.logs('card-1', review)).toBe('ok')
    expect(runner.calls[2]!.command).toBe('tail -n 5 data/server.log')
  })

  it('keeps the assigned port across a re-start', async () => {
    const repo = tempDir('review-repo-')
    const runner = fakeRunner()
    const wf = workflow({ dir: repo, environments: [{ path: repo, env: 'PORT={port}', start: './start.sh' }], runCommand: runner })
    const task = card({ git: { branch: 'b', base: 'main', repoPath: repo } })
    const first = await wf.start(task)
    const again = await wf.start(card({ git: { branch: 'b', base: 'main', repoPath: repo }, review: { ...first, startedAt: undefined } }))
    expect(again.env).toEqual(first.env)
  })

  it('reports a failing start with the command\'s own output', async () => {
    const repo = tempDir('review-repo-')
    const wf = workflow({
      dir: repo,
      environments: [{ path: repo, start: './start.sh' }],
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'port 8090 is taken' }),
    })
    await expect(wf.start(card({ git: { branch: 'b', base: 'main', repoPath: repo } })))
      .rejects.toThrow(/review start failed: port 8090 is taken/)
  })

  it('starts and stops the card\'s own compose project', async () => {
    const repo = tempDir('review-repo-')
    const down = vi.fn(async () => {})
    const wf = workflow({
      dir: repo,
      environments: [{ path: repo, start: './start.sh', dockerContext: 'default', url: 'http://127.0.0.1:{port}' }],
      compose: {
        file: join(repo, 'docker-compose.yml'),
        up: async () => ({ project: 'dsh-tb-card1', file: join(repo, 'docker-compose.yml'), ports: ['web 8123->80/tcp'], env: { DSH_COMPOSE_PORT: '8123' } }),
        down,
      },
    })
    const review = await wf.start(card({ git: { branch: 'b', base: 'main', repoPath: repo } }))
    expect(review).toMatchObject({ mode: 'compose', source: 'dsh-tb-card1', context: 'default', ports: ['web 8123->80/tcp'] })
    expect(review.links).toEqual(['http://127.0.0.1:8123'])
    await wf.stop('card-1', review)
    expect(down).toHaveBeenCalledWith('dsh-tb-card1', repo, { context: 'default' })
  })

  it('refuses a card whose workspace configures nothing', async () => {
    const repo = tempDir('review-repo-')
    const wf = workflow({ dir: repo, environments: [{ path: '/elsewhere', start: './start.sh' }] })
    await expect(wf.start(card({ git: { branch: 'b', base: 'main', repoPath: repo } })))
      .rejects.toThrow(/no review environment is configured/)
    expect(wf.describe(card({ git: { branch: 'b', base: 'main', repoPath: repo } }))).toBeUndefined()
  })
})

describe('ReviewWorkflow.openInEditor / reviewDiff', () => {
  it('opens the workspace file when the directory carries one, else the directory', async () => {
    const repo = tempDir('review-repo-')
    const launched: Array<{ command: string; args: readonly string[] }> = []
    const wf = workflow({
      dir: repo,
      environments: [{ path: repo, start: './start.sh' }],
      launchApp: async (command, args) => { launched.push({ command, args }) },
    })
    const task = card({ git: { branch: 'b', base: 'main', repoPath: repo } })
    expect(await wf.openInEditor(task)).toBe(repo)
    expect(launched[0]).toEqual({ command: 'code', args: ['-n', repo] })

    writeFileSync(join(repo, 'review-repo-.code-workspace'), '{}')
    expect(await wf.openInEditor(task)).toBe(join(repo, 'review-repo-.code-workspace'))
    expect(launched[1]!.args[1]).toBe(join(repo, 'review-repo-.code-workspace'))
  })

  it('has no diff for a card that was never parked on a reviewed commit', async () => {
    const repo = tempDir('review-repo-')
    const wf = workflow({ dir: repo, environments: [] })
    expect(await wf.reviewDiff(card({ git: { branch: 'b', base: 'main', repoPath: repo } }))).toBe('')
    expect(await wf.reviewDiff(card({ git: { branch: 'b', base: 'main', repoPath: repo, reviewedCommit: 'abc123' } }))).toContain('app.py')
  })
})

describe('pickCodeWorkspace', () => {
  it('prefers the file named after the directory and ignores dotfiles', () => {
    expect(pickCodeWorkspace('/x/jobminer', ['jobminer.code-workspace', 'other.code-workspace'])).toBe('/x/jobminer/jobminer.code-workspace')
    expect(pickCodeWorkspace('/x/proj', ['.hidden.code-workspace', 'a.code-workspace'])).toBe('/x/proj/a.code-workspace')
    expect(pickCodeWorkspace('/x/proj', ['README.md'])).toBeUndefined()
  })

  it('reads the directory when no list is given', () => {
    const dir = tempDir('review-workspace-')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'proj.code-workspace'), '{}')
    expect(pickCodeWorkspace(dir)?.endsWith('proj.code-workspace')).toBe(true)
  })
})
