/**
 * Git integration tests: real temporary repositories, no mocks of git itself.
 * Covers the agentic-programming flow — feature branch on backlog → todo,
 * checkout before a run, commit + merge on ready_for_test → done — and the
 * no-op behavior for workspaces that are not git worktrees.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

/** A workflow whose card worktrees stay inside the test's temp tree. */
function workflowFor(repo: string): GitWorkflow {
  return new GitWorkflow(registryFor(repo), { worktreesRoot: join(tempDir('dsh-task-board-worktrees-'), 'wt') })
}

/**
 * The directory a card's run works in: its own worktree when it has one, else
 * the main checkout (the legacy path and the no-repository case).
 */
function cardDir(ledger: HostTaskLedger, repo: string, id = 'card-1'): string {
  return ledger.state().tasks.find(task => task.id === id)?.git?.worktreePath ?? repo
}

function boardTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' }, NOW, 'card1'), ...overrides }
}

describe.skipIf(!hasGit)('GitWorkflow', () => {
  it('resolves the repository of a pinned workspace and ignores plain directories', () => {
    const repo = createRepo()
    const plain = tempDir('dsh-task-board-plain-')
    const workflow = workflowFor(repo)
    expect(workflow.repoPath(boardTask())).toBe(repo)
    expect(workflow.repoPath({ ...boardTask(), workspaceId: undefined })).toBeUndefined()
    expect(new GitWorkflow(registryFor(plain)).repoPath(boardTask())).toBeUndefined()
    expect(new GitWorkflow().repoPath(boardTask())).toBeUndefined()
  })

  it('cuts the feature branch and the card worktree on openBranch', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const state = workflow.openBranch(boardTask())!
    expect(state.branch).toBe('task/fix-login-card1')
    expect(state.base).toBe('main')
    expect(state.repoPath).toBe(repo)
    // The card works in its own directory; the main checkout stays where the
    // human left it (`main`).
    expect(state.worktreePath).toBeDefined()
    expect(existsSync(state.worktreePath!)).toBe(true)
    expect(git(state.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/fix-login-card1')
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  it('bases a second feature branch on main while the first is still open', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const first = workflow.openBranch(boardTask())!
    const second = workflow.openBranch({ ...boardTask({ id: 'card2' }), title: 'Add cache' })!
    expect(second?.base).toBe('main')
    expect(git(second.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/add-cache-card2')
    // Two cards of one workspace: two directories, one main checkout untouched.
    expect(first.worktreePath).not.toBe(second.worktreePath)
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  it('does not touch a card worktree in useBranch, and checks the main checkout out for a legacy card', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const state = workflow.openBranch(boardTask())!
    // A card with its own worktree needs no checkout: switching branches there
    // is what would yank the directory out from under a working run.
    git(state.worktreePath!, ['checkout', '-q', '-b', 'someone-else'])
    workflow.useBranch({ ...boardTask(), git: state })
    expect(git(state.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('someone-else')
    // A legacy card (branch in the main checkout) is checked out as before.
    git(repo, ['checkout', '-q', 'main'])
    workflow.useBranch({ ...boardTask({ id: 'card-legacy' }), git: { ...state, worktreePath: undefined } })
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch)
    // No git state means nothing to check out.
    workflow.useBranch(boardTask())
  })

  it('commits the card worktree onto the feature branch on commitBranch', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const task = boardTask()
    const state = workflow.openBranch(task)!
    const dir = state.worktreePath!
    writeFileSync(join(dir, 'feature.txt'), 'agent output\n')
    writeFileSync(join(dir, 'untracked.txt'), 'also the agent\n')
    const committed = workflow.commitBranch({ ...task, git: state }, NOW)
    expect(committed?.committedAt).toBe(NOW)
    expect(committed?.branch).toBe(state.branch)
    // Parking binds the review to the commit the branch now stands on.
    expect(committed?.reviewedCommit).toBe(git(dir, ['rev-parse', 'HEAD']))
    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch)
    expect(git(dir, ['status', '--porcelain'])).toBe('')
    expect(git(dir, ['log', '-1', '--pretty=%s'])).toBe('task: Fix login')
    // A commits-once-per-park record: the whole worktree travelled, untracked
    // files included. The main checkout never saw any of it.
    expect(git(dir, ['show', '--name-only', '--pretty=', 'HEAD']).split('\n').sort())
      .toEqual(['feature.txt', 'untracked.txt'])
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    // Nothing to commit: no empty commit and the previous instant stays.
    expect(workflow.commitBranch({ ...task, git: committed! }, NOW + 1)).toEqual(committed)
    expect(git(dir, ['rev-list', '--count', 'HEAD'])).toBe('2')
  })

  it('cuts the branch and the worktree first when commitBranch runs on a card without one', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    // A card pushed straight into the review column: the park opens branch and
    // worktree, and commits what that (empty) worktree holds — nothing.
    const committed = workflow.commitBranch(boardTask(), NOW)
    expect(committed?.branch).toBe('task/fix-login-card1')
    expect(committed?.worktreePath).toBeDefined()
    expect(committed?.committedAt).toBeUndefined()
    expect(git(committed!.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/fix-login-card1')
    expect(git(committed!.worktreePath!, ['status', '--porcelain'])).toBe('')
    // The card's work lives in its own directory: a file written there is what a
    // park commits.
    writeFileSync(join(committed!.worktreePath!, 'feature.txt'), 'straight to review\n')
    const again = workflow.commitBranch({ ...boardTask(), git: committed! }, NOW)!
    expect(again.committedAt).toBe(NOW)
    expect(git(again.worktreePath!, ['log', '-1', '--pretty=%s'])).toBe('task: Fix login')
  })

  it('commits the run output and merges the branch back on mergeBranch', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const task = boardTask()
    const state = workflow.openBranch(task)!
    writeFileSync(join(state.worktreePath!, 'feature.txt'), 'done\n')
    // The review park commits and stamps the head the merge is bound to.
    const parked = workflow.commitBranch({ ...task, git: state }, NOW)!
    const merged = workflow.mergeBranch({ ...task, git: parked }, NOW)
    expect(merged?.mergedAt).toBe(NOW)
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    // The merge landed in the main checkout — and the card keeps its worktree:
    // a done card can be reactivated, and that run works in its own checkout.
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true)
    expect(existsSync(state.worktreePath!)).toBe(true)
    expect(git(state.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch)
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe(`merge ${state.branch} (task board)`)
    // Already merged: a second accept is a no-op.
    expect(workflow.mergeBranch({ ...task, git: merged! }, NOW + 1)).toBeUndefined()
  })

  it('replays the branch onto the base as it stands now before it merges', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const task = boardTask()
    const state = workflow.openBranch(task)!
    writeFileSync(join(state.worktreePath!, 'feature.txt'), 'card work\n')
    const parked = workflow.commitBranch({ ...task, git: state }, NOW)!
    // Another card merged into the base while this one was under review: the
    // branch was cut from the base as it was *before* that.
    writeFileSync(join(repo, 'other.txt'), 'other card\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'other card merged'])
    const base = git(repo, ['rev-parse', 'main'])

    const merged = workflow.mergeBranch({ ...task, git: parked }, NOW)!
    expect(merged.mergedAt).toBe(NOW)
    // The card's commit now stands on the base as it is, not on the base as it
    // was when the branch was cut.
    expect(git(repo, ['rev-parse', `${state.branch}^`])).toBe(base)
    // Both sides are on the base branch, and the merge keeps its marker.
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true)
    expect(existsSync(join(repo, 'other.txt'))).toBe(true)
    expect(git(repo, ['rev-parse', 'HEAD^1'])).toBe(base)
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe(`merge ${state.branch} (task board)`)
    // Already merged: a second accept is a no-op.
    expect(workflow.mergeBranch({ ...task, git: merged }, NOW + 1)).toBeUndefined()
  })

  it('refuses to merge what the review did not see', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const task = boardTask()
    const state = workflow.openBranch(task)!
    const dir = state.worktreePath!
    writeFileSync(join(dir, 'feature.txt'), 'reviewed\n')
    const parked = workflow.commitBranch({ ...task, git: state }, NOW)!

    // Work committed after the park moved the branch past the reviewed commit.
    writeFileSync(join(dir, 'later.txt'), 'after the review\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'unreviewed work'])
    expect(() => workflow.mergeBranch({ ...task, git: parked }, NOW))
      .toThrow(/moved from the reviewed commit/)
    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch)
    expect(git(dir, ['log', '-1', '--pretty=%s'])).toBe('unreviewed work')

    // Uncommitted work is the same refusal, not a commit behind the review's
    // back: the safety-net commit is gone.
    writeFileSync(join(dir, 'dirty.txt'), 'still being written\n')
    expect(() => workflow.mergeBranch({ ...task, git: parked }, NOW))
      .toThrow(/still holds uncommitted work/)
    rmSync(join(dir, 'dirty.txt'), { force: true })
    expect(git(dir, ['log', '-1', '--pretty=%s'])).toBe('unreviewed work')
  })

  it('refuses to merge a card that was never park-reviewed', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const task = boardTask()
    // A card with a branch but no review stamp — parked before the gate existed.
    const state = workflow.openBranch(task)!
    expect(() => workflow.mergeBranch({ ...task, git: state }, NOW))
      .toThrow(/no reviewed commit/)
    expect(git(state.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch)
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
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      expect(ledger.state().tasks[0].status).toBe('backlog')
      expect(ledger.state().tasks[0].git).toBeUndefined()
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const opened = ledger.state().tasks[0]
      expect(opened.git?.branch).toBe('task/fix-login-card1')
      expect(opened.git?.base).toBe('main')
      // The card owns a worktree; the main checkout is untouched.
      const dir = opened.git!.worktreePath!
      expect(existsSync(dir)).toBe(true)
      expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(opened.git!.branch)
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')

      const run = ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' }).run
      expect(run).toBeDefined()
      expect(ledger.state().tasks[0].status).toBe('running')
      writeFileSync(join(dir, 'feature.txt'), 'agent output\n')
      ledger.settle('card-1', run!.execution.id, 'succeeded')
      const parked = ledger.state().tasks[0]
      expect(parked.status).toBe('ready_for_test')
      // The park committed: the card worktree is clean while the card is
      // reviewed, and the card records when.
      expect(parked.git?.committedAt).toBe(NOW)
      expect(git(dir, ['status', '--porcelain'])).toBe('')
      expect(git(dir, ['log', '-1', '--pretty=%s'])).toBe('task: Fix login')

      ledger.applyRequest('r-done', { kind: 'move', taskId: 'card-1', status: 'done' })
      const done = ledger.state().tasks[0]
      expect(done.status).toBe('done')
      expect(done.git?.mergedAt).toBe(NOW)
      // Merged into the main checkout, and the worktree stays: a done card that
      // is pulled back out of `done` still needs its own checkout.
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
      expect(existsSync(join(repo, 'feature.txt'))).toBe(true)
      expect(existsSync(dir)).toBe(true)

      // Archiving is where the worktree is released — the branch and its
      // commits stay in the repository.
      ledger.applyRequest('r-archive', { kind: 'archive', taskId: 'card-1' })
      expect(ledger.state().tasks[0].archivedAt).toBe(NOW)
      expect(existsSync(dir)).toBe(false)
      expect(git(repo, ['show', `${done.git!.branch}:feature.txt`])).toBe('agent output')
    } finally {
      ledger.dispose()
    }
  })

  it('commits a failed and a cancelled run just the same', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      for (const [id, outcome] of [['card-fail', 'failed'], ['card-cancel', 'cancelled']] as const) {
        ledger.applyRequest(`r-create-${id}`, {
          kind: 'create',
          id,
          input: { title: `Fix ${id}`, description: '', prompt: 'p', workspaceId: 'ws-1' },
        })
        ledger.applyRequest(`r-step-on-${id}`, { kind: 'move', taskId: id, status: 'clarification' })
        const run = ledger.applyRequest(`r-run-${id}`, { kind: 'run', taskId: id }).run
        const dir = cardDir(ledger, repo, id)
        writeFileSync(join(dir, `work-${id}.txt`), `${outcome}\n`)
        ledger.settle(id, run!.execution.id, outcome)
        const task = ledger.state().tasks.find(entry => entry.id === id)!
        expect(task.status).toBe(outcome === 'failed' ? 'failed' : 'clarification')
        expect(task.git?.committedAt).toBe(NOW)
        expect(git(dir, ['log', '-1', '--pretty=%s'])).toBe(`task: Fix ${id}`)
      }
    } finally {
      ledger.dispose()
    }
  })

  it('does not commit a clarification round, and commits when the restart cancels a run', () => {
    const repo = createRepo()
    const dir = tempDir('dsh-task-board-ledger-')
    const ledger = new HostTaskLedger(dir, () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      // Backlog → Todo opens the branch and the clarification round.
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const clarification = ledger.state().tasks[0].executions.at(-1)!
      expect(clarification.kind).toBe('clarify')
      const dir = cardDir(ledger, repo)
      writeFileSync(join(dir, 'question-notes.txt'), 'clarification wrote nothing to keep\n')
      ledger.settle('card-1', clarification.id, 'cancelled')
      // A clarification round implements nothing: the worktree keeps its state
      // and the card keeps its column.
      expect(ledger.state().tasks[0].git?.committedAt).toBeUndefined()
      expect(git(dir, ['status', '--porcelain'])).toContain('question-notes.txt')

      // A run interrupted before its session was recorded is cancelled on the
      // next Host start — and that cancellation commits the work.
      const run = ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' }).run
      expect(run).toBeDefined()
      writeFileSync(join(dir, 'interrupted.txt'), 'work of the interrupted run\n')
    } finally {
      ledger.dispose()
    }
    const restarted = new HostTaskLedger(dir, () => NOW, { git: workflowFor(repo) })
    try {
      const task = restarted.state().tasks[0]
      expect(task.status).toBe('clarification')
      expect(task.executions.at(-1)?.result).toBe('cancelled')
      expect(task.git?.committedAt).toBe(NOW)
      const restartedDir = task.git!.worktreePath!
      expect(git(restartedDir, ['status', '--porcelain'])).toBe('')
      expect(git(restartedDir, ['log', '-1', '--pretty=%s'])).toBe('task: Fix login')
    } finally {
      restarted.dispose()
    }
  })

  it('records a refused commit on the settled execution instead of failing the park', () => {
    const repo = createRepo()
    // A rejecting hook is the deterministic way to make `git commit` refuse.
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const run = ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' }).run
      const dir = cardDir(ledger, repo)
      writeFileSync(join(dir, 'feature.txt'), 'agent output\n')
      ledger.settle('card-1', run!.execution.id, 'succeeded')

      const task = ledger.state().tasks[0]
      // The park still happened; the failure is visible in the execution history.
      expect(task.status).toBe('ready_for_test')
      expect(task.git?.committedAt).toBeUndefined()
      expect(task.executions.at(-1)?.error).toMatch(/^commit failed: git commit/)
      expect(git(dir, ['status', '--porcelain'])).toContain('feature.txt')

      // The same holds for a manual drag into the review column: the move goes
      // through, the refused commit is recorded on the newest settled execution.
      ledger.applyRequest('r-back', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      writeFileSync(join(dir, 'second.txt'), 'more work\n')
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
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      const parked = ledger.state().tasks[0]
      expect(parked.status).toBe('ready_for_test')
      expect(parked.git?.branch).toBe('task/fix-login-card1')
      // The park cut branch and worktree; there was nothing to commit yet.
      const dir = parked.git!.worktreePath!
      expect(existsSync(dir)).toBe(true)
      expect(parked.git?.committedAt).toBeUndefined()
      writeFileSync(join(dir, 'feature.txt'), 'no run at all\n')
      // Back out and in again: that park commits the work.
      ledger.applyRequest('r-back', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      ledger.applyRequest('r-park-again', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      const again = ledger.state().tasks[0]
      expect(again.git?.committedAt).toBe(NOW)
      expect(git(dir, ['status', '--porcelain'])).toBe('')
    } finally {
      ledger.dispose()
    }
  })

  it('releases the card worktree when the card is deleted', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-todo', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const dir = ledger.state().tasks[0].git!.worktreePath!
      expect(existsSync(dir)).toBe(true)
      // The clarification round has to be settled: a card with an open
      // execution is never deletable.
      ledger.settle('card-1', ledger.state().tasks[0].executions[0].id, 'succeeded')

      ledger.applyRequest('r-delete', { kind: 'delete', taskId: 'card-1' })
      expect(ledger.state().tasks).toEqual([])
      // The directory is only ever referenced by this card; the branch and its
      // commits stay in the repository.
      expect(existsSync(dir)).toBe(false)
      expect(git(repo, ['branch', '--list', 'task/fix-login-card1'])).toContain('task/fix-login-card1')
    } finally {
      ledger.dispose()
    }
  })

  it('opens a branch when a card is started without the todo pull', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
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
      expect(git(task.git!.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(task.git!.branch)
    } finally {
      ledger.dispose()
    }
  })

  it('opens a branch for a cron-triggered run too', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
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
      expect(git(task.git!.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(task.git!.branch)
    } finally {
      ledger.dispose()
    }
  })

  it('leaves a conflicting replay onto the base in the card\'s own worktree', () => {
    const repo = createRepo()
    const workflow = workflowFor(repo)
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflow })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      // The same file changed on both sides: the replay onto the base conflicts.
      const dir = cardDir(ledger, repo)
      writeFileSync(join(dir, 'feature.txt'), 'branch\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-qm', 'branch work'])
      writeFileSync(join(repo, 'feature.txt'), 'main\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-qm', 'main work'])

      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      ledger.applyRequest('r-done', { kind: 'move', taskId: 'card-1', status: 'done' })

      const task = ledger.state().tasks[0]
      // The release opened the automatic resolution run instead of merging.
      expect(task.status).toBe('running')
      expect(task.executions.at(-1)?.kind).toBe('merge')
      expect(task.merge?.attempts).toBe(1)
      expect(task.merge?.conflict).toMatch(/could not be replayed onto main/)
      expect(task.merge?.conflict).toMatch(/conflicted file/)
      expect(task.merge?.error).toBeUndefined()
      expect(task.git?.mergedAt).toBeUndefined()
      // The human's checkout was never touched — the replay runs in the card's
      // own directory.
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
      // The conflict is in front of the agent, in the card's own worktree: an
      // unfinished rebase with the conflicted file in it.
      const rebaseDir = git(dir, ['rev-parse', '--git-path', 'rebase-merge'])
      expect(existsSync(resolve(dir, rebaseDir))).toBe(true)
      expect(git(dir, ['diff', '--name-only', '--diff-filter=U'])).toContain('feature.txt')
    } finally {
      ledger.dispose()
    }
  })

  it('merges and parks the card in done once the resolution run resolved the conflict', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const dir = cardDir(ledger, repo)
      writeFileSync(join(dir, 'feature.txt'), 'branch\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-qm', 'branch work'])
      writeFileSync(join(repo, 'feature.txt'), 'main\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-qm', 'main work'])
      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      ledger.applyRequest('r-release', { kind: 'approve-merge', taskId: 'card-1' })
      const run = ledger.state().tasks[0].executions.at(-1)!

      // The agent resolves the conflict and finishes the replay, exactly the way
      // the merge prompt tells it to.
      writeFileSync(join(dir, 'feature.txt'), 'resolved\n')
      git(dir, ['add', 'feature.txt'])
      git(dir, ['-c', 'core.editor=true', 'rebase', '--continue'])
      ledger.settle('card-1', run.id, 'succeeded')

      const task = ledger.state().tasks[0]
      expect(task.status).toBe('done')
      expect(task.git?.mergedAt).toBe(NOW)
      expect(task.merge?.mergedAt).toBe(NOW)
      expect(task.merge?.resolvedAt).toBe(NOW)
      expect(task.merge?.error).toBeUndefined()
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
      expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toContain('resolved')
      // The worktree survives the merge; it belongs to the card until the card
      // is archived or deleted.
      expect(existsSync(dir)).toBe(true)
    } finally {
      ledger.dispose()
    }
  })

  it('fails the release when the resolution run leaves the conflict unresolved', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const dir = cardDir(ledger, repo)
      writeFileSync(join(dir, 'feature.txt'), 'branch\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-qm', 'branch work'])
      writeFileSync(join(repo, 'feature.txt'), 'main\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-qm', 'main work'])
      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      ledger.applyRequest('r-release', { kind: 'approve-merge', taskId: 'card-1' })
      const run = ledger.state().tasks[0].executions.at(-1)!

      // The run reports success without having resolved anything.
      ledger.settle('card-1', run.id, 'succeeded')

      const task = ledger.state().tasks[0]
      expect(task.status).toBe('failed')
      expect(task.merge?.error).toMatch(/unfinished conflict/)
      expect(task.git?.mergedAt).toBeUndefined()
      // Nothing of the conflicted work reached the base branch ...
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
      expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('main\n')
      // ... and the card's worktree is back in a clean state.
      expect(git(dir, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
      expect(existsSync(join(dir, '.git'))).toBe(true)
    } finally {
      ledger.dispose()
    }
  })

  it('fails the release when the automatic resolution run fails', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      const dir = cardDir(ledger, repo)
      writeFileSync(join(dir, 'feature.txt'), 'branch\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-qm', 'branch work'])
      writeFileSync(join(repo, 'feature.txt'), 'main\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-qm', 'main work'])
      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      ledger.applyRequest('r-release', { kind: 'approve-merge', taskId: 'card-1' })
      const run = ledger.state().tasks[0].executions.at(-1)!

      ledger.settle('card-1', run.id, 'failed', 'the agent gave up')

      const task = ledger.state().tasks[0]
      expect(task.status).toBe('failed')
      expect(task.merge?.error).toBe('the agent gave up')
      expect(task.git?.mergedAt).toBeUndefined()
      expect(git(dir, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
    } finally {
      ledger.dispose()
    }
  })

  it('releases a card without a branch straight into done, recorded as skipped', () => {
    // A workspace outside git (no repository, no worktree): the release has
    // nothing to merge, moves the card on and says so.
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'))
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Docs only', description: '', prompt: 'p' },
      })
      ledger.applyRequest('r-park', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      ledger.applyRequest('r-release', { kind: 'approve-merge', taskId: 'card-1' })
      const task = ledger.state().tasks[0]
      expect(task.status).toBe('done')
      expect(task.merge?.skipped).toBe(true)
      expect(task.git).toBeUndefined()
    } finally {
      ledger.dispose()
    }
  })

  it('refuses the release outside the review column', () => {
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'))
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Docs only', description: '', prompt: 'p' },
      })
      expect(() => ledger.applyRequest('r-release', { kind: 'approve-merge', taskId: 'card-1' }))
        .toThrow(/merge-requires-ready-for-test/)
    } finally {
      ledger.dispose()
    }
  })

  it('fails the release once the reviewed commit moved, until the card is parked again', () => {
    const repo = createRepo()
    const ledger = new HostTaskLedger(tempDir('dsh-task-board-ledger-'), () => NOW, { git: workflowFor(repo) })
    try {
      ledger.applyRequest('r-create', {
        kind: 'create',
        id: 'card-1',
        input: { title: 'Fix login', description: '', prompt: 'p', workspaceId: 'ws-1' },
      })
      ledger.applyRequest('r-step-on', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      ledger.applyRequest('r-run', { kind: 'run', taskId: 'card-1' })
      const dir = cardDir(ledger, repo)
      writeFileSync(join(dir, 'feature.txt'), 'reviewed\n')
      ledger.settle('card-1', ledger.state().tasks[0].executions.at(-1)!.id, 'succeeded')
      const reviewed = ledger.state().tasks[0].git!.reviewedCommit
      expect(reviewed).toBe(git(dir, ['rev-parse', 'HEAD']))

      // A commit after the park invalidates the approval: the release fails and
      // nothing lands on main.
      writeFileSync(join(dir, 'later.txt'), 'nobody reviewed this\n')
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-qm', 'late work'])
      ledger.applyRequest('r-done', { kind: 'move', taskId: 'card-1', status: 'done' })
      const failed = ledger.state().tasks[0]
      expect(failed.status).toBe('failed')
      expect(failed.merge?.error).toMatch(/moved from the reviewed commit/)
      expect(failed.git?.mergedAt).toBeUndefined()
      expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/fix-login-card1')
      expect(existsSync(join(dir, 'later.txt'))).toBe(true)
      // Nothing of it reached the main checkout.
      expect(existsSync(join(repo, 'later.txt'))).toBe(false)
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')

      // Re-parking rebinds the approval to the new head and drops the failed
      // release record; the next release then goes through.
      ledger.applyRequest('r-back', { kind: 'move', taskId: 'card-1', status: 'clarification' })
      ledger.applyRequest('r-park-again', { kind: 'move', taskId: 'card-1', status: 'ready_for_test' })
      const rebound = ledger.state().tasks[0].git!.reviewedCommit
      expect(rebound).toBe(git(dir, ['rev-parse', 'HEAD']))
      expect(rebound).not.toBe(reviewed)
      expect(ledger.state().tasks[0].merge).toBeUndefined()
      ledger.applyRequest('r-done-2', { kind: 'move', taskId: 'card-1', status: 'done' })
      expect(ledger.state().tasks[0].status).toBe('done')
      expect(ledger.state().tasks[0].git?.mergedAt).toBe(NOW)
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
      expect(existsSync(join(repo, 'later.txt'))).toBe(true)
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
