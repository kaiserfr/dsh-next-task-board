import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { nextRunAtMs } from './core/schedule.ts'
import { reusableSessionId } from './core/session-reuse.ts'
import { taskLane } from './core/tasks.ts'
import { HostTaskLedger, type OpenedRun, type OpenExecutionReference } from './host-ledger.ts'
import { HostExecutionRunner, SessionLaunchError, type SessionCommandDispatcher, type SessionSummary, type TaskBoardWorkspaceRegistry } from './host-runner.ts'
import { GitWorkflow } from './git-workflow.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardEventPayload, type TaskBoardSnapshot } from './protocol.ts'
import type { TaskPermission } from './core/handover.ts'

const SESSION_POLL_MS = 5_000
const SCHEDULE_TICK_MS = 30_000
const RESUME_GAP_MS = SCHEDULE_TICK_MS + 15_000

export class TaskBoardHostService {
  readonly ledger: HostTaskLedger
  readonly runner: HostExecutionRunner
  readonly power: PowerInhibitor
  /** Shared git integration: branch hooks in the ledger, checkout before a run. */
  readonly git: GitWorkflow
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
   */
  private idleSessionIds: ReadonlySet<string> | undefined
  private preventIdleSleep = false
  /** Runs waiting for a free WIP slot, in arrival order. */
  private launchQueue: OpenedRun[] = []
  /** Per-lane launches already started whose session is not attached yet (invisible to the ledger). */
  private readonly launchesInFlight = new Map<string, number>()
  /** WIP limit per workspace/lane: how many runs may hold a session at once (always >= 1). */
  private maxConcurrentRuns = 1
  private lastPowerJson = ''
  private readonly now: () => number

  constructor(gateway: TypertGateway, options: {
    ledger?: HostTaskLedger
    power?: PowerInhibitor
    now?: () => number
    commandDispatcher?: SessionCommandDispatcher
    workspaceRegistry?: TaskBoardWorkspaceRegistry
    sessionDefaultPermission?: TaskPermission
    git?: GitWorkflow
    /** Machine config applied to a freshly built ledger (settings `stateMachine`). */
    stateMachine?: unknown
  } = {}) {
    this.git = options.git ?? new GitWorkflow(options.workspaceRegistry)
    this.ledger = options.ledger ?? new HostTaskLedger(undefined, undefined, { sessionDefaultPermission: options.sessionDefaultPermission, git: this.git, stateMachine: options.stateMachine })
    this.runner = new HostExecutionRunner(gateway, options.commandDispatcher, options.workspaceRegistry)
    this.power = options.power ?? new PowerInhibitor()
    this.now = options.now ?? Date.now
    installStreamErrorGuards()
    this.ledger.subscribe(() => {
      this.syncPowerReasons()
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
  }

  start(): void {
    if (this.disposed || this.timers.length > 0) return
    this.syncPowerReasons()
    this.timers.push(setInterval(() => { this.schedulePoll() }, SESSION_POLL_MS))
    this.timers.push(setInterval(() => { this.scheduleTick(false) }, SCHEDULE_TICK_MS))
    this.schedulePoll()
    this.scheduleTick(true)
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
  }

  /**
   * Apply the board's Done-column limit (settings namespace `task-board`,
   * `maxDoneTasks`). The ledger trims an over-limit `done` column right away
   * and keeps enforcing it on every later move into `done` (oldest cards first,
   * FIFO).
   * @param limit - configured maximum; values below 1 or non-finite keep the default.
   */
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
    const state = this.ledger.state()
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: state.revision,
      tasks: state.tasks,
      scheduler: state.scheduler,
      power: this.power.snapshot(),
      sessionDefaultPermission: this.ledger.sessionDefaultPermission,
      // The resolved machine travels with the state, so the browser validates
      // its drop targets against exactly what the Host enforces.
      stateMachine: this.ledger.stateMachine.toJSON(),
    }
  }

  /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
  eventPayload(): TaskBoardEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    return { revision, scheduler, power: this.power.snapshot() }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: TaskBoardAction, initiator?: string): TaskBoardSnapshot {
    if (!this.active) throw new Error('task board is disabled')
    const result = this.ledger.applyRequest(requestId, action, initiator)
    if (result.run !== undefined) this.scheduleLaunch(result.run)
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: result.state.revision,
      tasks: result.state.tasks,
      scheduler: result.state.scheduler,
      power: this.power.snapshot(),
      sessionDefaultPermission: this.ledger.sessionDefaultPermission,
      stateMachine: this.ledger.stateMachine.toJSON(),
    }
  }

  dispose(): void {
    this.disposed = true
    this.launchQueue = []
    this.launchesInFlight.clear()
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    this.power.dispose()
    this.ledger.dispose()
    this.listeners.clear()
  }

  private async launch(opened: OpenedRun): Promise<void> {
    try {
      // Work happens on the card's feature branch: check it out in the pinned
      // workspace worktree before the session starts (no-op without git state).
      this.git.useBranch(opened.task)
      // A rework round continues the conversation it corrects, whether or not
      // the card opted into session reuse. When no idle previous conversation
      // is available the note still has to reach the agent: the runner appends
      // it to the full prompt instead, and the warning records that the round
      // lost its context on purpose rather than by accident.
      const reworkNote = opened.execution.reworkNote
      const reuseSessionId = reusableSessionId(
        opened.task,
        this.idleSessionIds,
        reworkNote === undefined ? {} : { rework: true },
      )
      if (reworkNote !== undefined && reuseSessionId === undefined) {
        console.warn(`[dsh-task-board] rework note for task ${opened.task.id} starts a fresh session: no idle previous conversation to continue`)
      }
      const sessionId = await this.runner.launch(opened.task, {
        ...(reuseSessionId === undefined ? {} : { reuseSessionId }),
        ...(reworkNote === undefined ? {} : { reworkNote }),
      })
      this.ledger.attachSession(opened.task.id, opened.execution.id, sessionId)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        this.ledger.attachSession(opened.task.id, opened.execution.id, error.sessionId)
      }
      this.ledger.settle(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.disposed) return
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
  }

  /** Reuse the session list this poll already fetched: one list RPC per tick, not 1 + E. */
  /**
   * Settle every open execution whose session has finished. This is the only
   * automatic path into `ready_for_test`: the runner reports 'succeeded' only
   * once the session has come to rest (no running turn, nothing queued, no
   * live job), so the column change is always the session's last action.
   * Drag & drop cannot race it — the ledger refuses to move a card that is
   * running or still carries an open execution.
   */
  private async reconcileExecutions(
    sessions: readonly SessionSummary[],
    executions: readonly OpenExecutionReference[],
  ): Promise<void> {
    for (const execution of executions) {
      if (execution.sessionId === undefined) continue
      try {
        const result = await this.runner.inspect(execution.sessionId, execution.startedAt, sessions)
        if (result.outcome === 'pending') continue
        this.ledger.settle(execution.taskId, execution.executionId, result.outcome, 'error' in result ? result.error : undefined)
      } catch {
        // A transient inspection failure never settles a running execution.
      }
    }
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
   * reads as running and cannot be opened twice. Called on enqueue, on every
   * ledger change (a settle frees a slot), after a launch attaches a session or
   * fails, and when the limit changes.
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
    for (;;) {
      // Sessions per lane from the ledger snapshot plus the launches that lane
      // started but whose session the snapshot cannot show yet.
      const holding = new Map<string, number>()
      for (const execution of open) {
        if (execution.sessionId === undefined) continue
        holding.set(execution.lane, (holding.get(execution.lane) ?? 0) + 1)
      }
      const index = this.launchQueue.findIndex((opened) => {
        const lane = taskLane(opened.task)
        return (holding.get(lane) ?? 0) + (this.launchesInFlight.get(lane) ?? 0) < this.maxConcurrentRuns
      })
      if (index === -1) return
      const next = this.launchQueue.splice(index, 1)[0]
      if (next === undefined) return
      const lane = taskLane(next.task)
      this.launchesInFlight.set(lane, (this.launchesInFlight.get(lane) ?? 0) + 1)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        const remaining = (this.launchesInFlight.get(lane) ?? 1) - 1
        if (remaining <= 0) this.launchesInFlight.delete(lane)
        else this.launchesInFlight.set(lane, remaining)
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
