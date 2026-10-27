/**
 * Review environments: the card's own version, started on demand from the
 * review column so a human can look at it before the merge, and stopped again
 * as soon as the card leaves that column.
 *
 * Two ways to run it, in this order:
 *
 * 1. **The card's compose file**, when its directory holds one: the same
 *    task-scoped project `git`-style stack the run column uses
 *    (`dsh-tb-<card id8>`), brought up on demand with the card's own published
 *    ports. This is the path for repositories whose compose file is per-card
 *    clonable.
 * 2. **Configured commands per workspace** (setting `reviewEnvironments`),
 *    otherwise: a start/stop/restart/logs command run in the card's directory.
 *    That is what an application started by its own script needs — the
 *    "container" of the new version is then whatever that command manages, and
 *    the assigned host ports (`{port}`, `{port2}` …) keep it away from the
 *    stack the human runs themselves.
 *
 * Nothing here is global: every action addresses one card's directory, one
 * compose project or one command environment. A workspace that configures
 * neither command nor compose file simply has no buttons to press.
 *
 * Commands are the human's own text from the settings, so they run through the
 * shell (`bash -lc`) with a fixed, bounded budget — never through the board's
 * action payload, where a browser could smuggle a command in. Everything else
 * (compose, editor launch) is a fixed argv with `shell: false`.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { TaskRecord, TaskReview } from './core/tasks.ts'
import { findReviewEnvironment, hasCommands, parseReviewEnvironments, type ReviewEnvironmentConfig } from './core/review-config.ts'
import { COMPOSE_LOG_TAIL, DEFAULT_COMPOSE_PORT_BASE, composeProject, resolveComposeEnv, type TaskComposeController } from './compose-workflow.ts'
import type { TaskBoardWorkspaceRegistry } from './host-runner.ts'
import { seedReviewData } from './review-data.ts'

// The declarative half of the review setup lives in `core/`, so the browser's
// settings card validates exactly the document this workflow executes; the
// re-export keeps one import site for the Host side (and for the tests).
export { findReviewEnvironment, hasCommands, isBelow, parseReviewEnvironments, type ReviewEnvironmentConfig } from './core/review-config.ts'

/** App URL a card is offered when its workspace configures no template. */
export const DEFAULT_REVIEW_URL_TEMPLATE = 'http://127.0.0.1:{port}'

/** How long one configured review command (start/stop/restart) may take. */
export const REVIEW_COMMAND_TIMEOUT_MS = 5 * 60_000

/** How long a logs read may take; it is a snapshot, not a build. */
export const REVIEW_READ_TIMEOUT_MS = 30_000

/** Editor binary the worktree link launches. */
export const DEFAULT_EDITOR_COMMAND = 'code'

/** Flag that keeps a second card out of the window of the first one. */
export const EDITOR_NEW_WINDOW_FLAG = '-n'

/** Outcome of one command run. */
export interface ReviewCommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Injection seam for the shell commands (tests replace it). */
export type ReviewCommandRunner = (command: string, options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<ReviewCommandResult>

/** Injection seam for fixed-argv calls (git diff; tests replace it). */
export type ReviewFixedRunner = (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<ReviewCommandResult>

/** Injection seam for the editor launch (tests replace it). */
export type ReviewAppLauncher = (command: string, args: readonly string[]) => Promise<void>

/** Options of the review workflow. */
export interface ReviewWorkflowOptions {
  /** Compose integration the review start reuses (the card's own project). */
  compose: TaskComposeController
  /** Registered workspaces: resolves a card without git state to its directory. */
  workspaceRegistry?: TaskBoardWorkspaceRegistry
  /**
   * Repository directory of one workspace directory (the git workflow's
   * `repoSubpath` resolution). Used for a card without git state: the review then
   * looks at the repository inside the workspace, exactly like the git flow and
   * the workspace's configured commands do, instead of at the container folder.
   */
  repoDirectory?: (workspacePath: string) => string | undefined
  /** Editor binary; defaults to `code`. */
  editorCommand?: string
  /** Base of the per-card port range for configured commands. */
  portBase?: number
  /** Command timeout; defaults to {@link REVIEW_COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number
  /** Logs/read timeout; defaults to {@link REVIEW_READ_TIMEOUT_MS}. */
  readTimeoutMs?: number
  /** Clock (tests). */
  now?: () => number
  /** Command runner (tests). */
  runCommand?: ReviewCommandRunner
  /** Fixed-argv runner for git reads (tests). */
  runFixed?: ReviewFixedRunner
  /** Editor launcher (tests). */
  launchApp?: ReviewAppLauncher
}

/**
 * What one card offers the review step; derived from the filesystem and the
 * settings on every read, never persisted.
 */
export interface ReviewPlan {
  /** Directory the version runs in; absent when the card has no known directory. */
  dir?: string
  /** Whether `dir` is the card's own worktree (false = its main checkout). */
  worktree?: boolean
  /** `*.code-workspace` to open instead of the directory, when one exists. */
  workspaceFile?: string
  /** Whether there is something to start (a compose file or configured commands). */
  available: boolean
  /** Whether the Host can read logs for it (compose, or a configured logs command). */
  logs: boolean
}

/**
 * Resolve the URL template against an environment: `{port}`, `{port2}` …
 * become the assigned host ports and `{task}` the card id. An unresolved
 * placeholder means the URL cannot answer yet, so there is no link instead of a
 * made-up address; anything that is not an http(s) URL is refused for the same
 * reason.
 */
export function resolveReviewUrl(template: string, env: Readonly<Record<string, string>>, taskId?: string): string | undefined {
  // A placeholder without a value must not become a made-up address: the whole
  // URL is dropped instead (`http://127.0.0.1:` answers nothing).
  let unresolved = false
  const resolved = template.replace(/\{(port(?:[2-9])?|task)\}/g, (_match, name: string) => {
    if (name === 'task') {
      if (taskId === undefined || taskId === '') {
        unresolved = true
        return ''
      }
      return taskId
    }
    const digit = name === 'port' ? undefined : name.slice('port'.length)
    const value = env[digit === undefined ? 'DSH_COMPOSE_PORT' : `DSH_COMPOSE_PORT${digit}`]
    if (value === undefined || value === '') {
      unresolved = true
      return ''
    }
    return value
  })
  if (unresolved || /\{[^}]*\}/.test(resolved)) return undefined
  const trimmedUrl = resolved.trim()
  return /^https?:\/\/\S+$/.test(trimmedUrl) ? trimmedUrl : undefined
}

/** Published host ports of one compose project, as `service host->container/proto`. */
export function publishedPorts(ports: readonly string[] | undefined): number[] {
  const found = new Set<number>()
  for (const entry of ports ?? []) {
    const match = / (\d+)->\d+\/([a-z]+)$/i.exec(entry.trim())
    if (match === null || match[2].toLowerCase() !== 'tcp') continue
    const port = Number(match[1])
    if (Number.isFinite(port) && port > 0) found.add(port)
  }
  return [...found]
}

/**
 * Links the review offers: the template resolved with the card's assigned
 * ports, plus one link per published compose port (the container may publish
 * more than the template's first port names). Duplicates collapse, and an
 * unresolvable template simply produces no link.
 */
export function reviewLinks(template: string, env: Readonly<Record<string, string>>, published: readonly number[], taskId?: string): string[] {
  const links: string[] = []
  const templated = resolveReviewUrl(template, env, taskId)
  if (templated !== undefined) links.push(templated)
  for (const port of published) {
    const url = template.includes('{port')
      ? resolveReviewUrl(template, { ...env, DSH_COMPOSE_PORT: String(port) }, taskId)
      : resolveReviewUrl(DEFAULT_REVIEW_URL_TEMPLATE, { DSH_COMPOSE_PORT: String(port) }, taskId)
    if (url !== undefined) links.push(url)
  }
  return [...new Set(links)]
}

/**
 * The `*.code-workspace` to open for a directory: the file named after the
 * directory first (that is the one the human's repositories carry), otherwise
 * the single/lexicographically first one. Returns an absolute path or
 * undefined; a directory without a workspace file is opened as a folder.
 */
export function pickCodeWorkspace(dir: string, files?: readonly string[]): string | undefined {
  const entries = files ?? readWorkspaceFiles(dir)
  const candidates = entries.filter(name => name.endsWith('.code-workspace') && !name.startsWith('.')).sort()
  if (candidates.length === 0) return undefined
  const preferred = candidates.find(name => basename(name, '.code-workspace') === basename(dir))
  return join(dir, preferred ?? candidates[0]!)
}

function readWorkspaceFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Last lines of a command's own output, for a message a human reads on a card. */
function detailOf(result: ReviewCommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim().split('\n').filter(line => line.trim() !== '')
  const tail = text.slice(-3).join(' | ')
  return tail === '' ? `exit code ${result.code}` : tail
}

/**
 * Run one fixed argv without a shell; rejects with the reason (a missing
 * binary) and reports a non-zero exit with the command's own output.
 */
function spawnFixed(command: string, args: readonly string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<ReviewCommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: options.cwd, shell: false, env: { ...process.env, ...options.env } })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${options.timeoutMs} ms` })
    }, options.timeoutMs)
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Run one configured command through the shell: the command text is the
 * human's own settings text (it may contain pipes, `&&`, a leading `PORT=…`
 * assignment), and it runs in the card's directory with the review environment
 * exported. A command that does not finish within the budget is killed and
 * reported as a failure — including its own output, so the reason is visible.
 */
export function runShellCommand(command: string, options: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<ReviewCommandResult> {
  return new Promise(resolve => {
    const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
    const child = spawn(shell, ['-lc', command], { cwd: options.cwd, shell: false, env: { ...process.env, ...options.env } })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${options.timeoutMs} ms` })
    }, options.timeoutMs)
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Start the editor and resolve once it is really running (a missing binary rejects). */
export function launchDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export class ReviewWorkflow {
  private environments: ReviewEnvironmentConfig[] = []
  /** Parse reasons of the current setting, for the settings card. */
  private errors: string[] = []
  private readonly compose: TaskComposeController
  private readonly registry: TaskBoardWorkspaceRegistry | undefined
  private readonly repoDirectory: ((workspacePath: string) => string | undefined) | undefined
  private editorCommand: string
  private readonly portBase: number
  private readonly commandTimeoutMs: number
  private readonly readTimeoutMs: number
  private readonly now: () => number
  private readonly runCommand: ReviewCommandRunner
  private readonly runFixed: ReviewFixedRunner
  private readonly launchApp: ReviewAppLauncher

  constructor(options: ReviewWorkflowOptions) {
    this.compose = options.compose
    this.registry = options.workspaceRegistry
    this.repoDirectory = options.repoDirectory
    this.editorCommand = options.editorCommand ?? DEFAULT_EDITOR_COMMAND
    this.portBase = options.portBase ?? DEFAULT_COMPOSE_PORT_BASE
    this.commandTimeoutMs = options.commandTimeoutMs ?? REVIEW_COMMAND_TIMEOUT_MS
    this.readTimeoutMs = options.readTimeoutMs ?? REVIEW_READ_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.runCommand = options.runCommand ?? runShellCommand
    this.runFixed = options.runFixed ?? spawnFixed
    this.launchApp = options.launchApp ?? launchDetached
  }

  /** Point the workflow at another `reviewEnvironments` setting; returns the reasons. */
  configure(value: unknown): string[] {
    const parsed = parseReviewEnvironments(value)
    this.environments = parsed.environments
    this.errors = parsed.errors
    return parsed.errors
  }

  /** Reasons of the last {@link ReviewWorkflow.configure} (empty when it parsed). */
  get configurationErrors(): readonly string[] {
    return this.errors
  }

  /** Point the worktree link at another editor binary (settings `editorCommand`). */
  setEditorCommand(command: string): void {
    if (command.trim() !== '') this.editorCommand = command.trim()
  }

  /** The configured entries (tests and diagnostics). */
  get entries(): readonly ReviewEnvironmentConfig[] {
    return this.environments
  }

  /**
   * Directory the card's version lives in: its own worktree when it still
   * exists, else its main checkout, else the registered directory of the
   * pinned workspace (a card without git state). Absent when none of them is a
   * real directory — then there is nothing to open, start or diff.
   */
  directory(task: TaskRecord): string | undefined {
    const worktreePath = task.git?.worktreePath
    if (worktreePath !== undefined && existsSync(worktreePath)) return worktreePath
    const repoPath = task.git?.repoPath
    if (repoPath !== undefined && existsSync(repoPath)) return repoPath
    return this.workspaceDirectory(task)
  }

  /**
   * Registered directory of the card's pinned workspace, when the registry knows
   * it — the last resort for a card without git state.
   */
  private workspaceDirectory(task: TaskRecord): string | undefined {
    const workspaceId = task.handover?.workspaceId ?? task.workspaceId
    if (workspaceId === undefined || this.registry === undefined) return undefined
    const workspace = this.registry.list().find(item => item.id === workspaceId)
    if (workspace === undefined || typeof workspace.path !== 'string' || !existsSync(workspace.path)) return undefined
    // A workspace that only contains the repository (the `repoSubpath` case):
    // what the card changed lives in the repository, not in the folder around it.
    const repository = this.repoDirectory?.(workspace.path)
    return repository !== undefined && existsSync(repository) ? repository : workspace.path
  }

  /**
   * The workspace entry governing the card, looked up by its directory first and
   * then by the repository it belongs to: a card working in its own worktree
   * lives *outside* the repository, so an entry keyed to the repository root must
   * still govern it (the worktree is that repository's checkout). The registered
   * workspace directory closes the same gap for a card without git state.
   */
  environmentFor(task: TaskRecord, dir: string): ReviewEnvironmentConfig | undefined {
    const candidates = [dir, task.git?.repoPath, this.workspaceDirectory(task)]
    for (const candidate of candidates) {
      if (candidate === undefined) continue
      const environment = findReviewEnvironment(this.environments, candidate)
      if (environment !== undefined) return environment
    }
    return undefined
  }

  /** Compose file the card's directory holds, when the compose integration finds one. */
  private composeTarget(task: TaskRecord): { file: string } | undefined {
    const target = this.compose.fileFor?.(task)
    return target === undefined ? undefined : { file: target.file }
  }

  /**
   * What the review step offers this card. Derived from the filesystem and the
   * settings on every read (the plan is not ledger state): a card whose worktree
   * was deleted, whose compose file moved or whose workspace entry was removed
   * simply loses the corresponding control.
   */
  plan(task: TaskRecord): ReviewPlan {
    const dir = this.directory(task)
    if (dir === undefined) return { available: false, logs: false }
    const workspaceFile = pickCodeWorkspace(dir)
    const environment = this.environmentFor(task, dir)
    const compose = this.composeTarget(task)
    return {
      dir,
      worktree: task.git?.worktreePath === dir,
      ...(workspaceFile === undefined ? {} : { workspaceFile }),
      available: compose !== undefined || hasCommands(environment),
      logs: compose !== undefined ? this.compose.logs !== undefined : environment?.logs !== undefined,
    }
  }

  /**
   * Identity of the environment a start would create: how it would be managed,
   * what identifies it and where it would run. Known before anything runs, which
   * is what lets the Host record a *failed* start on the card with the same
   * fields a successful one carries. Undefined when there is nothing to manage.
   */
  describe(task: TaskRecord): Pick<TaskReview, 'mode' | 'source' | 'dir'> & Pick<TaskReview, 'context'> | undefined {
    const dir = this.directory(task)
    if (dir === undefined) return undefined
    const environment = this.environmentFor(task, dir)
    if (this.composeTarget(task) !== undefined) {
      return {
        mode: 'compose',
        source: composeProject(task),
        dir,
        ...(environment?.dockerContext === undefined ? {} : { context: environment.dockerContext }),
      }
    }
    if (!hasCommands(environment)) return undefined
    return {
      mode: 'command',
      source: environment.path,
      dir,
      ...(environment.dockerContext === undefined ? {} : { context: environment.dockerContext }),
    }
  }

  /**
   * Bring the card's version up and return the record for the card. Compose
   * wins when the directory holds a compose file (the card's own project, its
   * own ports, its own volumes); otherwise the workspace's configured start
   * command runs in the card's directory with the assigned ports and the
   * configured docker context in its environment.
   *
   * A failure throws with the command's own output — the caller puts it on the
   * card. Nothing is recorded as running here; only a successful start returns
   * a record with `startedAt`.
   *
   * Before either mode starts, the environment's `data` list is snapshotted from
   * the card's main checkout into its own worktree: the worktree is a fresh
   * checkout, so a gitignored database would otherwise be missing. A failed
   * snapshot fails the start, never silently starting an empty application.
   */
  async start(task: TaskRecord): Promise<TaskReview> {
    const dir = this.directory(task)
    if (dir === undefined) throw new Error('the card has no directory to run the review environment in')
    const environment = this.environmentFor(task, dir)
    const compose = this.composeTarget(task)
    if (compose === undefined && !hasCommands(environment)) {
      throw new Error(`no review environment is configured for ${dir} (set "reviewEnvironments" or add a compose file)`)
    }
    await this.seedData(task, dir, environment)
    if (compose !== undefined) return await this.startCompose(task, dir, environment)
    if (!hasCommands(environment)) {
      // Unreachable after the check above, but this is what narrows the type.
      throw new Error(`no start command is configured for ${dir} (set "reviewEnvironments")`)
    }
    return await this.startCommand(task, dir, environment)
  }

  /**
   * Snapshot the configured SQLite files from the main checkout into the card's
   * own worktree. Only a card that really runs in its worktree is seeded: a card
   * reviewed in its main checkout already has the data, and a card without git
   * state has no main checkout to read from. The source is never written.
   */
  private async seedData(task: TaskRecord, dir: string, environment: ReviewEnvironmentConfig | undefined): Promise<void> {
    const files = environment?.data
    if (files === undefined || files.length === 0) return
    const repoPath = task.git?.repoPath
    const worktreePath = task.git?.worktreePath
    if (repoPath === undefined || worktreePath === undefined) return
    if (resolve(worktreePath) !== resolve(dir)) return
    if (resolve(repoPath) === resolve(worktreePath)) return
    await seedReviewData({ sourceRoot: repoPath, targetRoot: dir, files })
  }

  private async startCompose(task: TaskRecord, dir: string, environment: ReviewEnvironmentConfig | undefined): Promise<TaskReview> {
    const context = environment?.dockerContext
    const compose = await this.compose.up(task, context === undefined ? {} : { context })
    if (compose === undefined) throw new Error(`no compose file in ${dir}`)
    const env = compose.env ?? {}
    // The workspace entry may still name the app's URL (the published ports are
    // the default); its `env` applies to command mode only, where no compose
    // file decides the container's environment.
    const links = reviewLinks(environment?.url ?? DEFAULT_REVIEW_URL_TEMPLATE, env, publishedPorts(compose.ports), task.id)
    return {
      mode: 'compose',
      source: compose.project,
      dir,
      ...(context === undefined ? {} : { context }),
      startedAt: this.now(),
      ...(compose.ports === undefined || compose.ports.length === 0 ? {} : { ports: compose.ports }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(links.length === 0 ? {} : { links }),
    }
  }

  private async startCommand(task: TaskRecord, dir: string, environment: ReviewEnvironmentConfig): Promise<TaskReview> {
    const env = await this.commandEnv(task, environment)
    const result = await this.runCommand(environment.start as string, { cwd: dir, env, timeoutMs: this.commandTimeoutMs })
    if (result.code !== 0) throw new Error(`review start failed: ${detailOf(result)}`)
    const links = reviewLinks(environment.url ?? DEFAULT_REVIEW_URL_TEMPLATE, env, [], task.id)
    return {
      mode: 'command',
      source: environment.path,
      dir,
      startedAt: this.now(),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(links.length === 0 ? {} : { links }),
    }
  }

  /**
   * Tear the card's version down: the compose project goes down (volumes
   * included, like the run environment), a command environment runs its
   * configured stop command in the very environment it was started with — the
   * assigned ports, so it stops this card's instance and not the human's.
   */
  async stop(taskId: string, review: TaskReview): Promise<void> {
    if (review.mode === 'compose') {
      await this.compose.down(review.source, review.dir, review.context === undefined ? {} : { context: review.context })
      return
    }
    const environment = findReviewEnvironment(this.environments, review.dir)
    const command = environment?.stop
    if (command === undefined) {
      throw new Error(`no stop command is configured for ${review.dir}; stop it by hand and press "stopped"`)
    }
    const env = { ...companyEnvironment(environment), ...review.env }
    const expanded = expandCommand(command, review.env ?? {}, taskId)
    const result = await this.runCommand(expanded, { cwd: review.dir, env, timeoutMs: this.commandTimeoutMs })
    if (result.code !== 0) throw new Error(`review stop failed: ${detailOf(result)}`)
  }

  /**
   * Snapshot of the environment's own log or the compose project's container
   * logs (compose's own snapshot size, {@link COMPOSE_LOG_TAIL}); a configured
   * `logs` command prints what the human wrote into it. Throws when the
   * workspace configures no logs command and the card has no compose file.
   */
  async logs(taskId: string, review: TaskReview): Promise<string> {
    if (review.mode === 'compose') {
      if (this.compose.logs === undefined) throw new Error('this host cannot read compose logs')
      return await this.compose.logs(review.source, review.dir, review.context === undefined ? {} : { context: review.context })
    }
    const environment = findReviewEnvironment(this.environments, review.dir)
    const command = environment?.logs
    if (command === undefined) throw new Error(`no logs command is configured for ${review.dir}`)
    const expanded = expandCommand(command, review.env ?? {}, taskId)
    const result = await this.runCommand(expanded, {
      cwd: review.dir,
      env: { ...companyEnvironment(environment), ...review.env },
      timeoutMs: this.readTimeoutMs,
    })
    if (result.code !== 0) throw new Error(`review logs failed: ${detailOf(result)}`)
    return result.stdout === '' ? result.stderr : result.stdout
  }

  /**
   * Open the card's directory in the editor, or the `*.code-workspace` it
   * carries (the workspace file is what the human's environment expects, and
   * its relative folder entries point at the worktree). A missing editor binary
   * rejects, so the card can say why nothing opened.
   */
  async openInEditor(task: TaskRecord): Promise<string> {
    const plan = this.plan(task)
    const target = plan.workspaceFile ?? plan.dir
    if (target === undefined) throw new Error('the card has no directory to open')
    await this.launchApp(this.editorCommand, [EDITOR_NEW_WINDOW_FLAG, target])
    return target
  }

  /**
   * `git diff --stat` of the reviewed commit against the base branch: what the
   * human is looking at, without opening the repository. A card that was never
   * parked (no reviewed commit) has nothing to compare and reads as an empty
   * diff instead of an error.
   */
  async reviewDiff(task: TaskRecord): Promise<string> {
    const git = task.git
    const base = git?.base
    const commit = git?.reviewedCommit
    if (git === undefined || base === undefined || commit === undefined) return ''
    const cwd = this.directory(task) ?? git.repoPath
    const result = await this.runFixed('git', ['--no-pager', 'diff', '--stat', '--no-color', base, commit], { cwd, timeoutMs: this.readTimeoutMs })
    if (result.code !== 0) throw new Error(`git diff failed: ${detailOf(result)}`)
    return result.stdout
  }

  /**
   * Environment of one command run: the assigned ports first (remembered on the
   * card, so a re-start keeps the URL the human already has open), then the
   * workspace's own `KEY=VALUE` pairs, then the docker context as
   * `DOCKER_CONTEXT` (docker's own convention, which is what makes a groove
   * command land on the intended daemon).
   */
  private async commandEnv(task: TaskRecord, environment: ReviewEnvironmentConfig): Promise<Record<string, string>> {
    const ports = await resolveComposeEnv(environment.env ?? '', task, {
      base: this.portBase,
      ...(task.review?.env === undefined ? {} : { previous: task.review.env }),
    })
    return { ...companyEnvironment(environment), ...ports }
  }
}

/** Workspace-level environment of one entry (context only, ports come later). */
function companyEnvironment(environment: ReviewEnvironmentConfig | undefined): Record<string, string> {
  return environment?.dockerContext === undefined ? {} : { DOCKER_CONTEXT: environment.dockerContext }
}

/** Substitute `{port}`/`{port2}` …/`{task}` in a command text. */
function expandCommand(command: string, env: Readonly<Record<string, string>>, taskId: string): string {
  return command
    .replaceAll('{task}', taskId)
    .replace(/\{port([2-9])?\}/g, (_match, digit: string | undefined) => env[digit === undefined ? 'DSH_COMPOSE_PORT' : `DSH_COMPOSE_PORT${digit}`] ?? '')
}
