/**
 * Task-scoped Docker Compose environments.
 *
 * A card whose worktree carries a compose file gets **its own stack**: the
 * project name is derived from the card id (`dsh-tb-<id8>`), every command runs
 * inside the card's worktree, and the published host ports are read back from
 * `docker compose ps` so the board can show the human where the app answers.
 *
 * The environment lives exactly as long as the card needs it — it is brought up
 * when an implementation run starts and torn down when the card leaves the run
 * and review columns, when it is deleted or archived, or when the Host notices
 * that the project has no card any more.
 *
 * Everything here is asynchronous on purpose: `compose up` builds images and
 * starts containers, which can take minutes, and the Host must keep serving the
 * board meanwhile. The command is always a fixed argv with `shell: false`, and
 * a missing compose file means "no environment", not an error — the feature is
 * discovered per workspace, not configured.
 */
import { LocalCommandRunner, type CommandRunner } from './command-runner.ts'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { TaskCompose, TaskRecord } from './core/tasks.ts'

/** Compose file a task environment is brought up from unless configured otherwise. */
export const DEFAULT_COMPOSE_FILE = 'docker-compose.yml'

/** Compose file names probed when the configured one is absent. */
const FALLBACK_FILES = ['compose.yaml', 'docker-compose.yaml'] as const

/** How long one compose command may take before it is killed. */
export const COMPOSE_TIMEOUT_MS = 5 * 60_000

/** First host port a card's environment is offered when `{port}` is used. */
export const DEFAULT_COMPOSE_PORT_BASE = 8100

/** How many log lines one on-demand snapshot keeps. */
export const COMPOSE_LOG_TAIL = 200

/** Size of the range the per-card port is picked from. */
export const DEFAULT_COMPOSE_PORT_RANGE = 800

/** How many ports are probed before the allocation gives up. */
const PORT_PROBES = 50

/** Per-call options of one compose invocation. */
export interface ComposeRunOptions {
  /**
   * Card id the command works for, for cancellation. The task record already
   * provides it; a teardown after the card is gone has only the id.
   */
  scope?: string
  /**
   * Kill the command when this signal aborts (the operator pressed "Abbrechen").
   */
  signal?: AbortSignal
  /**
   * Docker context the command addresses (`docker --context <name> compose …`).
   * The board's own default context is the one the Host runs under; a workspace
   * whose containers live elsewhere names its context in `reviewEnvironments`.
   */
  context?: string
}

/** The subset of the workflow the Host service uses; tests fake this. */
export interface TaskComposeController {
  /**
   * Compose file the card would be brought up from (the card's worktree, else
   * its checkout), or undefined when it has none. Optional: a fake controller
   * without it simply never offers a compose environment.
   */
  fileFor?(task: TaskRecord): { dir: string; file: string } | undefined
  /** Bring the card's environment up; `undefined` when the card has none. */
  up(task: TaskRecord, options?: ComposeRunOptions): Promise<TaskCompose | undefined>
  /** Tear a project down again (idempotent; failures only log). */
  down(project: string, dir: string, options?: ComposeRunOptions): Promise<void>
  /** Snapshot of a project's container logs; optional like {@link TaskComposeController.fileFor}. */
  logs?(project: string, dir: string, options?: ComposeRunOptions): Promise<string>
}

interface ComposeWorkflowOptions {
  /** Docker binary; the default resolves through PATH. */
  dockerCommand?: string
  /** Compose file inside the card's worktree; an empty string disables the feature. */
  file?: string
  /**
   * Environment for the card's stack, as `KEY=VALUE` pairs separated by commas
   * or newlines. `{port}`, `{port2}` … become distinct free host ports picked
   * for the card (and kept for it), `{task}` its id — that is how a compose file
   * that publishes fixed host ports (`${PORT:-8092}`) gets its own ports per
   * card instead of colliding with the human's own stack.
   */
  env?: string
  /** Base of the per-card port range. */
  portBase?: number
  /** Timeout of one compose command. */
  timeoutMs?: number
  /** Command runner (the Host injects the worker-backed one; tests fake it). */
  runner?: CommandRunner
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Project name of a card's environment: stable, unique, easy to spot. */
export function composeProject(task: Pick<TaskRecord, 'id'>): string {
  const id = task.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 16).toLowerCase()
  return `dsh-tb-${id === '' ? 'task' : id}`
}

/** Directory a card's environment belongs to: its worktree, else its checkout. */
export function composeDir(task: Pick<TaskRecord, 'git'>): string | undefined {
  return task.git?.worktreePath ?? task.git?.repoPath
}

export class ComposeWorkflow implements TaskComposeController {
  private file: string
  private env: string
  private readonly portBase: number
  private readonly dockerCommand: string
  private readonly timeoutMs: number
  private readonly runner: CommandRunner

  constructor(options: ComposeWorkflowOptions = {}) {
    this.file = options.file ?? DEFAULT_COMPOSE_FILE
    this.env = options.env ?? ''
    this.portBase = options.portBase ?? DEFAULT_COMPOSE_PORT_BASE
    this.dockerCommand = options.dockerCommand ?? 'docker'
    this.timeoutMs = options.timeoutMs ?? COMPOSE_TIMEOUT_MS
    this.runner = options.runner ?? new LocalCommandRunner()
  }

  /** Point the workflow at another environment template (settings). */
  setEnv(env: string): void {
    this.env = env
  }

  /**
   * Compose file to use, or undefined when the card has no environment. An
   * empty configured name disables the feature entirely; a missing configured
   * file falls back to the two other names compose itself accepts, so an
   * ordinary repository needs no configuration at all.
   */
  fileFor(task: TaskRecord): { dir: string; file: string } | undefined {
    if (this.file.trim() === '') return undefined
    const dir = composeDir(task)
    if (dir === undefined || !existsSync(dir)) return undefined
    const candidates = [this.file, ...FALLBACK_FILES.filter(name => name !== this.file)]
    for (const candidate of candidates) {
      const path = isAbsolute(candidate) ? candidate : join(dir, candidate)
      if (existsSync(path)) return { dir, file: path }
    }
    return undefined
  }

  /** The configured compose file name (empty disables the feature). */
  get configuredFile(): string {
    return this.file
  }

  /** Point the workflow at another compose file (settings); empty disables it. */
  setFile(file: string): void {
    this.file = file
  }

  /**
   * Bring the card's environment up and read its published ports back. Returns
   * undefined when the card has no compose file (nothing to do). A failure
   * throws with the command's own output, so the caller can fail the run and
   * put the reason on the card.
   */
  async up(task: TaskRecord, options: ComposeRunOptions = {}): Promise<TaskCompose | undefined> {
    const target = this.fileFor(task)
    if (target === undefined) return undefined
    const project = composeProject(task)
    const startedAt = Date.now()
    // A port assigned once stays with the card: the same stack is re-created on
    // a re-run, and the human's bookmarked URL keeps working.
    const env = await resolveComposeEnv(this.env, task, {
      base: this.portBase,
      ...(task.compose?.env === undefined ? {} : { previous: task.compose.env }),
    })
    const result = await this.exec(target.dir, ['compose', '-p', project, '-f', target.file, 'up', '-d'], task, env, options)
    if (result.code !== 0) throw new Error(`docker compose up failed for ${project}: ${detailOf(result)}`)
    return {
      project,
      file: target.file,
      startedAt,
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(await this.ports(target.dir, project, options).then(ports => (ports.length === 0 ? {} : { ports }))),
    }
  }

  /**
   * Tear the project down, volumes included: the environment is disposable, and
   * a leftover volume would surprise the next run of the same card. A project
   * that is already gone is not an error; a real failure only logs.
   */
  async down(project: string, dir: string, options: ComposeRunOptions = {}): Promise<void> {
    if (!existsSync(dir)) return
    const result = await this.exec(dir, ['compose', '-p', project, 'down', '-v', '--remove-orphans'], undefined, {}, options)
    if (result.code !== 0) {
      console.warn(`task board: docker compose down failed for ${project}: ${detailOf(result)}`)
    }
  }

  /**
   * Snapshot of the project's container logs (the last {@link COMPOSE_LOG_TAIL}
   * lines, no follow): the review modal reads it on demand, so a long-running
   * stack never holds a stream open in the Host.
   */
  async logs(project: string, dir: string, options: ComposeRunOptions = {}): Promise<string> {
    const result = await this.exec(dir, ['compose', '-p', project, 'logs', '--tail', String(COMPOSE_LOG_TAIL), '--no-color'], undefined, {}, options)
    if (result.code !== 0) throw new Error(`docker compose logs failed for ${project}: ${detailOf(result)}`)
    return `${result.stdout}${result.stderr}`
  }

  /** Published host ports of the project, as `service host->container/proto`. */
  private async ports(dir: string, project: string, options: ComposeRunOptions = {}): Promise<string[]> {
    const result = await this.exec(dir, ['compose', '-p', project, 'ps', '--format', 'json'], undefined, {}, options)
    if (result.code !== 0) return []
    return parsePublishedPorts(result.stdout)
  }

  /**
   * Run one compose command in `dir`. The task id travels in the environment so
   * a compose file can key its own variables on it (`${DSH_TASK_ID}`), and the
   * project name is exported as `COMPOSE_PROJECT_NAME` for the same reason. A
   * context, when given, is addressed with docker's own global flag, so the
   * command reaches the daemon the workspace named instead of the Host's
   * default one.
   */
  private async exec(dir: string, args: readonly string[], task?: TaskRecord, extra: Record<string, string> = {}, options: ComposeRunOptions = {}): Promise<CommandResult> {
    const argv = [...(options.context === undefined || options.context === '' ? [] : ['--context', options.context]), ...args]
    const scope = options.scope ?? task?.id
    const env = {
      ...(task === undefined ? {} : { DSH_TASK_ID: task.id, COMPOSE_PROJECT_NAME: composeProject(task) }),
      ...extra,
    }
    const onAbort = (): void => { if (scope !== undefined) this.runner.cancelScope(scope) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.runner.run({
        command: this.dockerCommand,
        args: argv,
        cwd: dir,
        env,
        timeoutMs: this.timeoutMs,
        ...(scope === undefined ? {} : { scope }),
      })
      if (result.aborted) return { code: -1, stdout: result.stdout, stderr: `${result.stderr}\ncancelled by the operator` }
      if (result.timedOut) return { code: -1, stdout: result.stdout, stderr: `${result.stderr}\ntimed out after ${this.timeoutMs} ms` }
      return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Resolve the environment template for one card. `{task}` becomes the card id;
 * `{port}`, `{port2}` … `{port9}` become free host ports, one distinct port per
 * placeholder (a compose file may publish several: app, devtools, VNC). The
 * ports are probed on the loopback interface, start at the configured base
 * offset by the card id, and are **remembered** on the card
 * (`DSH_COMPOSE_PORT`, `DSH_COMPOSE_PORT2`, …), so re-running a card re-creates
 * its stack on the very ports the human already knows.
 */
export async function resolveComposeEnv(
  template: string,
  task: Pick<TaskRecord, 'id'>,
  options: { base?: number; previous?: Record<string, string>; probe?: (port: number) => Promise<boolean> } = {},
): Promise<Record<string, string>> {
  const pairs = template
    .split(/[,\n]/)
    .map(entry => entry.trim())
    .filter(entry => entry !== '' && entry.includes('='))
  if (pairs.length === 0) return {}
  const base = options.base ?? DEFAULT_COMPOSE_PORT_BASE
  const previous = options.previous ?? {}
  const probe = options.probe ?? isPortFree

  // Which ports the template asks for: {port} is the first, {port2} the second…
  const indexes = new Set<number>()
  for (const pair of pairs) {
    for (const match of pair.matchAll(/\{port([2-9])?\}/g)) indexes.add(match[1] === undefined ? 1 : Number(match[1]))
  }
  const env: Record<string, string> = {}
  const taken = new Set<number>()
  for (const index of [...indexes].sort((left, right) => left - right)) {
    const key = index === 1 ? 'DSH_COMPOSE_PORT' : `DSH_COMPOSE_PORT${index}`
    const remembered = Number(previous[key])
    let port = Number.isFinite(remembered) && remembered > 0 ? remembered : undefined
    if (port === undefined) {
      const offset = hashOf(`${task.id}#${index}`) % DEFAULT_COMPOSE_PORT_RANGE
      port = await firstFreePort(base + offset, async candidate => !taken.has(candidate) && await probe(candidate))
    }
    taken.add(port)
    env[key] = String(port)
  }

  for (const pair of pairs) {
    const index = pair.indexOf('=')
    const key = pair.slice(0, index).trim()
    if (key === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    // The remembered ports win over the template, so a re-run re-creates the
    // stack on the very ports the human already knows.
    const value = pair.slice(index + 1).trim()
      .replaceAll('{task}', task.id)
      .replace(/\{port([2-9])?\}/g, (_match, digit: string | undefined) =>
        env[digit === undefined ? 'DSH_COMPOSE_PORT' : `DSH_COMPOSE_PORT${digit}`] ?? '')
    env[key] = value
  }
  return env
}

/** Stable small number for a card id (port-range offset). */
function hashOf(value: string): number {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)!) % 100_000
  return hash
}

/** First port at or above `start` that is free on the loopback interface. */
async function firstFreePort(start: number, probe: (port: number) => Promise<boolean>): Promise<number> {
  for (let port = start; port < start + PORT_PROBES; port += 1) {
    if (await probe(port)) return port
  }
  return start + PORT_PROBES
}

/** Whether nothing is listening on the port (the probe a port allocation makes). */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.once('listening', () => { server.close(() => { resolve(true) }) })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Read published ports out of `docker compose ps --format json`. Compose emits
 * one JSON object per line (and an array on some versions), so both shapes are
 * accepted; anything unparseable is ignored — a missing port list must never
 * fail a working environment.
 */
export function parsePublishedPorts(output: string): string[] {
  const rows: unknown[] = []
  const trimmed = output.trim()
  if (trimmed === '') return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) rows.push(...parsed)
    else rows.push(parsed)
  } catch {
    for (const line of trimmed.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        rows.push(JSON.parse(text) as unknown)
      } catch {
        // A progress line, not a container row.
      }
    }
  }
  const ports = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as { Service?: unknown; Publishers?: unknown }
    const service = typeof record.Service === 'string' && record.Service !== '' ? record.Service : 'service'
    if (!Array.isArray(record.Publishers)) continue
    for (const entry of record.Publishers) {
      if (typeof entry !== 'object' || entry === null) continue
      const publisher = entry as { PublishedPort?: unknown; TargetPort?: unknown; Protocol?: unknown }
      const published = typeof publisher.PublishedPort === 'number' ? publisher.PublishedPort : undefined
      const target = typeof publisher.TargetPort === 'number' ? publisher.TargetPort : undefined
      if (published === undefined || target === undefined || published === 0) continue
      const protocol = typeof publisher.Protocol === 'string' && publisher.Protocol !== '' ? publisher.Protocol : 'tcp'
      ports.add(`${service} ${published}->${target}/${protocol}`)
    }
  }
  return [...ports].sort()
}

/** Last line of a command's own output, for a message a human reads on a card. */
function detailOf(result: CommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim().split('\n').filter(line => line.trim() !== '')
  const tail = text.slice(-3).join(' | ')
  return tail === '' ? `exit code ${result.code}` : tail
}
