/**
 * The review block as the Host service drives it: a card in the review column
 * starts its own version on demand, the state (running, ports, links, failure)
 * lands on the card, the cleanup stops only what the board itself started, and
 * the review reads (logs, diff, editor) stay scoped to that one card.
 *
 * The compose integration and the shell commands are faked: this file pins the
 * orchestration (which card, which record, when the cleanups fire), not the
 * argv, which the compose and workflow suites cover.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskCompose } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { ReviewWorkflow, type ReviewCommandRunner } from '../src/review-workflow.ts'

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

/** A command runner that records the commands and always succeeds. */
function fakeRunner(failures: Record<string, string> = {}): ReviewCommandRunner & { calls: Array<{ command: string; cwd: string; env: Record<string, string> }> } {
  const calls: Array<{ command: string; cwd: string; env: Record<string, string> }> = []
  const runner = (async (command: string, options: { cwd: string; env: Record<string, string> }) => {
    calls.push({ command, cwd: options.cwd, env: options.env })
    const failure = failures[command]
    return failure === undefined
      ? { code: 0, stdout: `ran ${command}`, stderr: '' }
      : { code: 1, stdout: '', stderr: failure }
  }) as unknown as ReviewCommandRunner & { calls: typeof calls }
  runner.calls = calls
  return runner
}

interface HarnessOptions {
  environments?: unknown
  runner?: ReturnType<typeof fakeRunner>
  /** Park a record with a running stamp on the card before the service is built (Host restart). */
  preStartedReview?: boolean
  compose?: {
    file?: string
    up?: () => Promise<TaskCompose | undefined>
    down?: (project: string, dir: string, options?: { context?: string }) => Promise<void>
  }
}

/**
 * A service whose session runner never touches a real session: the card is
 * parked in the review column directly (no implementation run needed), which is
 * exactly the state the review block acts on.
 */
function harness(options: HarnessOptions = {}) {
  const repo = tempDir('review-service-repo-')
  // The card is pinned to its workspace; the registry is what resolves that pin
  // to the directory the review runs in (a card without git state has no other
  // handle).
  const registry = { list: () => [{ id: 'ws-1', path: repo }] } as unknown as TaskBoardWorkspaceRegistry
  const ledger = new HostTaskLedger(tempDir('review-service-ledger-'), () => NOW)
  ledger.applyRequest('create', {
    kind: 'create',
    id: 'card',
    input: { title: 'Card', description: '', prompt: 'work', workspaceId: 'ws-1' },
  })
  ledger.applyRequest('park', { kind: 'move', taskId: 'card', status: 'ready_for_test' })

  // A record with a running stamp means "the board started this", also when it
  // was written by an earlier Host process: that is what the service seeds at
  // construction and what the cleanup is allowed to stop.
  if (options.preStartedReview === true) {
    ledger.noteReview('card', { mode: 'command', source: repo, dir: repo, startedAt: NOW - 1_000, env: { DSH_COMPOSE_PORT: '8678' } })
  }

  const runner = options.runner ?? fakeRunner()
  const down = options.compose?.down ?? vi.fn(async () => {})
  const workflow = new ReviewWorkflow({
    compose: {
      ...(options.compose?.file === undefined ? {} : { fileFor: () => ({ dir: repo, file: options.compose!.file as string }) }),
      up: options.compose?.up ?? (async () => undefined),
      down,
      ...(options.compose?.file === undefined ? {} : { logs: async () => 'compose log line' }),
    },
    workspaceRegistry: registry,
    runCommand: runner,
    runFixed: async () => ({ code: 0, stdout: ' app.py | 4 ++\n', stderr: '' }),
    launchApp: async () => {},
    now: () => NOW,
  })
  workflow.configure(options.environments ?? [{ path: repo, env: 'PORT={port}', start: './start.sh', stop: './start.sh --stop', logs: 'tail -n 3 data/server.log', url: 'http://127.0.0.1:{port}' }])

  const service = new TaskBoardHostService({} as unknown as TypertGateway, {
    ledger,
    review: workflow,
    workspaceRegistry: registry,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
  })
  vi.spyOn(service.runner, 'listRunning').mockImplementation(async () => ({ known: true, count: 0, items: [] }))
  vi.spyOn(service.runner, 'inspect').mockImplementation(async () => ({ outcome: 'pending' }))

  const flush = async (): Promise<void> => { await new Promise(resolve => { setTimeout(resolve, 0) }) }
  const poll = async (): Promise<void> => { await (service as unknown as { pollSessions(): Promise<void> }).pollSessions(); await flush() }
  const task = (): ReturnType<typeof ledger.state>['tasks'][number] => ledger.state().tasks[0]!
  return { ledger, service, workflow, runner, repo, down, flush, poll, task }
}

describe('review environments on the Host', () => {
  it('starts the card version on demand and publishes the plan only in the review column', async () => {
    const { service, ledger, runner, repo, flush, task } = harness()
    // The plan rides the snapshot: the review column card has one, and it names
    // the card's own directory plus the configured commands.
    const before = service.snapshot()
    expect(before.reviewPlans?.card).toMatchObject({ dir: repo, available: true, logs: true })

    const accepted = service.apply('start', { kind: 'review-start', taskId: 'card' })
    // The action answers immediately with the in-flight marker, not with the
    // environment: a start may take minutes.
    expect(accepted.reviewPlans?.card?.pending).toBe('start')
    await flush()

    expect(runner.calls[0]!.command).toBe('./start.sh')
    const started = task()
    expect(started.review).toMatchObject({ mode: 'command', dir: repo, startedAt: NOW })
    expect(started.review?.links).toEqual([`http://127.0.0.1:${started.review!.env!.DSH_COMPOSE_PORT}`])
    // The in-flight marker is gone once the outcome is known.
    expect(service.snapshot().reviewPlans?.card?.pending).toBeUndefined()
    expect(service.snapshot().reviewPlans?.card?.available).toBe(true)

    // Leaving the review column drops the plan entirely.
    ledger.applyRequest('back', { kind: 'move', taskId: 'card', status: 'clarification' })
    expect(service.snapshot().reviewPlans?.card).toBeUndefined()
    service.dispose()
  })

  it('refuses the action outside the review column', () => {
    const { service, ledger } = harness()
    ledger.applyRequest('back', { kind: 'move', taskId: 'card', status: 'clarification' })
    expect(() => service.apply('late', { kind: 'review-start', taskId: 'card' }))
      .toThrow(/review-action-requires-ready-for-test/)
    service.dispose()
  })

  it('stops the version again and records how the stop went', async () => {
    const { service, runner, flush, task } = harness()
    service.apply('start', { kind: 'review-start', taskId: 'card' })
    await flush()
    const port = task().review!.env!.DSH_COMPOSE_PORT

    service.apply('stop', { kind: 'review-stop', taskId: 'card' })
    await flush()
    expect(runner.calls[1]!.command).toBe('./start.sh --stop')
    // The stop runs with the port the start used: this card's own instance.
    expect(runner.calls[1]!.env.PORT).toBe(port)
    const stopped = task()
    expect(stopped.review?.startedAt).toBeUndefined()
    expect(stopped.review?.stoppedAt).toBe(NOW)
    // The assigned port stays on the record: a re-start reuses the URL the
    // human already has open.
    expect(stopped.review?.env?.DSH_COMPOSE_PORT).toBe(port)
    service.dispose()
  })

  it('records a failed start with the command output and keeps the buttons usable', async () => {
    const runner = fakeRunner({ './start.sh': 'port 8090 is already in use' })
    const { service, flush, task } = harness({ runner })
    // The Host also logs the failure; keep the suite output clean while
    // asserting that it really reported it.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.apply('start', { kind: 'review-start', taskId: 'card' })
    await flush()
    const failed = task()
    expect(failed.review?.startedAt).toBeUndefined()
    expect(failed.review?.error).toContain('port 8090 is already in use')
    expect(logged.mock.calls.some(call => String(call[0]).includes('review action start failed'))).toBe(true)
    // Still startable: the failure did not leave an in-flight marker behind.
    expect(service.snapshot().reviewPlans?.card?.pending).toBeUndefined()
    expect(() => service.apply('again', { kind: 'review-start', taskId: 'card' })).not.toThrow()
    logged.mockRestore()
    service.dispose()
  })

  it('restarts a running version: stop first, then start', async () => {
    const { service, runner, flush } = harness()
    service.apply('start', { kind: 'review-start', taskId: 'card' })
    await flush()
    service.apply('restart', { kind: 'review-restart', taskId: 'card' })
    await flush()
    expect(runner.calls.map(call => call.command)).toEqual(['./start.sh', './start.sh --stop', './start.sh'])
    service.dispose()
  })

  it('re-attaches a version that was already running before the Host restart', async () => {
    // The service is built on a ledger whose card already carries a running
    // record (an earlier Host process started it): leaving the review column
    // must still stop it, i.e. the seed really re-attached it.
    const { ledger, runner, flush, poll } = harness({ preStartedReview: true })
    ledger.applyRequest('back', { kind: 'move', taskId: 'card', status: 'clarification' })
    await poll()
    expect(runner.calls.map(call => call.command)).toEqual(['./start.sh --stop'])
    expect(runner.calls[0]!.env.DSH_COMPOSE_PORT).toBe('8678')
    await flush()
  })

  it('stops only what the board started when the card leaves the review column', async () => {
    const { service, ledger, runner, flush, poll } = harness()
    // A version the board never started: nothing to stop.
    ledger.applyRequest('back', { kind: 'move', taskId: 'card', status: 'clarification' })
    await poll()
    expect(runner.calls).toEqual([])

    ledger.applyRequest('park-again', { kind: 'move', taskId: 'card', status: 'ready_for_test' })
    service.apply('start', { kind: 'review-start', taskId: 'card' })
    await flush()
    expect(runner.calls).toHaveLength(1)

    // Leaving the column stops it and marks the record stopped.
    ledger.applyRequest('back-again', { kind: 'move', taskId: 'card', status: 'clarification' })
    await poll()
    expect(runner.calls.map(call => call.command)).toEqual(['./start.sh', './start.sh --stop'])
    expect(ledger.state().tasks[0]!.review?.startedAt).toBeUndefined()
    expect(ledger.state().tasks[0]!.review?.stoppedAt).toBe(NOW)
    service.dispose()
  })

  it('stops the environment of a deleted card and keeps the reason when that fails', async () => {
    const { service, ledger, runner, flush, poll } = harness()
    service.apply('start', { kind: 'review-start', taskId: 'card' })
    await flush()
    ledger.applyRequest('delete', { kind: 'delete', taskId: 'card' })
    await poll()
    expect(runner.calls.map(call => call.command)).toEqual(['./start.sh', './start.sh --stop'])

    // A failing stop is reported on the card and not retried every poll.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = harness({ runner: fakeRunner({ './start.sh --stop': 'no such container' }) })
    failing.service.apply('start', { kind: 'review-start', taskId: 'card' })
    await failing.flush()
    failing.ledger.applyRequest('back', { kind: 'move', taskId: 'card', status: 'clarification' })
    await failing.poll()
    await failing.poll()
    expect(failing.runner.calls.filter(call => call.command === './start.sh --stop')).toHaveLength(1)
    const record = failing.ledger.state().tasks[0]!.review
    // The version may still be running: the record keeps its running stamp.
    expect(record?.startedAt).toBe(NOW)
    expect(record?.error).toContain('no such container')
    expect(logged.mock.calls.some(call => String(call[0]).includes('could not stop the review environment'))).toBe(true)
    logged.mockRestore()
    service.dispose()
    failing.service.dispose()
  })

  it('uses the card\'s own compose project when its directory has a compose file', async () => {
    const composeFile = join(tempDir('review-service-compose-'), 'docker-compose.yml')
    writeFileSync(composeFile, 'services: {}\n')
    const down = vi.fn(async () => {})
    const { service, flush, task } = harness({
      environments: [{ path: '/none', start: './start.sh' }],
      compose: {
        file: composeFile,
        up: async () => ({ project: 'dsh-tb-card', file: composeFile, startedAt: NOW, ports: ['web 8123->80/tcp'], env: { DSH_COMPOSE_PORT: '8123' } }),
        down,
      },
    })
    service.apply('start', { kind: 'review-start', taskId: 'card' })
    await flush()
    expect(task().review).toMatchObject({ mode: 'compose', source: 'dsh-tb-card', ports: ['web 8123->80/tcp'] })
    expect(task().review?.links).toEqual(['http://127.0.0.1:8123'])

    service.apply('stop', { kind: 'review-stop', taskId: 'card' })
    await flush()
    expect(down).toHaveBeenCalledWith('dsh-tb-card', expect.any(String), {})
    service.dispose()
  })
})

describe('review reads', () => {
  it('answers the logs of a started card and says so when nothing runs', async () => {
    const { service, flush } = harness()
    const before = await service.reviewOperation({ kind: 'logs', taskId: 'card' })
    expect(before.ok).toBe(false)
    expect(before.error).toContain('no review environment yet')

    service.apply('start', { kind: 'review-start', taskId: 'card' })
    await flush()
    const logs = await service.reviewOperation({ kind: 'logs', taskId: 'card' })
    expect(logs).toEqual({ ok: true, text: 'ran tail -n 3 data/server.log' })
    service.dispose()
  })

  it('diffs the reviewed commit, and answers an unknown card with a reason', async () => {
    const { service, ledger } = harness()
    ledger.applyRequest('parked', { kind: 'update', taskId: 'card', patch: {} })
    const unknown = await service.reviewOperation({ kind: 'diff', taskId: 'nope' })
    expect(unknown).toEqual({ ok: false, error: 'task not found' })
    // No git state on this card: an empty diff, not an error.
    expect(await service.reviewOperation({ kind: 'diff', taskId: 'card' })).toEqual({ ok: true, text: '' })
    service.dispose()
  })

  it('opens the card directory in the editor', async () => {
    const { service, repo } = harness()
    expect(await service.reviewOperation({ kind: 'open', taskId: 'card' })).toEqual({ ok: true, text: repo })
    service.dispose()
  })

  it('keeps the review plans of every review-column card apart', async () => {
    const { service, ledger } = harness()
    ledger.applyRequest('create-2', {
      kind: 'create',
      id: 'other',
      input: { title: 'Other', description: '', prompt: 'p', workspaceId: 'ws-1' },
    })
    const plans = service.snapshot().reviewPlans ?? {}
    expect(Object.keys(plans)).toEqual(['card'])
    expect(plans.card?.dir).toBeDefined()
    service.dispose()
  })
})

describe('review plans for cards without git state', () => {
  it('resolves the pinned workspace directory through the registry', async () => {
    const repo = tempDir('review-service-ws-')
    const registry = { list: () => [{ id: 'ws-1', path: repo }] } as unknown as TaskBoardWorkspaceRegistry
    const ledger = new HostTaskLedger(tempDir('review-service-ledger-'), () => NOW)
    ledger.applyRequest('create', {
      kind: 'create',
      id: 'card',
      input: { title: 'Card', description: '', prompt: 'work', workspaceId: 'ws-1' },
    })
    ledger.applyRequest('park', { kind: 'move', taskId: 'card', status: 'ready_for_test' })
    const workflow = new ReviewWorkflow({
      compose: { up: async () => undefined, down: async () => {} },
      workspaceRegistry: registry,
      runCommand: fakeRunner(),
      now: () => NOW,
    })
    workflow.configure([{ path: repo, start: './start.sh' }])
    const service = new TaskBoardHostService({} as unknown as TypertGateway, {
      ledger,
      review: workflow,
      workspaceRegistry: registry,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => NOW,
    })
    expect(service.snapshot().reviewPlans?.card).toMatchObject({ dir: repo, available: true })
    service.dispose()
  })
})
