/**
 * One command surface for every child process the Host starts on behalf of a
 * card: git, docker compose, the review commands and the read-only snapshots.
 *
 * The runner exists for two reasons:
 *
 * 1. **Priority and cancellation.** A command can be cancelled by scope (the
 *    card id), so "abort this card's running action" reaches the child process
 *    instead of waiting for its timeout. Without that, a wedged `git rebase` or
 *    a docker build kept the board's card busy for minutes.
 * 2. **Off the Host's event loop.** In the Host the runner is backed by a
 *    worker thread (see `command-worker.ts`): child-process output, encoding and
 *    the timeout bookkeeping live in the worker, so a chatty build cannot
 *    compete with `/state`, `/parse` or the SSE stream for the main loop.
 *
 * The worker is an implementation detail: tests and the pure workflow classes
 * use the in-process runner, which behaves identically apart from running on
 * the caller's loop.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'

/** One command to run, addressed to a card (`scope`) when it has one. */
export interface CommandRequest {
  /** Executable (absolute path or PATH lookup), never a shell string. */
  command: string
  args?: readonly string[]
  cwd: string
  /** Extra environment on top of `process.env`. */
  env?: Record<string, string>
  /** Upper bound for this command; the child is killed when it expires. */
  timeoutMs: number
  /**
   * Card id the command works for. Every command of one scope is killed by
   * {@link CommandRunner.cancelScope}, which is how "Abbrechen" reaches a
   * running commit, merge, compose build or review command.
   */
  scope?: string
}

/** Outcome of one command; never throws for a non-zero exit. */
export interface CommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** The runner's own deadline killed the child. */
  timedOut: boolean
  /** The card's cancellation killed the child before it finished. */
  aborted: boolean
}

/** How the workflows start commands; the Host injects a worker-backed one. */
export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
  /** Kill every running command of one card; returns how many were killed. */
  cancelScope(scope: string): number
  /** Card ids with a command running right now (for the board's "Abbrechen"). */
  busyScopes(): string[]
  dispose(): void
}

/** A settled command that was killed by the scope's cancellation. */
export function abortedResult(stdout: string, stderr: string): CommandResult {
  return { code: null, signal: 'SIGKILL', stdout, stderr: `${stderr}${stderr === '' ? '' : '\n'}cancelled by the operator`, timedOut: false, aborted: true }
}

interface RunningCommand {
  child: ChildProcess
  scope?: string
  finish: (result: CommandResult) => void
}

/**
 * In-process runner: the behaviour the workflows had before, plus scope
 * cancellation. Suitable for tests and for the worker's own child handling.
 */
export class LocalCommandRunner implements CommandRunner {
  private readonly running = new Map<string, RunningCommand>()

  run(request: CommandRequest): Promise<CommandResult> {
    const id = randomUUID()
    return new Promise<CommandResult>((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let aborted = false
      const child = spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        shell: false,
        env: { ...process.env, ...(request.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const finish = (result: CommandResult): void => {
        if (settled) return
        settled = true
        this.running.delete(id)
        clearTimeout(timer)
        resolve(result)
      }
      this.running.set(id, {
        child,
        ...(request.scope === undefined ? {} : { scope: request.scope }),
        finish: (result) => {
          aborted = result.aborted
          finish(result)
        },
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (error) => {
        finish({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut, aborted })
      })
      child.once('close', (code, signal) => {
        finish({ code, signal: signal ?? null, stdout, stderr, timedOut, aborted })
      })
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, request.timeoutMs)
    })
  }

  cancelScope(scope: string): number {
    let killed = 0
    for (const command of [...this.running.values()]) {
      if (command.scope !== scope) continue
      killed += 1
      command.finish(abortedResult('', ''))
      try { command.child.kill('SIGKILL') } catch { /* already gone */ }
    }
    return killed
  }

  busyScopes(): string[] {
    const scopes = new Set<string>()
    for (const command of this.running.values()) if (command.scope !== undefined) scopes.add(command.scope)
    return [...scopes]
  }

  dispose(): void {
    for (const command of [...this.running.values()]) {
      try { command.child.kill('SIGKILL') } catch { /* already gone */ }
      command.finish(abortedResult('', 'runner disposed'))
    }
    this.running.clear()
  }
}

/** Message shapes between {@link WorkerCommandRunner} and `command-worker.ts`. */
export type CommandWorkerRequest =
  | { type: 'run'; id: string; request: CommandRequest }
  | { type: 'cancel'; scope: string }
  | { type: 'busy' }

export type CommandWorkerReply =
  | { type: 'result'; id: string; result: CommandResult }
  | { type: 'cancelled'; scope: string; killed: number }
  | { type: 'busy'; scopes: string[] }

interface PendingWorkerCommand {
  resolve: (result: CommandResult) => void
  request: CommandRequest
  timer: ReturnType<typeof setTimeout>
}

/**
 * Worker-backed runner: child processes and their output handling run in a
 * `worker_threads` worker, so a build that produces megabytes of output cannot
 * starve the Host's event loop. The worker is created lazily and restarted after
 * a crash; a command that was in flight when the worker died is reported as
 * cancelled rather than silently lost.
 */
export class WorkerCommandRunner implements CommandRunner {
  private worker: Worker | undefined
  private fallback: LocalCommandRunner | undefined
  private readonly pending = new Map<string, PendingWorkerCommand>()

  constructor(private readonly workerUrl: URL = new URL('./command-worker.js', import.meta.url)) {}

  private ensure(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = new Worker(this.workerUrl, { name: 'dsh-task-board-commands' })
    worker.unref()
    worker.on('message', (message: CommandWorkerReply) => {
      if (message.type === 'result') {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        pending.resolve(message.result)
      }
    })
    worker.on('error', (error) => { this.fail(error) })
    worker.on('exit', (code) => { if (code !== 0) this.fail(new Error(`command worker exited with code ${code}`)) })
    this.worker = worker
    return worker
  }

  private fail(error: Error): void {
    this.worker = undefined
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: `command worker failed: ${error.message}`,
        timedOut: false,
        aborted: true,
      })
    }
  }

  run(request: CommandRequest): Promise<CommandResult> {
    let worker: Worker
    try {
      worker = this.ensure()
    } catch {
      // No worker entry on this build (source checkout/tests) or the thread
      // could not be created: run in-process rather than failing the card.
      this.fallback ??= new LocalCommandRunner()
      return this.fallback.run(request)
    }
    const id = randomUUID()
    return new Promise<CommandResult>((resolve) => {
      // Safety net for a wedged worker: the worker kills its own child at
      // `timeoutMs`; this only catches a worker that stopped answering at all.
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        pending.resolve({ code: null, signal: null, stdout: '', stderr: 'command worker did not answer', timedOut: true, aborted: false })
        this.cancelScope(request.scope ?? '')
        void worker.terminate()
        this.worker = undefined
      }, request.timeoutMs + 5_000)
      this.pending.set(id, { resolve, request, timer })
      worker.postMessage({ type: 'run', id, request } satisfies CommandWorkerRequest)
    })
  }

  cancelScope(scope: string): number {
    if (this.fallback !== undefined) return this.fallback.cancelScope(scope)
    if (scope === '' || this.worker === undefined) return 0
    let killed = 0
    for (const [id, pending] of [...this.pending]) {
      if (pending.request.scope !== scope) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(abortedResult('', ''))
      killed += 1
    }
    if (killed > 0) this.worker.postMessage({ type: 'cancel', scope } satisfies CommandWorkerRequest)
    return killed
  }

  busyScopes(): string[] {
    if (this.fallback !== undefined) return this.fallback.busyScopes()
    const scopes = new Set<string>()
    for (const pending of this.pending.values()) if (pending.request.scope !== undefined) scopes.add(pending.request.scope)
    return [...scopes]
  }

  dispose(): void {
    this.fallback?.dispose()
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(abortedResult('', 'runner disposed'))
    }
    void this.worker?.terminate()
    this.worker = undefined
  }
}

/**
 * Build the runner the Host uses: the worker-backed one when the built worker
 * entry exists, otherwise the in-process runner (source checkout, tests, or a
 * build that predates the worker). A worker that cannot start is not an error
 * the board should surface — the commands still run.
 */
export function createHostCommandRunner(workerUrl?: URL): CommandRunner {
  try {
    return new WorkerCommandRunner(workerUrl)
  } catch {
    return new LocalCommandRunner()
  }
}
