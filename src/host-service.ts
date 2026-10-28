import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, loadavg } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { nextRunAtMs } from './core/schedule.ts'
import { reusableSessionId } from './core/session-reuse.ts'
import { taskLane } from './core/tasks.ts'
import { HostTaskLedger, type OpenedRun, type OpenExecutionReference, type PausedRun, type ResumedRun, type ReviewIntent } from './host-ledger.ts'
import type { TaskCompose, TaskRecord as ComposeTaskRecord, TaskReview } from './core/tasks.ts'
import { ComposeWorkflow, composeDir, composeProject, type TaskComposeController } from './compose-workflow.ts'
import { ReviewWorkflow } from './review-workflow.ts'
import { HostExecutionRunner, SessionLaunchError, type GatewayPeer, type SessionCommandDispatcher, type SessionControl, type SessionSummary, type TaskBoardWorkspaceRegistry } from './host-runner.ts'
import type { CommandRunner } from './command-runner.ts'
import { GitWorkflow } from './git-workflow.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import { PRESSURE_MAX_HOLD_MS, PRESSURE_SAMPLE_MS, PressureMonitor } from './core/pressure.ts'
import { dshHome } from './dsh-home.ts'
import {
  TASK_BOARD_SCHEMA_VERSION,
  type TaskBoardAction,
  type TaskBoardActionResult,
  type TaskBoardEventPayload,
  type TaskBoardHealth,
  type TaskBoardPendingWork,
  type TaskBoardPressure,
  type TaskBoardQueueEntry,
  type TaskBoardReviewPlan,
  type TaskBoardReviewRequest,
  type TaskBoardReviewResponse,
  type TaskBoardSnapshot,
} from './protocol.ts'
import type { TaskPermission } from './core/handover.ts'

const SESSION_POLL_MS = 5_000
const SCHEDULE_TICK_MS = 30_000
const RESUME_GAP_MS = SCHEDULE_TICK_MS + 15_000
/**
 * How long one action may stay inside its lane before the Host reports a
 * timeout and frees the lane. Deliberately longer than the browser's 20 s
 * action timeout: the browser retries idempotently while the Host keeps its
 * answer, and a stuck pause must not block the next action of the same card
 * (or the global lanes) forever.
 */
const ACTION_APPLY_TIMEOUT_MS = 25_000
/** How long one pause's session stop may take before the Host says it failed. */
const PAUSE_STOP_TIMEOUT_MS = 12_000

/** Action lanes: card actions stay ordered per card, bulk/import lanes are global. */
function actionLaneKey(action: TaskBoardAction): string {
  switch (action.kind) {
    case 'import':
    case 'create':
    case 'move-many':
    case 'pause':
    case 'resume':
    case 'pause-all':
    case 'resume-all':
      return '*'
    default:
      return 'taskId' in action ? action.taskId : '*'
  }
}

/**
 * Bound one Host-side action. The underlying work is not cancelled (a ledger
 * write cannot be half-undone); the promise the lane waits on is, so one stuck
 * call cannot hold its lane — and, since lanes are per card or global, never
 * the whole board.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: no completion within ${Math.round(timeoutMs / 1_000)} s`))
    }, timeoutMs)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Whether two task→session maps name the same cards and conversations. */
function sameAnswerMap(current: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(current).length) return false
  return keys.every(key => current[key] === next[key])
}

/**
 * Read and consume the external watchdog's "I restarted the Host" notice. The
 * watchdog writes it right before `dsh-stop --restart`; the fresh Host turns it
 * into a board notice and deletes the file, so a human sees *why* the GUI came
 * back instead of guessing.
 * @param path - notice file (tests), default `$DSH_HOME/task-board/watchdog-notice.json`.
 */
function readWatchdogNotice(path?: string): { at: number; reason?: string } | undefined {
  const file = path ?? join(dshHome(), 'task-board', 'watchdog-notice.json')
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown; reason?: unknown }
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
    return { at: raw.at, ...(typeof raw.reason === 'string' && raw.reason !== '' ? { reason: raw.reason } : {}) }
  } catch {
    return undefined
  } finally {
    try { rmSync(file, { force: true }) } catch { /* a stale notice file is harmless */ }
  }
}

export class TaskBoardHostService {
  readonly ledger: HostTaskLedger
  readonly runner: HostExecutionRunner
  readonly power: PowerInhibitor
  /** Shared git integration: branch hooks in the ledger, checkout before a run. */
  readonly git: GitWorkflow
  /** Task-scoped Docker Compose environments: up before a run, down afterwards. */
  readonly compose: TaskComposeController
  /** Review environments: the card's version, started and stopped from the review column. */
  readonly review: ReviewWorkflow
  private readonly listeners = new Set<() => void>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private lastScheduleTick: number | undefined
  private disposed = false
  private pollInFlight = false
  private tickInFlight = false
  private active = true
  /**
   * Ids the last roster poll saw as present and idle; undefined while the
   * roster is unknown. Session reuse (issue #1419) requires this positive
   * evidence, so a launch before the first successful poll mints a fresh
   * conversation instead of prompting into a session it cannot see.
   *
   * Deliberately *not* an input to the WIP accounting: the roster only knows
   * whether a turn is running right now, which is not the same as "the run is
   * over". An implementation run whose agent ended its turn (mid-task question,
   * partial answer) is idle in the roster while its worktree, branch and card
   * are still owned by it — letting the lane's next card start there is exactly
   * the parallel work the WIP limit exists to prevent.
   */
  private idleSessionIds: ReadonlySet<string> | undefined
  private preventIdleSleep = false
  /** Runs waiting for a free WIP slot, in arrival order. */
  private launchQueue: OpenedRun[] = []
  /** Per-lane launches already started whose session is not attached yet (invisible to the ledger). */
  private readonly launchesInFlight = new Map<string, number>()
  /**
   * WIP limit per workspace/lane: how many implementation runs may hold a
   * session at once (always >= 1). Clarification runs are exempt.
   */
  private maxConcurrentRuns = 1
  /**
   * Rework watch: per card in a settled column (`ready_for_test`/`failed`), the
   * `updatedAt` its conversation had when it was last read. An unchanged chat
   * costs no history RPC; the entry is dropped as soon as the card leaves the
   * watched columns. See {@link watchReworkChats}.
   */
  private readonly reworkScans = new Map<string, number>()
  /**
   * Card id → the conversation waiting for the human's answer. Derived from the
   * conversations on every poll and never written to the ledger: the question is
   * the chat's, the board only points at it. A card that is answered drops out
   * again, so the symbol appears with the question and leaves with the answer.
   */
  private awaitingAnswer: Record<string, string> = {}
  /**
   * Per conversation, the verdict of the last question read plus the roster row
   * it was read from. A chat only changes when an event lands, so an unchanged
   * row costs no history RPC. See {@link refreshAwaitingAnswers}.
   */
  private readonly answerWatches = new Map<string, { updatedAt: number; running: boolean; awaiting: boolean }>()
  private lastPowerJson = ''
  /**
   * Card environments the board brought up (card id → project), plus the
   * directory each project lives in. The ledger holds the same record on the
   * card; this map is what lets the Host tear a project down after the card is
   * gone (deleted, archived, or dropped from the ledger entirely).
   */
  private readonly composeProjects = new Map<string, { project: string; dir: string }>()
  private composeBusy = false
  /**
   * Review environments the board started (card id → its record), plus the
   * action currently in flight per card. The map is what survives a card's
   * deletion — the record is gone, the environment it started is not — and it is
   * the only marker of "the board started this one", which is exactly what the
   * automatic cleanup is allowed to stop. The in-flight marker is deliberately
   * in memory: a Host restart must not leave a card claiming a start it never
   * finished, and the buttons are then simply enabled again.
   */
  private readonly reviewEnvs = new Map<string, TaskReview>()
  private readonly reviewBusy = new Map<string, 'start' | 'stop' | 'restart'>()
  /**
   * Archived cards whose worktree removal failed once. The removal is retried
   * every poll; this set only keeps the warning from repeating alongside it
   * (the card stays in it until the directory is gone).
   */
  private readonly worktreeWarnings = new Set<string>()
  /** Per-card review action chain: a second review click waits for the first. */
  private readonly reviewWork = new Map<string, Promise<void>>()
  /** Card id → controller aborting its running review/release command. */
  private readonly workControllers = new Map<string, AbortController>()
  /**
   * Action lanes: card actions stay ordered per card, while bulk actions,
   * imports and moves run on lanes of their own. One stuck action can therefore
   * never hold the whole board's actions — the incident this replaces was a
   * single global chain in which a slow session stop delayed every later
   * action, including "Pause all".
   */
  private readonly actionLanes = new Map<string, Promise<void>>()
  /** When the Host last finished an action (accepted or refused), for the health route. */
  private lastActionResultAt: number | undefined
  /**
   * Machine pressure (load per core and event-loop delay), sampled every
   * {@link PRESSURE_SAMPLE_MS}. It gates new launches and explains them on the
   * card; the OS timer is what samples it, so an inactive board still measures.
   */
  private readonly pressureMonitor: PressureMonitor
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 })
  /** Cards whose launch was already explained as "starting anyway under load". */
  private readonly pressureBypassed = new Set<string>()
  /** Parse lane statistics for the health route and the overload gate. */
  private parseInFlight = 0
  private lastParseMs: number | undefined
  private lastParseAt: number | undefined
  /** Set right after the external watchdog restarted the Host (read from its notice file). */
  private readonly watchdogNotice: { at: number; reason?: string } | undefined
  private readonly bootAt: number
  /** Outcomes waiting for the next SSE frame (bounded; the browser resolves its outbox from them). */
  private readonly actionResults: TaskBoardActionResult[] = []
  /**
   * Last task objects a delta was built from, keyed by id. The ledger replaces a
   * changed card with a new object, so an identity comparison is the cheapest
   * correct "what changed since the last frame".
   */
  private lastSentTasks = new Map<string, ComposeTaskRecord>()
  /**
   * The frame of the last emit. Computed once per change, not per connected
   * tab: the delta advances the sent-task baseline and drains the action
   * results, so a second tab reading it separately would see neither.
   */
  private pendingFrame: TaskBoardEventPayload | undefined
  /** Human messages a hard stop removed from a card's inbox, re-sent on resume. */
  private readonly preservedMessages = new Map<string, string[]>()
  /** Command runner the Host entry injected (worker-backed); absent in tests. */
  private readonly commandRunner?: CommandRunner
  /** Last `updatedAt` the orphan watchdog read a conversation at (per session). */
  private readonly orphanScans = new Map<string, number>()
  /** Sessions the watchdog already explained, so one orphan is not toasted every 5 s. */
  private readonly orphanNoticed = new Set<string>()
  /** Card id → its conversation is running right now (roster, derived). */
  private runningSessions: Record<string, true> = {}
  /** Derived plan per review-column card (see {@link refreshReviewPlans}). */
  private reviewPlans: Record<string, TaskBoardReviewPlan> = {}
  private readonly now: () => number
  /** Event-loop p95 reader (the real histogram in production, a constant in tests). */
  private readonly eventLoopP95Ms: () => number

  constructor(gateway: TypertGateway, options: {
    ledger?: HostTaskLedger
    power?: PowerInhibitor
    now?: () => number
    commandDispatcher?: SessionCommandDispatcher
    workspaceRegistry?: TaskBoardWorkspaceRegistry
    sessionDefaultPermission?: TaskPermission
    git?: GitWorkflow
    /** Docker Compose environments per card; omit for the default workflow. */
    compose?: TaskComposeController
    /** Compose file inside the card's worktree (settings `composeFile`). */
    composeFile?: string
    /** Review environments of the cards; omit for the default workflow. */
    review?: ReviewWorkflow
    /** Machine config applied to a freshly built ledger (settings `stateMachine`). */
    stateMachine?: unknown
    /** Operator Peer the gateway calls speak for; dsh 0.2.1 requires one. */
    peer?: GatewayPeer
    /**
     * Runner for the heavy commands (git, docker, review). The Host entry passes
     * the worker-backed runner so card work never shares its event loop and
     * "Abbrechen" can kill a running command. Absent: each workflow's own
     * in-process runner (tests).
     */
    commandRunner?: CommandRunner
    /** Live agent/job handles for the escalating stop (Host entry only). */
    sessionControl?: SessionControl
    /**
     * The machine-pressure reader. Tests inject a monitor with a fixed clock and
     * load so the launch gate is deterministic; the Host entry uses the real one.
     */
    pressure?: PressureMonitor
    /** Event-loop p95 for the next pressure sample; tests pass a constant. */
    eventLoopP95?: () => number
    /**
     * Where the external watchdog leaves its "I restarted the Host" notice. The
     * Host reads it once at boot and turns it into a board notice; tests point it
     * at a temp file.
     */
    watchdogNoticePath?: string
  } = {}) {
    const commandRunner = options.commandRunner
    this.commandRunner = commandRunner
    this.git = options.git ?? new GitWorkflow(options.workspaceRegistry, commandRunner === undefined ? {} : { runner: commandRunner })
    this.compose = options.compose ?? new ComposeWorkflow({
      ...(options.composeFile === undefined ? {} : { file: options.composeFile }),
      ...(commandRunner === undefined ? {} : { runner: commandRunner }),
    })
    this.review = options.review ?? new ReviewWorkflow({
      compose: this.compose,
      ...(options.workspaceRegistry === undefined ? {} : { workspaceRegistry: options.workspaceRegistry }),
      // The review resolves a card without git state through the same repository
      // discovery the git flow uses (the `repoSubpath` setting), so the worktree
      // link and the configured commands address the repository, not the folder
      // that contains it.
      repoDirectory: workspacePath => this.git.repositoryOf(workspacePath),
      ...(commandRunner === undefined ? {} : {
        runCommand: async (command: string, runOptions: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; scope?: string }) => {
          const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
          const onAbort = (): void => { if (runOptions.scope !== undefined) commandRunner.cancelScope(runOptions.scope) }
          runOptions.signal?.addEventListener('abort', onAbort, { once: true })
          try {
            const result = await commandRunner.run({
              command: shell,
              args: ['-lc', command],
              cwd: runOptions.cwd,
              env: runOptions.env,
              timeoutMs: runOptions.timeoutMs,
              ...(runOptions.scope === undefined ? {} : { scope: runOptions.scope }),
            })
            return { code: result.aborted ? -1 : result.code ?? -1, stdout: result.stdout, stderr: result.aborted ? `${result.stderr}\ncancelled by the operator` : result.stderr }
          } finally {
            runOptions.signal?.removeEventListener('abort', onAbort)
          }
        },
        runFixed: async (command: string, args: readonly string[], runOptions: { cwd: string; timeoutMs: number; signal?: AbortSignal; scope?: string }) => {
          const onAbort = (): void => { if (runOptions.scope !== undefined) commandRunner.cancelScope(runOptions.scope) }
          runOptions.signal?.addEventListener('abort', onAbort, { once: true })
          try {
            const result = await commandRunner.run({
              command,
              args,
              cwd: runOptions.cwd,
              timeoutMs: runOptions.timeoutMs,
              ...(runOptions.scope === undefined ? {} : { scope: runOptions.scope }),
            })
            return { code: result.aborted ? -1 : result.code ?? -1, stdout: result.stdout, stderr: result.aborted ? `${result.stderr}\ncancelled by the operator` : result.stderr }
          } finally {
            runOptions.signal?.removeEventListener('abort', onAbort)
          }
        },
      }),
    })
    this.ledger = options.ledger ?? new HostTaskLedger(undefined, undefined, { sessionDefaultPermission: options.sessionDefaultPermission, git: this.git, stateMachine: options.stateMachine })
    this.runner = new HostExecutionRunner(gateway, options.commandDispatcher, options.workspaceRegistry, undefined, options.peer, options.sessionControl)
    this.power = options.power ?? new PowerInhibitor()
    this.now = options.now ?? Date.now
    this.bootAt = this.now()
    this.pressureMonitor = options.pressure ?? new PressureMonitor({
      now: this.now,
      load1: () => loadavg()[0] ?? 0,
      cores: () => Math.max(1, cpus().length),
    })
    this.eventLoopP95Ms = options.eventLoopP95 ?? (() => {
      const p95 = this.loopDelay.percentile(95) / 1e6
      this.loopDelay.reset()
      return Number.isFinite(p95) ? p95 : 0
    })
    this.pressureMonitor.sample(this.eventLoopP95Ms())
    this.watchdogNotice = readWatchdogNotice(options.watchdogNoticePath)
    if (this.watchdogNotice !== undefined) {
      this.ledger.note(undefined, `Der Watchdog hat den Host automatisch neu gestartet${this.watchdogNotice.reason === undefined ? '' : ` (${this.watchdogNotice.reason})`}.`)
    }
    // Environments survive a Host restart (the review keeps its stack); the
    // ledger is the record of what is running, so seed the project map from it.
    this.seedComposeProjects()
    this.seedReviewEnvironments()
    installStreamErrorGuards()
    this.ledger.subscribe(() => {
      this.syncPowerReasons()
      this.refreshReviewPlans()
      // A background release that hit a conflict opens a merge run without an
      // action request; the ledger hands it over on the next notification.
      for (const run of this.ledger.takeRuns()) this.scheduleLaunch(run)
      this.emit()
      // A settle frees its lane's WIP slot, so the next queued run starts here.
      this.pumpLaunchQueue()
    })
    this.power.subscribe(() => {
      // updateReasons emits on every poll tick even when nothing changed;
      // gate on the actual snapshot so the 5 s heartbeat does not push an
      // empty SSE frame per tab forever.
      const json = JSON.stringify(this.power.snapshot())
      if (json === this.lastPowerJson) return
      this.lastPowerJson = json
      this.emit()
    })
    // The delta baseline starts at the state the Host booted with: a browser
    // that connects later receives a full snapshot, every later frame only the
    // cards that changed.
    this.lastSentTasks = new Map(this.ledger.tasksReference().map(task => [task.id, task]))
  }

  start(): void {
    if (this.disposed || this.timers.length > 0) return
    this.syncPowerReasons()
    this.timers.push(setInterval(() => { this.schedulePoll() }, SESSION_POLL_MS))
    this.timers.push(setInterval(() => { this.scheduleTick(false) }, SCHEDULE_TICK_MS))
    // Pressure is sampled on its own timer, not only on the 5 s poll: the board
    // must know how loaded the machine is even while no tab is open (the health
    // route and the launch gate both read it).
    this.timers.push(setInterval(() => { this.samplePressure() }, PRESSURE_SAMPLE_MS))
    this.samplePressure()
    this.schedulePoll()
    this.scheduleTick(true)
  }

  /**
   * One pressure sample plus the two reactions that matter: publish a changed
   * level (the cards explain held runs from it) and re-pump the launch queue
   * when the machine is no longer overloaded.
   */
  samplePressure(): TaskBoardPressure {
    const previous = this.pressureMonitor.snapshot().level
    const next = this.pressureMonitor.sample(this.eventLoopP95Ms())
    if (next.level !== previous) {
      if (next.level === 'overloaded') {
        this.ledger.note(undefined, `System ausgelastet (Last ${next.load1.toFixed(1)} auf ${next.cores} Kernen${next.loopP95Ms >= 100 ? `, Event-Loop p95 ${next.loopP95Ms} ms` : ''}) — neue Läufe warten.`)
      } else if (previous === 'overloaded') {
        this.ledger.note(undefined, 'Die Last ist wieder gesunken — wartende Läufe starten.')
      }
      this.emit()
      if (previous === 'overloaded') this.pumpLaunchQueue()
    }
    return next
  }

  /** The current machine pressure (no new sample). */
  pressure(): TaskBoardPressure {
    return this.pressureMonitor.snapshot()
  }

  /**
   * The board's health face, read by the external watchdog and by a human
   * debugging a slow GUI. Aggregates only — no card titles, no conversations.
   */
  health(): TaskBoardHealth {
    const pressure = this.pressureMonitor.snapshot()
    const runtime = this.ledger.runtimeView()
    const paused = this.ledger.tasksReference().filter(task => task.archivedAt === undefined && task.pausedAt !== undefined).length
    return {
      ok: true,
      at: this.now(),
      uptimeMs: Math.max(0, this.now() - this.bootAt),
      active: this.active,
      pressure,
      runs: {
        open: runtime.openExecutions.length,
        sessions: Object.keys(this.runningSessions).length,
        queued: this.launchQueue.length,
        paused,
      },
      actions: {
        lanes: this.actionLanes.size,
        ...(this.lastActionResultAt === undefined ? {} : { lastResultAt: this.lastActionResultAt }),
      },
      parse: {
        inFlight: this.parseInFlight,
        ...(this.lastParseMs === undefined ? {} : { lastMs: this.lastParseMs }),
        ...(this.lastParseAt === undefined ? {} : { lastAt: this.lastParseAt }),
      },
      ...(this.watchdogNotice === undefined ? {} : { watchdog: { ...this.watchdogNotice } }),
    }
  }

  /**
   * Claim the parse lane for one request. Returns the release callback: the
   * form's model call is the one Host operation a human waits on, so the health
   * route and the overload gate both see how many are in flight.
   */
  beginParse(): () => void {
    this.parseInFlight += 1
    const startedAt = this.now()
    let released = false
    return () => {
      if (released) return
      released = true
      this.parseInFlight = Math.max(0, this.parseInFlight - 1)
      this.lastParseMs = Math.max(0, this.now() - startedAt)
      this.lastParseAt = this.now()
    }
  }

  setConfiguration(active: boolean, preventIdleSleep: boolean): void {
    const resumed = !this.active && active
    this.active = active
    this.preventIdleSleep = preventIdleSleep
    if (resumed) {
      const current = this.power.snapshot()
      this.power.updateReasons({
        runningSessions: current.runningSessions,
        armedSchedules: this.armedSchedules(),
        sessionStateKnown: false,
      })
    }
    this.power.setEnabled(active && preventIdleSleep)
    if (resumed) {
      this.schedulePoll()
      this.scheduleTick(true)
    }
    this.emit()
  }

  /**
   * Apply the board's WIP limit (settings namespace `task-board`,
   * `maxConcurrentRuns`) per workspace/lane. Lowering the limit never aborts a
   * running task: the surplus slots drain as their executions settle while the
   * queue holds the remaining launches back.
   * @param limit - configured maximum per lane; values below 1 or non-finite mean 1.
   */
  setMaxConcurrentRuns(limit: number): void {
    const next = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
    if (next === this.maxConcurrentRuns) return
    this.maxConcurrentRuns = next
    this.pumpLaunchQueue()
    // The board explains its waiting cards with this limit; a changed setting
    // has to reach every open tab (the event frame carries it).
    this.emit()
  }

  /**
   * Apply the board's Done-column limit (settings namespace `task-board`,
   * `maxDoneTasks`). The ledger trims an over-limit `done` column right away
   * and keeps enforcing it on every later move into `done` (oldest cards first,
   * FIFO).
   * @param limit - configured maximum; values below 1 or non-finite keep the default.
   */
  /**
   * Point the compose integration at another file (settings `composeFile`); an
   * empty value disables task environments. Projects already running keep their
   * file — the setting decides what new runs bring up.
   */
  setComposeFile(file: string): void {
    if ('setFile' in this.compose && typeof this.compose.setFile === 'function') this.compose.setFile(file)
  }

  /**
   * Point the compose integration at another environment template (settings
   * `composeEnv`): `KEY=VALUE` pairs, `{port}` for a free per-card host port and
   * `{task}` for the card id.
   */
  setComposeEnv(env: string): void {
    if ('setEnv' in this.compose && typeof this.compose.setEnv === 'function') this.compose.setEnv(env)
  }

  /**
   * Apply the review setups (settings `reviewEnvironments`): one entry per
   * workspace directory, with the start/stop/restart/logs commands, the optional
   * URL template, docker context and environment. An invalid document is
   * reported as a whole — the entries that parse stay in force, so one typo does
   * not silently disable every other workspace — and the derived plans are
   * re-published, because a workspace that just gained a start command must show
   * its buttons without a ledger change.
   * @param value - raw setting (JSON text or the parsed array).
   * @returns the reasons of every entry that was refused (empty when all parsed).
   */
  setReviewEnvironments(value: unknown): string[] {
    const errors = this.review.configure(value)
    this.refreshReviewPlans()
    this.emit()
    return errors
  }

  /** Point the worktree link at another editor binary (settings `editorCommand`). */
  setEditorCommand(command: string): void {
    this.review.setEditorCommand(command)
  }

  /**
   * Apply the `repoSubpath` setting (one entry per workspace directory, naming
   * the repository inside it) to the git workflow. Invalid entries are reported
   * as a whole — the entries that parse stay in force — and the review plans are
   * re-published, because a workspace that just gained a repository must show its
   * worktree link without a ledger change.
   * @param value - raw setting (JSON text or the parsed array).
   * @returns the reasons of every entry that was refused (empty when all parsed).
   */
  setRepoSubpaths(value: unknown): string[] {
    if (!('configure' in this.git) || typeof this.git.configure !== 'function') return []
    const errors = this.git.configure(value)
    this.refreshReviewPlans()
    this.emit()
    return errors
  }

  /**
   * Recompute the derived review plans: what the review column offers each card
   * (directory, worktree or main-checkout fallback, editor target, whether there
   * is anything to start) plus the action currently in flight. Called on every
   * ledger change and on every settings change, and never persisted — the plan
   * is a projection of the filesystem and the settings, not of the ledger.
   */
  private refreshReviewPlans(): void {
    const next: Record<string, TaskBoardReviewPlan> = {}
    for (const task of this.ledger.reviewCandidates()) {
      const pending = this.reviewBusy.get(task.id)
      next[task.id] = { ...this.review.plan(task), ...(pending === undefined ? {} : { pending }) }
    }
    this.reviewPlans = next
  }

  /**
   * Seed the review bookkeeping from the ledger: a record with a `startedAt`
   * stamp is a version the board started, so a Host restart re-attaches it
   * (the very thing the automatic cleanup has to be able to stop later) instead
   * of forgetting an environment the human can still see on the card.
   */
  private seedReviewEnvironments(): void {
    for (const task of this.ledger.reviewCandidates()) {
      if (task.review?.startedAt === undefined) continue
      this.reviewEnvs.set(task.id, task.review)
    }
    this.refreshReviewPlans()
  }

  setMaxDoneTasks(limit: number): void {
    this.ledger.setMaxDoneTasks(limit)
  }

  /**
   * Apply the board's state machine (settings namespace `task-board`, field
   * `stateMachine`). The ledger enforces the very machine the browser renders
   * drop targets from; an invalid config keeps the machine in force.
   * @param config - raw config; undefined keeps the shipped machine.
   * @returns the refusals of an invalid config (empty when it was applied).
   */
  setStateMachine(config: unknown): string[] {
    return this.ledger.setStateMachine(config)
  }

  snapshot(): TaskBoardSnapshot {
    return this.snapshotWith(this.ledger.state())
  }

  /**
   * Build the wire snapshot from an already-read ledger state, so a caller that
   * has one (the action path) never pays for a second whole-ledger clone.
   */
  private snapshotWith(state: { revision: number; tasks: readonly ComposeTaskRecord[]; scheduler: TaskBoardSnapshot['scheduler'] }): TaskBoardSnapshot {
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: state.revision,
      tasks: [...state.tasks],
      scheduler: state.scheduler,
      power: this.power.snapshot(),
      sessionDefaultPermission: this.ledger.sessionDefaultPermission,
      // The resolved machine travels with the state, so the browser validates
      // its drop targets against exactly what the Host enforces.
      stateMachine: this.ledger.stateMachine.toJSON(),
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxDoneTasks: this.ledger.maxDoneTasksLimit,
      awaitingAnswer: { ...this.awaitingAnswer },
      reviewPlans: { ...this.reviewPlans },
      pendingReleases: this.ledger.pendingReleases(),
      notices: this.ledger.notices(),
      pendingWork: this.pendingWork(),
      pressure: this.pressureMonitor.snapshot(),
      queued: this.queuedRuns(),
      ...(Object.keys(this.runningSessions).length === 0 ? {} : { runningSessions: { ...this.runningSessions } }),
    }
  }

  /**
   * SSE frame payload: every derived host field, plus only the cards that
   * changed since the previous frame. The first frame after a connection is a
   * full snapshot (the route sends it), so a board with hundreds of cards never
   * resends the ledger on a heartbeat.
   */
  eventPayload(): TaskBoardEventPayload {
    // One frame per change, shared by every connected tab (the delta advances
    // the sent-task baseline and drains the action results, so it must not be
    // computed per listener). It stays readable until the next change, which is
    // what lets a tab that reconnects right after an action still see its
    // result. Outside an emit the current delta is computed once.
    return this.pendingFrame ?? (this.pendingFrame = this.computeFrame())
  }

  private computeFrame(): TaskBoardEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    const next = new Map<string, ComposeTaskRecord>()
    const changed: ComposeTaskRecord[] = []
    for (const task of this.ledger.tasksReference()) {
      next.set(task.id, task)
      if (this.lastSentTasks.get(task.id) !== task) changed.push(task)
    }
    const removedTaskIds: string[] = []
    for (const id of this.lastSentTasks.keys()) if (!next.has(id)) removedTaskIds.push(id)
    this.lastSentTasks = next
    const actionResults = this.actionResults.splice(0, this.actionResults.length)
    return {
      revision,
      scheduler,
      power: this.power.snapshot(),
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxDoneTasks: this.ledger.maxDoneTasksLimit,
      // Rides the frame like the limits do: the flag is derived, so it never
      // bumps the ledger revision, and the 5 s heartbeat must still deliver it.
      awaitingAnswer: { ...this.awaitingAnswer },
      reviewPlans: { ...this.reviewPlans },
      pendingReleases: this.ledger.pendingReleases(),
      notices: this.ledger.notices(),
      pendingWork: this.pendingWork(),
      pressure: this.pressureMonitor.snapshot(),
      queued: this.queuedRuns(),
      ...(Object.keys(this.runningSessions).length === 0 ? {} : { runningSessions: { ...this.runningSessions } }),
      ...(changed.length === 0 ? {} : { tasks: changed }),
      ...(removedTaskIds.length === 0 ? {} : { removedTaskIds }),
      ...(actionResults.length === 0 ? {} : { actionResults }),
    }
  }

  private queuedRuns(): Record<string, TaskBoardQueueEntry> {
    if (this.launchQueue.length === 0) return {}
    const pressure = this.pressureMonitor.snapshot().level === 'overloaded'
    const queued: Record<string, TaskBoardQueueEntry> = {}
    for (const opened of this.launchQueue) {
      // The reason is the honest one: either the lane's slot is taken, or the
      // machine is overloaded and the Host deliberately holds every launch.
      queued[opened.task.id] = { reason: pressure ? 'pressure' : 'wip', since: opened.execution.startedAt }
    }
    return queued
  }

  /**
   * Work in flight per card, for the card's "Abbrechen" control. Derived from
   * the service's own queues and the command runner's live scopes; never ledger
   * state.
   */
  private pendingWork(): Record<string, TaskBoardPendingWork> {
    const work: Record<string, TaskBoardPendingWork> = {}
    const now = this.now()
    for (const [taskId, release] of Object.entries(this.ledger.pendingReleases())) {
      work[taskId] = { kind: 'release', startedAt: release.startedAt }
    }
    for (const taskId of this.reviewBusy.keys()) {
      work[taskId] = { kind: 'review', startedAt: work[taskId]?.startedAt ?? now }
    }
    for (const taskId of this.commandRunner?.busyScopes() ?? []) {
      if (work[taskId] === undefined) work[taskId] = { kind: 'command', startedAt: now }
    }
    return work
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async apply(requestId: string, action: TaskBoardAction, initiator?: string): Promise<TaskBoardSnapshot> {
    if (!this.active) throw new Error('task board is disabled')
    // Manual actions never wait for the card's heavy git work. They used to run
    // behind `ledger.awaitCard`, which meant a pause could sit behind a commit,
    // a worktree creation or a rebase for minutes (the git safety net is 10
    // minutes) — while the human was pressing "stop" on a running agent. The
    // action is ledger-synchronous now; the work it opens is queued behind the
    // card's chain, and the one action that genuinely needs a finished commit
    // (the merge release) waits for it *inside its background job*.
    if (action.kind === 'cancel-work') {
      this.cancelWork(action.taskId)
      return this.snapshot()
    }
    if (action.kind === 'hard-stop') {
      this.hardStop(action.taskId)
      return this.snapshot()
    }
    if (action.kind === 'stop-session') {
      this.stopRunningSession(action.taskId)
      return this.snapshot()
    }
    const result = this.ledger.applyRequest(requestId, action, initiator)
    // A clarification run is a run: both go through the launch queue below, but
    // only the implementation run is gated by the lane WIP limit; the
    // clarification's kind decides the prompt and the exemption.
    if (result.run !== undefined) this.scheduleLaunch(result.run)
    if (result.clarification !== undefined) this.scheduleLaunch(result.clarification)
    // Background jobs (a release that hit a conflict) open runs without an
    // action request; the ledger hands them over here.
    for (const run of this.ledger.takeRuns()) this.scheduleLaunch(run)
    // The pause is already in the ledger (so the monitor no longer touches the
    // run); stopping the sessions happens next, off this call.
    for (const paused of result.paused ?? []) this.stopPausedRun(paused)
    // A card whose run already settled but whose conversation is still attached
    // (a background-job wake-up, or a failure settled before this Host) has no
    // open execution for the pause to suspend. The human's pause must still
    // reach that session, otherwise the button does nothing at all — the exact
    // shape of the incident this change is for.
    if (action.kind === 'pause') for (const taskId of action.taskIds) this.stopOrphanSession(taskId)
    // The bulk pause also reaches the board's conversations that no execution
    // backs any more (a late job wake-up): stopping only the runs would leave
    // exactly the work the human wanted to stop. The bulk resume has nothing
    // extra to do; the ledger already handed the runs to `resumePausedRun`.
    if (action.kind === 'pause-all') {
      for (const taskId of Object.keys(this.runningSessions)) this.stopOrphanSession(taskId)
      const stopped = result.paused ?? []
      this.ledger.note(undefined, stopped.length === 0
        ? 'Pause all: kein laufender Board-Lauf.'
        : `Pause all: ${stopped.length} laufende${stopped.length === 1 ? 'r Lauf' : ' Läufe'} pausiert.`)
    }
    if (action.kind === 'resume-all') {
      const released = result.resumed ?? []
      this.ledger.note(undefined, released.length === 0
        ? 'Fortsetzen: keine pausierte Karte.'
        : `Fortsetzen: ${released.length} Karte${released.length === 1 ? '' : 'n'} laufen weiter.`)
    }
    for (const resumed of result.resumed ?? []) this.resumePausedRun(resumed)
    // Review environments take minutes to come up (compose builds images, a
    // start script boots the app), so they are carried out off this call: the
    // card shows "starting" from the in-flight plan and the outcome is written
    // back to the ledger when it is known. A second review action on the same
    // card queues behind the first instead of being refused.
    for (const intent of result.review ?? []) this.scheduleReview(intent)
    // A queued release has already marked its card; publish that marker now.
    this.emit()
    return this.snapshotWith(result.state)
  }

  /**
   * Accept one action for the `202` route: enqueue it on the action lane and
   * answer at once. The outcome travels as an `action-result` event (the browser
   * resolves its outbox from it), and a replayed `requestId` is re-answered from
   * the ledger's request cache — the browser's retry after a reconnect gets the
   * same result again instead of applying the action twice.
   * @returns false when the board is disabled (the route answers 409).
   */
  acceptAction(requestId: string, action: TaskBoardAction, initiator?: string): boolean {
    if (!this.active) return false
    const key = actionLaneKey(action)
    const previous = this.actionLanes.get(key) ?? Promise.resolve()
    let tracked: Promise<void>
    const run = previous.then(async () => {
      try {
        await withTimeout(this.apply(requestId, action, initiator), ACTION_APPLY_TIMEOUT_MS, 'action-timeout')
        this.pushActionResult({ requestId, ok: true, at: this.now() })
      } catch (error) {
        this.pushActionResult({ requestId, ok: false, error: error instanceof Error ? error.message : String(error), at: this.now() })
      }
      this.lastActionResultAt = this.now()
      this.emit()
    })
    tracked = run.finally(() => {
      if (this.actionLanes.get(key) === tracked) this.actionLanes.delete(key)
    })
    this.actionLanes.set(key, tracked)
    return true
  }

  private pushActionResult(result: TaskBoardActionResult): void {
    this.actionResults.push(result)
    while (this.actionResults.length > 200) this.actionResults.shift()
  }

  /**
   * Abort the card's running work. The command runner kills every child in the
   * card's scope (commit, worktree, merge, review command, compose), the review
   * intent's controller aborts a wait that is not inside a command, and the card
   * keeps the visible reason. Idempotent: cancelling nothing is not an error.
   */
  cancelWork(taskId: string): void {
    this.workControllers.get(taskId)?.abort()
    const killed = this.commandRunner?.cancelScope(taskId) ?? 0
    this.ledger.note(taskId, killed > 0
      ? `Laufende Arbeit der Karte wurde abgebrochen (${killed} Befehl${killed === 1 ? '' : 'e'}).`
      : 'Laufende Arbeit der Karte wurde abgebrochen.')
  }

  /**
   * Stop the card's conversation for good, with the human's confirmation behind
   * the button: cancel the turn, kill the jobs, drop the queued input (this is
   * the destructive level — the pause preserves human messages, the hard stop
   * does not), force the agent to rest if the runtime disagrees, and settle the
   * open run as cancelled so the card leaves the run column instead of waiting
   * for a session that no longer works.
   */
  hardStop(taskId: string): void {
    const task = this.ledger.task(taskId)
    if (task === undefined) return
    const open = task.executions.filter(execution => execution.endedAt === undefined)
    const sessionId = latestSessionId(task)
    void (async () => {
      if (sessionId !== undefined) {
        const report = await this.runner.stopSession(sessionId, { preserveUserMessages: false })
        if (report.attached && !report.stopped) {
          this.ledger.note(taskId, 'Die Session ließ sich auch mit erzwungenem Reset nicht anhalten.')
          return
        }
      }
      for (const execution of open) this.ledger.settle(taskId, execution.id, 'cancelled', 'Session hart gestoppt (offline).')
      this.ledger.note(taskId, 'Session hart gestoppt; der Lauf wurde als abgebrochen abgerechnet.')
    })().catch(error => { safeConsoleError(`[dsh-task-board] hard stop of task ${taskId} failed`, error) })
  }

  /**
   * Queue one review action on the card's review chain: a second click on the
   * same card waits for the first action instead of being refused. The card's
   * derived plan shows `pending` while anything is queued, and the buttons stay
   * usable (`reviewBusy` is only the UI's in-flight explanation, never a fence).
   */
  private scheduleReview(intent: ReviewIntent): void {
    this.reviewBusy.set(intent.taskId, intent.intent)
    this.refreshReviewPlans()
    this.emit()
    const controller = new AbortController()
    this.workControllers.set(intent.taskId, controller)
    const previous = this.reviewWork.get(intent.taskId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      await this.runReviewIntent(intent, controller.signal)
    }).catch(error => {
      safeConsoleError(`[dsh-task-board] review action ${intent.intent} failed for task ${intent.taskId}`, error)
    })
    this.reviewWork.set(intent.taskId, operation)
    void operation.finally(() => {
      if (this.workControllers.get(intent.taskId) === controller) this.workControllers.delete(intent.taskId)
      if (this.reviewWork.get(intent.taskId) === operation) this.reviewWork.delete(intent.taskId)
      if (!this.reviewWork.has(intent.taskId)) this.reviewBusy.delete(intent.taskId)
      this.refreshReviewPlans()
      this.emit()
    }).catch(() => {})
  }

  /**
   * Carry out one review action and write its outcome back to the card. The
   * record is always written — a failure keeps the environment's identity and
   * the reason, so the card can explain itself instead of silently doing
   * nothing. `restart` is a stop (when something runs) followed by a start;
   * `stop` on a card that never started is a no-op the Host still reports as
   * stopped.
   */
  private async runReviewIntent(intent: ReviewIntent, signal?: AbortSignal): Promise<void> {
    // Read the card fresh: the ledger may have moved it out of the review
    // column (or dropped it) while this action waited in the card's queue.
    const task = this.ledger.task(intent.taskId)
    if (task === undefined) {
      this.reviewEnvs.delete(intent.taskId)
      return
    }
    if (task.archivedAt !== undefined || task.status !== 'ready_for_test') {
      // The review controls only exist in the review column; a queued action
      // that lost its column is dropped instead of staring a stack for a card
      // that is no longer under review.
      return
    }
    const current = this.reviewEnvs.get(task.id) ?? task.review
    try {
      if (intent.intent === 'stop') {
        // Nothing the board started: there is no environment to stop, and the
        // card's (possibly failed) record stays as it is.
        if (current === undefined) return
        await this.review.stop(task.id, current, signal)
        this.reviewEnvs.delete(task.id)
        this.forgetComposeRecord(task, current)
        this.ledger.noteReview(task.id, stoppedReview(current, this.now()))
        return
      }
      if (intent.intent === 'restart' && current !== undefined) {
        await this.review.stop(task.id, current, signal)
        this.reviewEnvs.delete(task.id)
        this.forgetComposeRecord(task, current)
      }
      const review = await this.review.start(task, signal)
      this.reviewEnvs.set(task.id, review)
      this.ledger.noteReview(task.id, review)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const described = current ?? this.review.describe(task)
      // A failed stop leaves the version possibly running: its record keeps the
      // running stamp, the reason is added, and the cleanup does not retry it
      // five seconds later (a broken stop command would only be hammered).
      const failed: TaskReview | undefined = intent.intent === 'stop'
        ? (described === undefined ? undefined : { ...described, error: message })
        : (described === undefined ? undefined : { ...described, startedAt: undefined, error: message })
      this.reviewEnvs.delete(task.id)
      if (failed !== undefined) this.ledger.noteReview(task.id, failed)
      // Re-thrown so the card's review chain logs it once; the card already says
      // what went wrong.
      throw error
    }
  }

  /**
   * Drop the run environment's record when it names the very project the review
   * just took down: the stack is gone, and the card must not keep showing "up
   * since …" for it.
   */
  private forgetComposeRecord(task: ComposeTaskRecord, review: TaskReview): void {
    if (review.mode !== 'compose' || task.compose === undefined) return
    if (task.compose.project === review.source) this.ledger.noteCompose(task.id, undefined)
  }

  /**
   * Read-only review work the browser asks for (open the worktree, read logs,
   * diff the reviewed commit). Every one of them is scoped to the named card —
   * its own directory, its own project — and every one answers with text or a
   * reason, so the panel never renders a raw exception.
   */
  async reviewOperation(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse> {
    const task = this.ledger.state().tasks.find(item => item.id === request.taskId)
    if (task === undefined) return { ok: false, error: 'task not found' }
    try {
      if (request.kind === 'open') {
        const target = await this.review.openInEditor(task)
        return { ok: true, text: target }
      }
      if (request.kind === 'diff') return { ok: true, text: await this.review.reviewDiff(task) }
      if (task.review === undefined) return { ok: false, error: 'this card has no review environment yet; start it first' }
      return { ok: true, text: await this.review.logs(task.id, task.review) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  dispose(): void {
    this.disposed = true
    this.launchQueue = []
    this.launchesInFlight.clear()
    this.awaitingAnswer = {}
    this.answerWatches.clear()
    this.reviewWork.clear()
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    this.loopDelay.disable()
    this.power.dispose()
    this.ledger.dispose()
    this.listeners.clear()
  }

  private async launch(opened: OpenedRun): Promise<void> {
    // A run that was paused while it waited for a WIP slot must not start; the
    // pump's self-heal drops its queue entry with the same effect, and this
    // guard covers the instant in between.
    if (this.ledger.isPaused(opened.task.id)) return
    // The queue's self-heal drops stale entries, but one can be dequeued and
    // superseded while its session is being created: never start a run the
    // ledger has already closed (it would mint the second conversation the card
    // must never have).
    if (!this.ledger.isOpenExecution(opened.task.id, opened.execution.id)) return
    // Wait for the card's queued branch/worktree creation and make sure the run
    // really stands on the feature branch. This is the only place a run waits for
    // git; the browser does not see it (the action was accepted into its outbox
    // long before) and the event loop stays free while the child git runs.
    let prepared: ComposeTaskRecord
    try {
      const branchTask = await this.ledger.ensureBranch(opened.task.id)
      if (branchTask === undefined) return
      prepared = branchTask
    } catch (error) {
      // A branch/worktree that cannot be created fails this run visibly before
      // the agent starts: working in the wrong checkout is worse than not starting.
      this.ledger.settle(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
      return
    }
    // The card may have been superseded (clarification go-ahead) while the branch
    // work was running; never mint the second conversation in that case.
    if (!this.ledger.isOpenExecution(opened.task.id, opened.execution.id)) return
    // The card's clarification run goes through this very queue, but not
    // through the lane limit: the clarification column is WIP-free, so it may
    // start next to a working run of the same workspace. Its session is the card's
    // clarification conversation, so it is continued rather than duplicated,
    // and its prompt is the run prompt plus the clarification addendum
    // (composed by the runner).
    const clarification = opened.execution.kind === 'clarify'
    // The automatic conflict resolution of a merge release is an ordinary run in
    // every structural respect, but its turn is the merge framing: the card's
    // feature is finished, and the only job is the conflict the Host left in the
    // worktree.
    const mergeRun = opened.execution.kind === 'merge'
    try {
      // Work happens on the card's feature branch: check it out in the pinned
      // workspace worktree before the session starts (no-op without git state).
      // A clarification run is exempt: it implements nothing, and checking a
      // branch out while a same-lane run is working would yank that run's
      // worktree out from under it.
      if (!clarification) await this.git.useBranch(prepared)
      // The card's development environment is part of its run: the stack is up
      // (and its ports known) before the agent gets its prompt. A clarification
      // round needs no environment — it implements nothing. A failed start
      // therefore fails the run, with docker's own output on the card.
      if (!clarification) await this.ensureCompose(prepared)
      // The environment record was written to the ledger above, and the prompt
      // names it: the run gets the refreshed card, not the pre-launch copy.
      const launched = this.ledger.state().tasks.find(task => task.id === opened.task.id) ?? prepared
      // A rework round continues the conversation it corrects, whether or not
      // the card opted into session reuse: the correction was written into that
      // chat, so a fresh session would lose it. There is nothing for the board
      // to deliver either — the human's own turn is the correction — the run
      // only has to frame the round.
      const rework = opened.execution.rework === true
      const reuseSessionId = reusableSessionId(
        opened.task,
        this.idleSessionIds,
        rework ? { rework: true } : {},
      )
      if (rework && reuseSessionId === undefined) {
        console.warn(`[dsh-task-board] rework for task ${opened.task.id} starts a fresh session: the corrected conversation is gone or busy, so its remarks are not in context`)
      }
      // Continuing the card's clarification conversation means the agent already
      // holds the card's instruction, its questions and their answers:
      // the run only has to be told to implement now. Any other session (a
      // fresh one, or a previous run's conversation) still needs the full prompt.
      const implement = !clarification && !mergeRun && reuseSessionId !== undefined && reuseSessionId === opened.task.clarificationSessionId
      const clarificationSessionId = opened.task.clarificationSessionId
      const sessionId = await this.runner.launch(launched, clarification
        ? {
            clarification: true,
            ...(clarificationSessionId === undefined ? {} : { reuseSessionId: clarificationSessionId }),
          }
        : {
            ...(reuseSessionId === undefined ? {} : { reuseSessionId }),
            ...(rework ? { rework: true } : {}),
            ...(implement ? { implement: true } : {}),
            ...(mergeRun ? { merge: true } : {}),
          })
      // Paused while the session was being created: stop the turn it may
      // already be running and keep the card paused. The session stays attached
      // as the run's conversation, so a later resume continues exactly there.
      // The runtime's cancel retains a prompt the agent has not picked up yet,
      // so that narrow window can still start: the card then stays paused until
      // the user resumes it (which continues the same conversation).
      if (this.ledger.isPaused(opened.task.id)) {
        try {
          await this.runner.cancel(sessionId)
        } catch (error) {
          safeConsoleError(`[dsh-task-board] could not stop the session of paused task ${opened.task.id}`, error)
        }
      }
      // Closed while the session was being created — a clarification round the
      // go-ahead superseded, which is the normal race because the clarification
      // column starts without waiting for a slot: the card owns exactly one
      // conversation, so this late session is stopped and never attached. The
      // implementation meanwhile opened its own.
      if (!this.ledger.isOpenExecution(opened.task.id, opened.execution.id)) {
        try {
          await this.runner.cancel(sessionId)
        } catch (error) {
          safeConsoleError(`[dsh-task-board] could not stop the superseded session of task ${opened.task.id}`, error)
        }
        return
      }
      this.ledger.attachSession(opened.task.id, opened.execution.id, sessionId)
    } catch (error) {
      // A session created before the prompt failed is still the card's
      // conversation (for a clarification: the chat the human answers in);
      // attach it so the link and the failure are both visible. A run the
      // ledger closed meanwhile owns no conversation any more.
      if (error instanceof SessionLaunchError && this.ledger.isOpenExecution(opened.task.id, opened.execution.id)) {
        this.ledger.attachSession(opened.task.id, opened.execution.id, error.sessionId)
      }
      this.ledger.settle(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Stop one paused run's session. The ledger pause is already written, so the
   * monitor has let the run go; the only job here is to end the agent's turn.
   * A session without a live agent (the run already finished, or the Host
   * restarted) is not an error worth freezing the card for: the pause is undone
   * and the normal monitor settles the run on its own.
   */
  private stopPausedRun(paused: PausedRun): void {
    const sessionId = paused.sessionId
    if (sessionId === undefined) return
    void (async () => {
      let report: Awaited<ReturnType<HostExecutionRunner['stopSession']>>
      try {
        // The stop is bounded: with the machine overloaded, a cancel that
        // never comes to rest must not leave the card silently "paused" while
        // its turn keeps working. On timeout the card keeps the pause (so no
        // new turn starts from the board) and the reason is visible; the
        // orphan watchdog retries on its next poll.
        report = await withTimeout(
          this.runner.stopSession(sessionId, { preserveUserMessages: true }),
          PAUSE_STOP_TIMEOUT_MS,
          'pause-stop-timeout',
        )
      } catch (error) {
        this.ledger.note(paused.taskId, `Die Session ließ sich nicht rechtzeitig anhalten (${error instanceof Error ? error.message : String(error)}); das Board versucht es erneut.`)
        return
      }
      if (report.preserved.length > 0) this.preservedMessages.set(paused.taskId, report.preserved)
      if (!report.attached && !report.stopped) {
        // The run already ended (or the Host restarted): there is nothing to
        // stop, and freezing the card would be wrong. Undo the pause so the
        // monitor can settle the run.
        this.ledger.clearPause(paused.taskId)
        return
      }
      // A stop that did not come to rest is the one case the human must see:
      // the card stays paused (so no new turn is started from the board) and the
      // watchdog keeps trying, but the reason is on the card instead of a
      // silent no-op.
      if (!report.stopped) {
        this.ledger.note(paused.taskId, 'Die Session ließ sich nicht anhalten; das Board versucht es beim nächsten Durchlauf erneut.')
        return
      }
      if (report.phaseReset) {
        this.ledger.note(paused.taskId, 'Die Session ließ sich nur mit einem erzwungenen Phasen-Reset anhalten.')
      }
    })().catch(error => { safeConsoleError('[dsh-task-board] pause handling failed', error) })
  }

  /**
   * Stop the conversation of a card that has no open run any more. Such a session
   * is invisible to the ledger's pause (there is no execution to suspend), yet it
   * is exactly what a late job wake-up leaves behind. The human's pause must
   * reach it; the card is not marked paused (it has no run to resume), the
   * session is simply stopped.
   */
  private stopOrphanSession(taskId: string): void {
    const task = this.ledger.task(taskId)
    if (task === undefined) return
    if (task.executions.some(execution => execution.endedAt === undefined)) return
    const sessionId = latestSessionId(task)
    if (sessionId === undefined) return
    void withTimeout(this.runner.stopSession(sessionId, { preserveUserMessages: true }), PAUSE_STOP_TIMEOUT_MS, 'orphan-stop-timeout').then(report => {
      if (report.preserved.length > 0) this.preservedMessages.set(taskId, report.preserved)
      if (report.attached && !report.stopped) {
        this.ledger.note(taskId, 'Die Session ließ sich nicht anhalten; das Board versucht es beim nächsten Durchlauf erneut.')
      }
    }).catch(error => { safeConsoleError(`[dsh-task-board] stopping the orphaned session of task ${taskId} failed`, error) })
  }

  /**
   * Continue a resumed run: write the "continue" turn into the run's own
   * conversation. A run that never got a session (it was still queued for a WIP
   * slot) goes back through the normal launch queue instead — there is no
   * conversation to continue, so it starts like any other run.
   */
  private resumePausedRun(resumed: ResumedRun): void {
    const sessionId = resumed.execution.sessionId
    if (sessionId === undefined) {
      this.scheduleLaunch({ task: resumed.task, execution: resumed.execution })
      return
    }
    const preserved = this.preservedMessages.get(resumed.task.id)
    if (preserved !== undefined) this.preservedMessages.delete(resumed.task.id)
    void (async () => {
      try {
        await this.runner.launch(resumed.task, {
          reuseSessionId: sessionId,
          resume: true,
          ...(preserved === undefined || preserved.length === 0 ? {} : { resumeMessages: preserved }),
        })
      } catch (error) {
        // The conversation is gone (deleted, or the Host lost it): the run
        // cannot continue, so it fails visibly instead of hanging in progress.
        this.ledger.settle(resumed.task.id, resumed.execution.id, 'failed', error instanceof Error ? error.message : String(error))
      }
    })().catch(error => { safeConsoleError('[dsh-task-board] resume handling failed', error) })
  }

  /** Re-attach the projects recorded in the ledger (they outlive a Host restart). */
  private seedComposeProjects(): void {
    for (const task of this.ledger.state().tasks) {
      const compose = task.compose
      if (compose === undefined || compose.startedAt === undefined || compose.error !== undefined) continue
      const dir = composeDir(task)
      if (dir !== undefined) this.composeProjects.set(task.id, { project: compose.project, dir })
    }
  }

  /**
   * Bring the card's Docker Compose environment up before its run starts, and
   * record project, ports and failures on the card. A card whose worktree holds
   * no compose file has no environment: that is the normal case, not an error.
   * The failure of a *configured* environment is not swallowed — the run fails,
   * because implementing against an environment that did not come up is worse
   * than not starting.
   */
  private async ensureCompose(task: ComposeTaskRecord): Promise<void> {
    if (this.disposed) return
    const dir = composeDir(task)
    if (dir === undefined) return
    // `up -d` is idempotent and cheap on a project that already runs, so it is
    // simply repeated: that way a stack removed behind the board's back (a
    // manual `docker compose down`, a Host restart after a prune) is back before
    // the agent starts, instead of being assumed alive.
    let compose: TaskCompose | undefined
    try {
      compose = await this.compose.up(task)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ledger.noteCompose(task.id, { project: task.compose?.project ?? composeProject(task), file: task.compose?.file ?? 'docker-compose.yml', error: message, startedAt: this.now() })
      throw error
    }
    if (compose === undefined) return
    this.composeProjects.set(task.id, { project: compose.project, dir })
    this.ledger.noteCompose(task.id, compose)
  }

  /**
   * Tear down every card environment that is no longer wanted: the stack lives
   * while the card runs or waits for the review, and stops as soon as it leaves
   * those columns, is archived, or disappears from the ledger (deleted). The map
   * is what covers the deleted card — its record is gone, the project name is
   * not. Nothing here blocks a ledger write: compose runs in the background.
   */
  private reconcileCompose(): void {
    if (this.disposed || this.composeProjects.size === 0) return
    const keep = new Set<string>()
    for (const task of this.ledger.state().tasks) {
      const wanted = task.archivedAt === undefined && (task.status === 'running' || task.status === 'ready_for_test')
      const record = this.composeProjects.get(task.id)
      if (record === undefined) continue
      if (wanted) keep.add(task.id)
      // A card that is back in a waiting column (or failed) keeps no stack; the
      // next run brings a fresh one up.
      else this.ledger.noteCompose(task.id, undefined)
    }
    for (const [taskId, entry] of [...this.composeProjects]) {
      if (keep.has(taskId)) continue
      this.composeProjects.delete(taskId)
      void this.compose.down(entry.project, entry.dir).catch(error => {
        safeConsoleError(`[dsh-task-board] could not stop the environment of task ${taskId}`, error)
      })
    }
  }

  /**
   * Tear down the review environments whose card left the review column, was
   * archived or disappeared from the ledger — but only what the board itself
   * started: a version the human brought up by hand is not the board's to kill,
   * which is why the record's `startedAt` (and this map) is the marker. The card
   * keeps its record, marked stopped, so a re-parked card starts its next review
   * on the very port the human already knows.
   *
   * A stop that fails stays visible on the card instead of being retried every
   * five seconds: the environment may still be running, and hammering a broken
   * stop command would not help.
   */
  private reconcileReview(): void {
    if (this.disposed || this.reviewEnvs.size === 0) return
    const wanted = new Set<string>()
    for (const task of this.ledger.reviewCandidates()) {
      if (this.reviewEnvs.has(task.id)) wanted.add(task.id)
    }
    for (const [taskId, review] of [...this.reviewEnvs]) {
      // A card that is still in the review column keeps its version; one whose
      // action is in flight is left alone until that action settles.
      if (wanted.has(taskId) || this.reviewBusy.has(taskId)) continue
      this.reviewEnvs.delete(taskId)
      void this.review.stop(taskId, review).then(() => {
        const task = this.ledger.task(taskId)
        if (task === undefined) return
        this.ledger.noteReview(taskId, stoppedReview(review, this.now()))
        // The compose project the review used is the same one a run brings up;
        // its record must not keep claiming a stack that is down again.
        if (task.compose !== undefined && review.mode === 'compose' && task.compose.project === review.source) {
          this.ledger.noteCompose(taskId, undefined)
        }
      }).catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        safeConsoleError(`[dsh-task-board] could not stop the review environment of task ${taskId}`, error)
        if (this.ledger.task(taskId) !== undefined) this.ledger.noteReview(taskId, { ...review, error: message })
      })
    }
  }

  /**
   * Retry releasing the worktree of an archived card. Archiving releases it
   * right away; this covers the git that refused then (a locked worktree, an
   * open file) and cards archived before archiving owned that job. A failure is
   * logged once per card and retried silently on every poll until the directory
   * is gone — a locked worktree is never unlocked behind the human's back.
   */
  private async reconcileArchivedWorktrees(): Promise<void> {
    if (this.disposed) return
    const pending = new Set<string>()
    for (const task of this.ledger.archivedWorktrees()) {
      // Serialize with the card's own work chain: archiving may have queued the
      // very same removal, and the poll must not race it.
      await this.ledger.awaitCard(task.id)
      const failure = await this.git.releaseWorktree(task)
      if (failure === undefined) continue
      pending.add(task.id)
      if (this.worktreeWarnings.has(task.id)) continue
      this.worktreeWarnings.add(task.id)
      console.warn(`task board: could not remove the worktree of archived task ${task.id} (${failure}); retrying on every poll`)
    }
    for (const id of [...this.worktreeWarnings]) if (!pending.has(id)) this.worktreeWarnings.delete(id)
  }

  private async pollSessions(): Promise<void> {
    if (this.disposed) return
    // Environments are reconciled on every poll, whether or not the board is
    // active: a stack whose card left the run/review columns (or is gone) must
    // not keep running just because the plugin was switched off meanwhile. The
    // review environments the board started are held to the same rule, and an
    // archived card's worktree is retried until it is gone.
    this.reconcileCompose()
    this.reconcileReview()
    await this.reconcileArchivedWorktrees()
    if (!this.active && this.ledger.runtimeView().openExecutions.length === 0) return
    const running = await this.runner.listRunning()
    const previous = this.power.snapshot()
    if (!running.known) {
      this.idleSessionIds = undefined
      this.power.updateReasons({
        runningSessions: previous.runningSessions,
        armedSchedules: this.ledger.armedScheduleCount(),
        sessionStateKnown: false,
      })
      return
    }
    this.idleSessionIds = new Set(running.items.filter(item => !item.running).map(item => item.sessionId))
    // Read after the RPC so executions attached while it was in flight are
    // included in this pass, matching the former full-state snapshot timing.
    const runtime = this.ledger.runtimeView()
    this.power.updateReasons({
      runningSessions: running.count,
      armedSchedules: runtime.armedSchedules,
      sessionStateKnown: true,
    })
    // No unconditional emit here: real changes already emit through the
    // ledger subscription (settles) and the gated power listener above.
    await this.reconcileExecutions(running.items, runtime.openExecutions)
    this.refreshRunningSessions(running.items)
    // Safety net for conversations that outlived their run: a settlement that
    // happened before the job gate existed, a paused run that a late notice woke
    // again, or a card that left the board while its session kept working.
    await this.stopOrphanedSessions(running.items)
    // A card that parked in the review/failed column and whose human then wrote
    // in its own chat is a rework: the Host sends it back to `clarification` and
    // stamps it, and the correction itself stays in that conversation.
    await this.watchReworkChats(running.items)
    // Read after the settles above: a clarification round that just settled is
    // exactly the moment its card starts waiting for the human's answer.
    await this.refreshAwaitingAnswers(running.items)
    // A settle (or a pause) just released a lane: start whatever is waiting.
    this.pumpLaunchQueue()
    // A settle may have parked the card (the stack stays) — and a card that left
    // the review columns is torn down on the next poll.
    this.reconcileCompose()
    this.reconcileReview()
  }

  /**
   * Recompute which cards wait for the human's answer and publish the change.
   *
   * The read is gated on the conversation's `updatedAt` (and the roster's
   * running flag): an unchanged chat cannot have produced or answered a
   * question, so a card that simply keeps waiting costs no history RPC on the
   * 5 s poll. The verdict is what the *conversation* says — the symbol is not a
   * ledger state and must not survive the answer.
   *
   * Failure policy: a history read that fails keeps the last verdict and retries
   * on the next poll (a question the human owes an answer to is never dropped
   * because the Host had one bad read), while a session missing from the roster
   * is no evidence at all and contributes nothing.
   * @param sessions - the roster the poll already fetched.
   */
  private async refreshAwaitingAnswers(sessions: readonly SessionSummary[]): Promise<void> {
    if (this.disposed || !this.active) return
    const byId = new Map(sessions.map(item => [item.sessionId as string, item]))
    const next: Record<string, string> = {}
    const watching = new Set<string>()
    for (const { taskId, sessionId } of this.ledger.awaitingAnswerWatch()) {
      const summary = byId.get(sessionId)
      if (summary === undefined) continue
      watching.add(sessionId)
      const scannedAt = summary.updatedAt
      const memo = this.answerWatches.get(sessionId)
      if (memo !== undefined && scannedAt !== undefined && memo.updatedAt === scannedAt && memo.running === summary.running) {
        if (memo.awaiting) next[taskId] = sessionId
        continue
      }
      const awaiting = await this.runner.awaitingAnswer(sessionId, summary.running)
      // Unreadable history: hold the last verdict, keep no memo, retry next poll.
      if (awaiting === undefined) {
        if (memo?.awaiting === true) next[taskId] = sessionId
        continue
      }
      if (scannedAt !== undefined) this.answerWatches.set(sessionId, { updatedAt: scannedAt, running: summary.running, awaiting })
      if (awaiting) next[taskId] = sessionId
    }
    for (const sessionId of [...this.answerWatches.keys()]) if (!watching.has(sessionId)) this.answerWatches.delete(sessionId)
    if (sameAnswerMap(this.awaitingAnswer, next)) return
    this.awaitingAnswer = next
    // The map is not part of the ledger revision, so this is the only push the
    // browser gets; the frame carries the map itself (see eventPayload).
    this.emit()
  }

  /**
   * Send settled cards back for rework when their human wrote in the card's own
   * conversation. The correction is never copied into a board field: the human
   * typed it into the chat the run lives in, so the card only moves and gets
   * its {@link TaskRecord.reworkAt} stamp. The move is an ordinary ledger move,
   * so the state machine still decides whether the column pair exists at all.
   *
   * Reading is gated twice on purpose: a conversation whose `updatedAt` did not
   * change since the last poll costs no history RPC, and an unreadable history
   * (`known: false`) is never treated as "no human turn" — it is simply retried
   * on the next poll.
   * @param sessions - the roster the poll already fetched.
   */
  private async watchReworkChats(sessions: readonly SessionSummary[]): Promise<void> {
    if (this.disposed || !this.active) return
    const byId = new Map(sessions.map(item => [item.sessionId as string, item]))
    const watched = this.ledger.reworkWatch()
    const watching = new Set<string>()
    for (const { taskId, sessionId, since } of watched) {
      const summary = byId.get(sessionId)
      if (summary === undefined) continue
      watching.add(taskId)
      const scannedAt = summary.updatedAt
      if (scannedAt !== undefined && this.reworkScans.get(taskId) === scannedAt) continue
      const human = await this.runner.newestHumanTurn(sessionId, since)
      if (!human.known) continue
      if (scannedAt !== undefined) this.reworkScans.set(taskId, scannedAt)
      if (human.at === undefined) continue
      try {
        this.ledger.applyRequest(`rework:${taskId}:${human.at}`, { kind: 'move', taskId, status: 'clarification' })
      } catch (error) {
        // A card whose machine declares no way back (or that changed column in
        // between) simply stays put; the next human turn tries again.
        console.warn(`[dsh-task-board] could not send task ${taskId} back to clarification for rework`, error)
      }
    }
    for (const id of [...this.reworkScans.keys()]) if (!watching.has(id)) this.reworkScans.delete(id)
  }

  /** Reuse the session list this poll already fetched: one list RPC per tick, not 1 + E. */
  /**
   * Settle every open execution whose session has finished. This is the only
   * automatic path into `ready_for_test`: the runner reports 'succeeded' only
   * once the session has come to rest (no running turn, nothing queued, no
   * live job), so the column change is always the session's last action — an
   * agent's own `FERTIG:` report never moves the card while its session runs.
   * Drag & drop cannot race it — the ledger refuses to move a card that is
   * running or still carries an open execution.
   */
  private async reconcileExecutions(
    sessions: readonly SessionSummary[],
    executions: readonly OpenExecutionReference[],
  ): Promise<void> {
    for (const execution of executions) {
      // A clarification run is monitored like any other execution: settling it
      // is what clears the card's Running/Queued badge again (and, because it is
      // a clarification, leaves the card in its column).
      if (execution.sessionId === undefined) continue
      try {
        const result = await this.runner.inspect(execution.sessionId, execution.startedAt, sessions)
        if (result.outcome === 'pending') continue
        // A turn the human stopped in the card's own chat is a pause, not a
        // failed run: the conversation stays, the execution stays open, and the
        // card can continue exactly there. Settling it as failed was what left
        // the card in `failed` while its session kept working (and left the
        // board unable to pause a run it no longer owned).
        if (result.outcome === 'failed' && result.error === 'agent turn was aborted by the user') {
          try {
            const paused = this.ledger.applyRequest(`chat-stop:${execution.taskId}:${execution.startedAt}`, {
              kind: 'pause',
              taskIds: [execution.taskId],
            })
            for (const run of paused.paused ?? []) this.stopPausedRun(run)
          } catch (error) {
            // No pause transition for this card (custom machine) or it changed
            // column in between: fall back to the ordinary settlement.
            this.ledger.settle(execution.taskId, execution.executionId, result.outcome, result.error)
            console.warn(`[dsh-task-board] could not pause task ${execution.taskId} after a chat stop`, error)
          }
          continue
        }
        this.ledger.settle(execution.taskId, execution.executionId, result.outcome, 'error' in result ? result.error : undefined)
      } catch {
        // A transient inspection failure never settles a running execution.
      }
    }
  }

  /**
   * Publish which conversations are running right now, so a card can offer its
   * immediate stop even when its ordinary pause control is unavailable (a paused
   * card whose session was woken again). Derived from the roster, never ledger
   * state, and only emitted when the set really changed.
   * @param sessions - the roster the poll already fetched.
   */
  private refreshRunningSessions(sessions: readonly SessionSummary[]): void {
    const running = new Map(sessions.map(item => [item.sessionId as string, item.running === true]))
    const next: Record<string, true> = {}
    for (const row of this.ledger.sessionWatch()) {
      if (running.get(row.sessionId) === true) next[row.taskId] = true
    }
    if (JSON.stringify(next) === JSON.stringify(this.runningSessions)) return
    this.runningSessions = next
    this.emit()
  }

  /**
   * Stop the card's conversation right now, without touching its column or its
   * execution record: the immediate stop behind the card's control. Jobs die, so
   * their completion notices cannot wake it again; human messages are kept for a
   * later resume.
   */
  private stopRunningSession(taskId: string): void {
    const task = this.ledger.task(taskId)
    if (task === undefined) return
    const sessionId = latestSessionId(task)
    if (sessionId === undefined) return
    void this.runner.stopSession(sessionId, { preserveUserMessages: true }).then(report => {
      if (report.preserved.length > 0) this.preservedMessages.set(taskId, report.preserved)
      if (!report.attached) {
        this.ledger.note(taskId, 'Zu dieser Karte läuft gerade keine Session mehr.')
        return
      }
      if (!report.stopped) {
        this.ledger.note(taskId, 'Die Session ließ sich nicht anhalten; das Board versucht es beim nächsten Durchlauf erneut.')
        return
      }
      this.ledger.note(taskId, report.phaseReset
        ? 'Die Session wurde mit einem erzwungenen Phasen-Reset angehalten.'
        : 'Die Session wurde angehalten.')
    }).catch(error => { safeConsoleError(`[dsh-task-board] stopping the session of task ${taskId} failed`, error) })
  }

  /**
   * Stop conversations that run without a run of their own.
   *
   * A settled run's session is the card's conversation and must stay usable for
   * the human (rework happens by writing into it), so this is deliberately
   * conservative:
   *
   * - a **paused** card's session must never run: the pause is the human's
   *   "stop", and a late job notice that woke the agent again is exactly what
   *   must not survive it;
   * - a **done/archived** card has no work left to do;
   * - any other settled card is stopped only if the human has **not** written in
   *   its chat since the run settled — a conversation the human just used is
   *   theirs, a conversation a background job woke is an orphan.
   *
   * Fail-safe: an unreadable history is no evidence and leaves the session
   * alone; the next poll retries.
   * @param sessions - the roster the poll already fetched.
   */
  private async stopOrphanedSessions(sessions: readonly SessionSummary[]): Promise<void> {
    if (this.disposed || !this.active) return
    const byId = new Map(sessions.map(item => [item.sessionId as string, item]))
    for (const row of this.ledger.sessionWatch()) {
      const summary = byId.get(row.sessionId)
      if (summary === undefined || summary.running !== true) continue
      let stop = false
      if (row.paused) {
        // A human writing into the paused conversation is a resume, not work to
        // kill: clear the pause and let the board monitor the run again. Only a
        // session the board itself stopped and something *else* woke again (a
        // background job) is an orphan.
        const human = await this.runner.newestHumanTurn(row.sessionId, row.pausedAt ?? 0)
        if (human.known && human.at !== undefined) {
          this.ledger.clearPause(row.taskId)
          this.ledger.note(row.taskId, 'Neue Nachricht im Chat einer pausierten Karte: die Pause wurde aufgehoben.')
          continue
        }
        // Unknown history does not save the session: a paused card is an
        // explicit human instruction, and the stop is retried next poll anyway.
        stop = true
      } else if (row.open) {
        continue
      } else if (row.archived || row.status === 'done') {
        stop = true
      } else if (row.settledAt !== undefined) {
        const scannedAt = summary.updatedAt
        if (scannedAt !== undefined && this.orphanScans.get(row.sessionId) === scannedAt) continue
        const human = await this.runner.newestHumanTurn(row.sessionId, row.settledAt)
        if (!human.known) continue
        if (scannedAt !== undefined) this.orphanScans.set(row.sessionId, scannedAt)
        stop = human.at === undefined
      }
      if (!stop) continue
      const report = await this.runner.stopSession(row.sessionId, { preserveUserMessages: true })
      if (report.preserved.length > 0) this.preservedMessages.set(row.taskId, report.preserved)
      if (!this.orphanNoticed.has(row.sessionId)) {
        this.orphanNoticed.add(row.sessionId)
        this.ledger.note(row.taskId, 'Eine Session lief ohne offenen Lauf; das Board hat sie gestoppt.')
      }
    }
    for (const sessionId of [...this.orphanNoticed]) {
      const summary = byId.get(sessionId)
      if (summary === undefined || summary.running !== true) this.orphanNoticed.delete(sessionId)
    }
    for (const sessionId of [...this.orphanScans.keys()]) if (!byId.has(sessionId)) this.orphanScans.delete(sessionId)
  }

  private async tickSchedule(first: boolean): Promise<void> {
    if (this.disposed || !this.active) return
    const now = this.now()
    const recovered = first || (this.lastScheduleTick !== undefined && now - this.lastScheduleTick > RESUME_GAP_MS)
    this.lastScheduleTick = now
    this.ledger.setScheduler({ lastTickAt: now })
    if (recovered) {
      this.ledger.skipMissed(now)
      return
    }
    for (const schedule of this.ledger.dueSchedules(now)) {
      const next = nextRunAtMs(schedule.cron, schedule.nextRunAt)
      const opened = this.ledger.openScheduled(schedule.taskId, next, now)
      if (opened !== undefined) this.scheduleLaunch(opened)
    }
  }

  private armedSchedules(): number {
    return this.ledger.armedScheduleCount()
  }

  private scheduleLaunch(opened: OpenedRun): void {
    this.launchQueue.push(opened)
    this.pumpLaunchQueue()
  }

  /**
   * Start queued runs while their lane (workspace) holds fewer than
   * `maxConcurrentRuns` sessions. Lanes are independent: a saturated lane never
   * blocks another lane's queue entry, which is scanned in arrival order so
   * runs within one lane still start FIFO. A run above its lane's limit stays
   * queued: its ledger execution is already open without a session, so the card
   * reads as waiting and cannot be opened twice. A clarification run is never
   * held back — the clarification column has no WIP limit. Called on enqueue, on every ledger
   * change (a settle frees a slot), after a launch attaches a session or fails,
   * and when the limit changes.
   */
  private pumpLaunchQueue(): void {
    if (this.disposed) return
    // Nothing queued is the normal case: skip the ledger read entirely so the
    // poll path keeps its single runtimeView per tick.
    if (this.launchQueue.length === 0) return
    const open = this.ledger.runtimeView().openExecutions
    // Self-heal: drop entries whose execution is no longer open (deleted,
    // archived, or settled while it waited) so the queue cannot replay them.
    if (this.launchQueue.length > 0) {
      this.launchQueue = this.launchQueue.filter(opened => open.some(
        execution => execution.taskId === opened.task.id && execution.executionId === opened.execution.id,
      ))
    }
    // The launch gate: an overloaded machine (load per core, event-loop delay)
    // must not receive yet another agent turn — that is what turned three
    // sessions into a frozen GUI. The run stays queued and the card says why.
    // `PRESSURE_MAX_HOLD_MS` keeps a permanently busy machine from turning the
    // queue into a dead end: after the hold the run starts anyway, with a note.
    const pressure = this.pressureMonitor.snapshot()
    if (pressure.level === 'overloaded' && this.launchQueue.length > 0) {
      const now = this.now()
      const oldest = this.launchQueue.reduce((min, opened) => Math.min(min, opened.execution.startedAt), now)
      if (now - oldest < PRESSURE_MAX_HOLD_MS) return
      for (const opened of this.launchQueue) {
        if (this.pressureBypassed.has(opened.task.id)) continue
        this.pressureBypassed.add(opened.task.id)
        this.ledger.note(opened.task.id, `Das System ist weiterhin ausgelastet (Last ${pressure.load1.toFixed(1)} auf ${pressure.cores} Kernen) — der Lauf startet trotzdem.`)
      }
    }
    // Forget the "started anyway" marks of runs that left the queue.
    for (const id of [...this.pressureBypassed]) {
      if (!this.launchQueue.some(opened => opened.task.id === id)) this.pressureBypassed.delete(id)
    }
    for (;;) {
      // Sessions per lane from the ledger snapshot plus the launches that lane
      // started but whose session the snapshot cannot show yet.
      //
      // The slot belongs to every open *implementation* execution that already
      // attached its session, from attachment until the execution settles (or
      // the card is paused, which runtimeView hides). The roster is not
      // consulted: it reports whether a turn runs right now, not whether the run
      // is over, and a run that ended its turn without settling still owns its
      // worktree and branch. Counting idle-but-open sessions here is what keeps
      // a lane strictly at WIP 1 instead of merely throttling its launch rate.
      //
      // A clarification run (the `clarification` column's execution) holds no
      // slot at all: the clarification column is WIP-free, so a card pulled in
      // always starts right away — next to a working run of the same workspace
      // if need be. Its prompt forbids implementing anything, which is what
      // makes the overlap safe.
      const holding = new Map<string, number>()
      for (const execution of open) {
        if (execution.kind === 'clarify') continue
        if (execution.sessionId === undefined) continue
        holding.set(execution.lane, (holding.get(execution.lane) ?? 0) + 1)
      }
      const index = this.launchQueue.findIndex((opened) => {
        if (opened.execution.kind === 'clarify') return true
        const lane = taskLane(opened.task)
        return (holding.get(lane) ?? 0) + (this.launchesInFlight.get(lane) ?? 0) < this.maxConcurrentRuns
      })
      if (index === -1) return
      const next = this.launchQueue.splice(index, 1)[0]
      if (next === undefined) return
      const lane = taskLane(next.task)
      // A WIP-free launch must not raise the lane's in-flight count either, or
      // the question rounds of the following cards would queue behind it.
      const wipFree = next.execution.kind === 'clarify'
      if (!wipFree) this.launchesInFlight.set(lane, (this.launchesInFlight.get(lane) ?? 0) + 1)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        if (!wipFree) {
          const remaining = (this.launchesInFlight.get(lane) ?? 1) - 1
          if (remaining <= 0) this.launchesInFlight.delete(lane)
          else this.launchesInFlight.set(lane, remaining)
        }
        this.pumpLaunchQueue()
      }
      void this.launch(next).catch(error => {
        safeConsoleError('[dsh-task-board] execution launch settlement failed', error)
      }).finally(release)
    }
  }

  private schedulePoll(): void {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.pollSessions().catch(error => {
      safeConsoleError('[dsh-task-board] session polling failed', error)
    }).finally(() => { this.pollInFlight = false })
  }

  private scheduleTick(first: boolean): void {
    if (this.tickInFlight || this.disposed) return
    this.tickInFlight = true
    void this.tickSchedule(first).catch(error => {
      safeConsoleError('[dsh-task-board] scheduler tick failed', error)
    }).finally(() => { this.tickInFlight = false })
  }

  private syncPowerReasons(): void {
    const current = this.power.snapshot()
    this.power.updateReasons({
      runningSessions: current.runningSessions,
      armedSchedules: this.armedSchedules(),
      sessionStateKnown: current.sessionStateKnown,
    })
    this.power.setEnabled(this.active && this.preventIdleSleep)
  }

  private emit(): void {
    // One frame per change, written by every connected tab: the delta advances
    // the sent-task baseline and drains the action results, so it may only be
    // computed once and must not outlive the notification loop.
    this.pendingFrame = this.computeFrame()
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Install stream error listeners on process.stderr and process.stdout so that
 * transient write failures (e.g. ENOSPC when the disk is full, or EPIPE on a
 * closed pipe) never emit unhandled 'error' events that kill the Node.js host process.
 */
export function installStreamErrorGuards(): void {
  for (const stream of [process.stderr, process.stdout]) {
    if (stream && typeof stream.on === 'function') {
      const hasErrorListener = typeof stream.listenerCount === 'function' && stream.listenerCount('error') > 0
      if (!hasErrorListener) {
        stream.on('error', () => {
          // Swallow write stream errors to keep the host process alive
        })
      }
    }
  }
}

/**
 * Defensively log to console.error without letting stderr write failures
 * (e.g. ENOSPC from SyncWriteStream on redirected logs) crash the host process.
 */
export function safeConsoleError(message: string, ...args: unknown[]): void {
  try {
    console.error(message, ...args)
  } catch {
    // Best-effort stderr write; ignore write errors when stderr stream fails
  }
}

/** The most recent conversation a card ever ran in (open or settled). */
function latestSessionId(task: ComposeTaskRecord): string | undefined {
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const sessionId = task.executions[index].sessionId
    if (sessionId !== undefined) return sessionId
  }
  return task.clarificationSessionId
}

/** Cards an action touches, for waiting on their background work before applying it. */
function actionTaskIds(action: TaskBoardAction): string[] {
  switch (action.kind) {
    case 'import':
    case 'create':
      return []
    case 'move-many':
    case 'pause':
    case 'resume':
      return [...new Set(action.taskIds)]
    case 'pause-all':
    case 'resume-all':
      return []
    default:
      return 'taskId' in action ? [action.taskId] : []
  }
}

/** Whether an action is one of the review controls (the service's own bookkeeping). */
function isReviewAction(action: TaskBoardAction): action is Extract<TaskBoardAction, { kind: 'review-start' | 'review-stop' | 'review-restart' }> {
  return action.kind === 'review-start' || action.kind === 'review-stop' || action.kind === 'review-restart'
}

/**
 * The record a stopped environment keeps: its identity and the ports it was
 * started with (so the next start re-creates it on the URL the human already
 * has open), without pretending to be up. The links stay on the record for the
 * same reason — the card renders them while the environment runs.
 */
function stoppedReview(review: TaskReview, at: number): TaskReview {
  return { ...review, startedAt: undefined, stoppedAt: at, error: undefined }
}
