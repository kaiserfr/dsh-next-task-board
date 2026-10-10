/**
 * Git integration tests: real temporary repositories, no mocks of git itself.
 * Covers the agentic-programming flow — feature branch on backlog → todo,
 * checkout before a run, commit + merge on ready_for_test → done — and the
 * no-op behavior for workspaces that are not git worktrees.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorkflow, TASK_BRANCH_PREFIX, taskBranch } from '../src/git-workflow.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
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

/** Fresh repository on `main` with one commit and a local identity. */
function createRepo(): string {
  const repo = tempDir('dsh-task-board-repo-')
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

function boardTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' }, NOW, 'card1'), ...overrides }
}

describe.skipIf(!hasGit)('GitWorkflow', () => {
  it('resolves the repository of a pinned workspace and ignores plain directories', () => {
    const repo = createRepo()
    const plain = tempDir('dsh-task-board-plain-')
    const workflow = new GitWorkflow(registryFor(repo))
    expect(workflow.repoPath(boardTask())).toBe(repo)
    expect(workflow.repoPath({ ...boardTask(), workspaceId: undefined })).toBeUndefined()
    expect(new GitWorkflow(registryFor(plain)).repoPath(boardTask())).toBeUndefined()
    expect(new GitWorkflow().repoPath(boardTask())).toBeUndefined()
  })

  it('cuts the feature branch from the current branch on openBranch', () => {
    const repo = createRepo()
    const workflow = new GitWorkflow(registryFor(repo))
    const state = workflow.openBranch(boardTask())
    expect(state).toEqual({ branch: 'task/fix-login-card1', base: 'main', repoPath: repo })
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/fix-login-card1')
  })

  it('bases a second feature branch on main while the first is still open', () => {
    const repo = createRepo()
    const workflow = new GitWorkflow(registryFor(repo))
    workflow.openBranch(boardTask())
    const second = workflow.openBranch({ ...boardTask({ id: 'card2' }), title: 'Add cache' })
    expect(second?.base).toBe('main')
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/add-cache-card2')
  })

  it('checks the recorded feature branch out with useBranch', () => {
    const repo = createRepo()
    const workflow = new GitWorkflow(registryFor(repo))
    const state = workflow.openBranch(boardTask())!
    git(repo, ['checkout', '-q', 'main'])
    workflow.useBranch({ ...boardTask(), git: state })
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch)
    // No git state means nothing to check out.
    workflow.useBranch(boardTask())
  })

  it('commits the worktree onto the feature branch on commitBranch', () => {
    const repo = createRepo()
    const workflow = new GitWorkflow(registryFor(repo))
    const task = boardTask()
    const state = workflow.openBranch(task)!
    writeFileSync(join(repo, 'feature.txt'), 'agent output\n')
    writeFileSync(join(repo, 'untracked.txt'), 'also the agent\n')
    const committed = workflow.commitBranch({ ...task, git: state }, NOW)
    expect(committed?.committedAt).toBe(NOW)
    expect(committed?.branch).toBe(state.branch)
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch)
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe('task: Fix login')
    // A commits-once-per-park record: the whole worktree travelled, untracked
    // files included.
    expect(git(repo, ['show', '--name-only', '--pretty=', 'HEAD']).split('\n').sort())
      .toEqual(['feature.txt', 'untracked.txt'])
    // Nothing to commit: no empty commit and the previous instant stays.
    expect(workflow.commitBranch({ ...task, git: committed! }, NOW + 1)).toEqual(committed)
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('2')
  })

  it('cuts the branch first when commitBranch runs on a card without one', () => {
    const repo = createRepo()
    const workflow = new GitWorkflow(registryFor(repo))
    writeFileSync(join(repo, 'feature.txt'), 'straight to review\n')
    const committed = workflow.commitBranch(boardTask(), NOW)
    expect(committed?.branch).toBe('task/fix-login-card1')
    expect(committed?.committedAt).toBe(NOW)
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/fix-login-card1')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('commits the run output and merges the branch back on mergeBranch', () => {
    const repo = createRepo()
    const workflow = new GitWorkflow(registryFor(repo))
    const task = boardTask()
    const state = workflow.openBranch(task)!
    writeFileSync(join(repo, 'feature.txt'), 'done\n')
    const merged = workflow.mergeBranch({ ...task, git: state }, NOW)
    expect(merged?.mergedAt).toBe(NOW)
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true)
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe(`merge ${state.branch} (task board)`)
    // Already merged: a second accept is a no-op.
    expect(workflow.mergeBranch({ ...task, git: merged! }, NOW + 1)).toBeUndefined()
  })

  it('is a no-op without a repository', () => {
    const workflow = new GitWorkflow(registryFor(tempDir('dsh-task-board-plain-')))
    expect(workflow.openBranch(boardTask())).toBeUndefined()
    expect(workflow.commitBranch(boardTask(), NOW)).toBeUndefined()
    expect(workflow.mergeBranch(boardTask(), NOW)).toBeUndefined()
    workflow.useBranch(boardTask())
  })
})

describe.skipIf(!hasGit)('board git flow end to end', () => {
  it('opens a branch on todo, parks in ready_for_test, and merges on done', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      expect(ledger.state().tasks[0].status).toBe('backlog')
      expect(ledger.state().tasks[0].git).toBeUndefined()

      ledger.applyRequest('r-todo', { kind: 'move', taskId: 'card-1', status: 'todo' })
      const opened = ledger.state().tasks[0]
      expect(opened.git?.branch).toBe('task/fix-login-card1')
      expect(opened.git?.base).toBe('main')
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(opened.git!.branch)

      const run = ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' }).run
      expect(run).toBeDefined()
      expect(ledger.state().tasks[0].status).toBe('running')
      writeFileSync(join(repo, 'feature.txt'), 'agent output\n')
      ledger.settle('card-1', run!.execution.id, 'succeeded')
      const parked = ledger.state().tasks[0]
      expect(parked.status).toBe('ready_for_test')
      // The park committed: the worktree is clean while the card is reviewed,
      // and the card records when.
      expect(parked.git?.committedAt).toBe(NOW)
      expect(git(repo, ['status', '--porcelain'])).toBe('')
      expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe('task: Fix login')
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(parked.git!.branch)

      ledger.applyRequest('r-done', { kind: 'move', taskId: 'card-1', status: 'done' })
      const done = ledger.state().tasks[0]
      expect(done.status).toBe('done')
      expect(done.git?.mergedAt).toBe(NOW)
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
      expect(existsSync(join(repo, 'feature.txt'))).toBe(true)
    } finally {
      ledger.dispose()
    }
  })

  it('commits a failed and a cancelled run just the same', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      for (const [id, outcome] of [['card-fail', 'failed'], ['card-cancel', 'cancelled']] as const) {
        ledger.applyRequest(`r-create-${id}`, {
          kind: 'create',
          id,
          input: { title: `Fix ${id}`, description: '', prompt: 'p', workspaceId: 'ws-1' },
        })
        ledger.applyRequest(`r-todo-${id}`, { kind: 'move', taskId: id, status: 'todo' })
        const run = ledger.applyRequest(`r-run-${id}`, { kind: 'run', taskId: id }).run
        writeFileSync(join(repo, `work-${id}.txt`), `${outcome}\n`)
        ledger.settle(id, run!.execution.id, outcome)
        const task = ledger.state().tasks.find(entry => entry.id === id)!
        expect(task.status).toBe(outcome === 'failed' ? 'failed' : 'todo')
        expect(task.git?.committedAt).toBe(NOW)
        expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe(`task: Fix ${id}`)
      }
    } finally {
      ledger.dispose()
    }
  })

  it('does not commit a clarification round, and commits when the restart cancels a run', () => {
    const repo = createRepo()
    const dir = tempDir('dsh-task-board-ledger-')
    const ledger = new HostTaskLedger(dir, () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      // Backlog → Todo opens the branch and the clarification round.
      ledger.applyRequest('r-todo', { kind: 'move', taskId: 'card-1', status: 'todo' })
      const clarification = ledger.state().tasks[0].executions.at(-1)!
      expect(clarification.kind).toBe('clarify')
      writeFileSync(join(repo, 'question-notes.txt'), 'clarification wrote nothing to keep\n')
      ledger.settle('card-1', clarification.id, 'cancelled')
      // A clarification round implements nothing: the worktree keeps its state
      // and the card keeps its column.
      expect(ledger.state().tasks[0].git?.committedAt).toBeUndefined()
      expect(git(repo, ['status', '--porcelain'])).toContain('question-notes.txt')

      // A run interrupted before its session was recorded is cancelled on the
      // next Host start — and that cancellation commits the work.
      const run = ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' }).run
      expect(run).toBeDefined()
      writeFileSync(join(repo, 'interrupted.txt'), 'work of the interrupted run\n')
    } finally {
      ledger.dispose()
    }
    const restarted = new HostTaskLedger(dir, () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      const task = restarted.state().tasks[0]
      expect(task.status).toBe('todo')
      expect(task.executions.at(-1)?.result).toBe('cancelled')
      expect(task.git?.committedAt).toBe(NOW)
      expect(git(repo, ['status', '--porcelain'])).toBe('')
      expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe('task: Fix login')
    } finally {
      restarted.dispose()
    }
  })

  it('records a refused commit on the settled execution instead of failing the park', () => {
    const repo = createRepo()
    // A rejecting hook is the deterministic way to make `git commit` refuse.
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-todo', { kind: 'move', taskId: 'card-1', status: 'todo' })
      const run = ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' }).run
      writeFileSync(join(repo, 'feature.txt'), 'agent output\n')
      ledger.settle('card-1', run!.execution.id, 'succeeded')

      const task = ledger.state().tasks[0]
      // The park still happened; the failure is visible in the execution history.
      expect(task.status).toBe('ready_for_test')
      expect(task.git?.committedAt).toBeUndefined()
      expect(task.executions.at(-1)?.error).toMatch(/^commit failed: git commit/)
      expect(git(repo, ['status', '--porcelain'])).toContain('feature.txt')

      // The same holds for a manual drag into the review column: the move goes
      // through, the refused commit is recorded on the newest settled execution.
      ledger.applyRequest('r-back', { kind: 'move', taskId: 'card-1', status: 'todo' })
      writeFileSync(join(repo, 'second.txt'), 'more work\n')
      ledger.applyRequest('r-park-again', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      const again = ledger.state().tasks[0]
      expect(again.status).toBe('ready_for_test')
      // Two refusals are recorded, appended to one another.
      expect(again.executions.at(-1)?.error?.split('commit failed').length).toBe(3)
    } finally {
      ledger.dispose()
    }
  })

  it('opens the branch and commits when a card is dragged straight into ready_for_test', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      writeFileSync(join(repo, 'feature.txt'), 'no run at all\n')
      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      const parked = ledger.state().tasks[0]
      expect(parked.status).toBe('ready_for_test')
      expect(parked.git?.branch).toBe('task/fix-login-card1')
      expect(parked.git?.committedAt).toBe(NOW)
      expect(git(repo, ['status', '--porcelain'])).toBe('')
    } finally {
      ledger.dispose()
    }
  })

  it('opens a branch when a card is started without the todo pull', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      const run = ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' }).run
      expect(run).toBeDefined()
      const task = ledger.state().tasks[0]
      expect(task.status).toBe('running')
      expect(task.git?.branch).toBe('task/fix-login-card1')
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(task.git!.branch)
    } finally {
      ledger.dispose()
    }
  })

  it('opens a branch for a cron-triggered run too', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: new GitWorkflow(registryFor(repo)) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-schedule', {
        kind: 'set-schedule',
        taskId: 'card-1',
        patch: { enabled: true, cron: '0 9 * * *' },
      })
      expect(ledger.openScheduled('card-1', undefined, NOW)).toBeDefined()
      const task = ledger.state().tasks[0]
      expect(task.status).toBe('running')
      expect(task.git?.branch).toBe('task/fix-login-card1')
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(task.git!.branch)
    } finally {
      ledger.dispose()
    }
  })

  it('keeps the card in ready_for_test when the merge fails', () => {    const repo = createRepo()
    const workflow = new GitWorkflow(registryFor(repo))
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflow })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-todo', { kind: 'move', taskId: 'card-1', status: 'todo' })
      // A conflicting commit on main makes the merge refuse.
      writeFileSync(join(repo, 'feature.txt'), 'branch\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-qm', 'branch work'])
      git(repo, ['checkout', '-q', 'main'])
      writeFileSync(join(repo, 'feature.txt'), 'main\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-qm', 'main work'])
      git(repo, ['checkout', '-q', `task/fix-login-card1`])

      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      expect(() => ledger.applyRequest('r-done', { kind: 'move', taskId: 'card-1', status: 'done' }))
        .toThrow(/git merge/)
      expect(ledger.state().tasks[0].status).toBe('ready_for_test')
      expect(ledger.state().tasks[0].git?.mergedAt).toBeUndefined()
    } finally {
      ledger.dispose()
    }
  })
})

describe('taskBranch', () => {
  it('slugs the title and appends the id', () => {
    expect(taskBranch(boardTask())).toBe('task/fix-login-card1')
    expect(taskBranch(boardTask({ id: 'abcdef12-3456' }))).toBe('task/fix-login-abcdef12')
    expect(taskBranch(boardTask({ title: '修复登录' }))).toBe('task/card1')
    expect(taskBranch(boardTask()).startsWith(TASK_BRANCH_PREFIX)).toBe(true)
  })
})
