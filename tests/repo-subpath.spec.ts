/**
 * Repository discovery through `repoSubpath`: a workspace that is a container
 * folder (the repository is one directory inside it) still gets the whole git
 * flow — branch, own worktree, commit on the park, merge on the release. Real
 * temporary directories, no git mocked.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorkflow } from '../src/git-workflow.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { ReviewWorkflow } from '../src/review-workflow.ts'
import { ComposeWorkflow } from '../src/compose-workflow.ts'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'

const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()
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

/** A container directory that is NOT a repository, with a repository inside it. */
function createWorkspace(): { workspace: string; repo: string } {
  const workspace = tempDir('dsh-task-board-ws-')
  const repo = join(workspace, 'app')
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'board@example.test'])
  git(repo, ['config', 'user.name', 'Task Board'])
  writeFileSync(join(repo, 'README.md'), '# app\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  return { workspace, repo }
}

function registryFor(path: string): TaskBoardWorkspaceRegistry {
  return { list: () => [{ id: 'ws-1', path }] } as unknown as TaskBoardWorkspaceRegistry
}

describe('repoSubpath', () => {
  it('resolves the repository inside the workspace and drives the whole flow', () => {
    if (!hasGit) return
    const { workspace, repo } = createWorkspace()
    const gitWorkflow = new GitWorkflow(registryFor(workspace), { worktreesRoot: join(tempDir('dsh-task-board-wt-'), 'wt') })
    expect(gitWorkflow.configure(JSON.stringify([{ path: workspace, repo: 'app' }]))).toEqual([])
    expect(gitWorkflow.repositoryOf(workspace)).toBe(repo)

    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: gitWorkflow })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-todo', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const task = ledger.state().tasks[0]
      // The branch was cut in the repository, not in the container folder.
      expect(task.git?.repoPath).toBe(repo)
      expect(task.git?.branch).toBe('task/fix-login-card1')
      expect(task.git?.worktreePath).toBeDefined()
      expect(existsSync(task.git!.worktreePath!)).toBe(true)
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    } finally {
      ledger.dispose()
    }
  })

  it('is a no-op when no entry matches or the entry is not a repository', () => {
    if (!hasGit) return
    const { workspace } = createWorkspace()
    const workflow = new GitWorkflow(registryFor(workspace), { worktreesRoot: join(tempDir('dsh-task-board-wt-'), 'wt') })
    expect(workflow.repositoryOf(workspace)).toBeUndefined()
    workflow.configure(JSON.stringify([{ path: workspace, repo: 'nope' }]))
    expect(workflow.repositoryOf(workspace)).toBeUndefined()
    workflow.configure(JSON.stringify([{ path: workspace, repo: '.' }]))
    // "." is the workspace itself, which is not a repository either.
    expect(workflow.repositoryOf(workspace)).toBeUndefined()
  })

  it('reports invalid entries and keeps the valid ones in force', () => {
    if (!hasGit) return
    const { workspace, repo } = createWorkspace()
    const workflow = new GitWorkflow(registryFor(workspace))
    const errors = workflow.configure(JSON.stringify([
      { path: workspace, repo: 'relative-ok' },
      { path: 'not/absolute', repo: 'app' },
    ]))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/absolute/)
    expect(workflow.configurationErrors).toEqual(errors)
    // The valid entry is in force, but it names a directory that does not
    // exist: nothing is resolved rather than a guessed path.
    expect(workflow.repositoryOf(workspace)).toBeUndefined()
    expect(workflow.repositoryOf(join(workspace, 'relative-ok'))).toBeUndefined()
  })

  it('shows the repository as the card directory in the review plan', () => {
    if (!hasGit) return
    const { workspace, repo } = createWorkspace()
    const gitWorkflow = new GitWorkflow(registryFor(workspace))
    gitWorkflow.configure(JSON.stringify([{ path: workspace, repo: 'app' }]))
    const review = new ReviewWorkflow({
      compose: new ComposeWorkflow({ file: '' }),
      workspaceRegistry: registryFor(workspace),
      repoDirectory: path => gitWorkflow.repositoryOf(path),
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    // A card without git state (it never passed the clarification step) still
    // opens, starts and diffs in the repository.
    const plan = review.plan({
      id: 'card-1',
      title: 'Card',
      description: '',
      prompt: 'p',
      status: 'ready_for_test',
      createdAt: 0,
      updatedAt: 0,
      executions: [],
      workspaceId: 'ws-1',
    })
    expect(plan.dir).toBe(repo)
  })
})
