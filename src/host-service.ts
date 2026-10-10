import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { nextRunAtMs } from './core/schedule.ts'
import { reusableSessionId } from './core/session-reuse.ts'
import { taskLane } from './core/tasks.ts'
import { HostTaskLedger, type OpenedRun, type OpenExecutionReference, type PausedRun, type ResumedRun } from './host-ledger.ts'
import { HostExecutionRunner, SessionLaunchError, type SessionCommandDispatcher, type SessionSummary, type TaskBoardWorkspaceRegistry } from './host-runner.ts'
import { GitWorkflow } from './git-workflow.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardEventPayload, type TaskBoardSnapshot } from './protocol.ts'
import type { TaskPermission } from './core/handover.ts'

const SESSION_POLL_MS = 5_000
const SCHEDULE_TICK_MS = 30_000
const RESUME_GAP_MS = SCHEDULE_TICK_MS + 15_000

/** Whether two task→session maps name the same cards and conversations. */
function sameAnswerMap(current: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(current).length) return false
  return keys.every(key => current[key] === next[key])
}

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
   * session at once (always >= 1). Clarification runs (`todo`) are exempt.
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
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxDoneTasks: this.ledger.maxDoneTasksLimit,
      awaitingAnswer: { ...this.awaitingAnswer },
    }
  }

  /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
  eventPayload(): TaskBoardEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    return {
      revision,
      scheduler,
      power: this.power.snapshot(),
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxDoneTasks: this.ledger.maxDoneTasksLimit,
      // Rides the frame like the limits do: the flag is derived, so it never
      // bumps the ledger revision, and the 5 s heartbeat must still deliver it.
      awaitingAnswer: { ...this.awaitingAnswer },
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: TaskBoardAction, initiator?: string): TaskBoardSnapshot {
    if (!this.active) throw new Error('task board is disabled')
    const result = this.ledger.applyRequest(requestId, action, initiator)
    // A clarification run is a run: both go through the launch queue below, but
    // only the implementation run is gated by the lane WIP limit; the
    // clarification's kind decides the prompt and the exemption.
    if (result.run !== undefined) this.scheduleLaunch(result.run)
    if (result.clarification !== undefined) this.scheduleLaunch(result.clarification)
    // The pause is already in the ledger (so the monitor no longer touches the
    // run); stopping the sessions happens next, off this call.
    for (const paused of result.paused ?? []) this.stopPausedRun(paused)
    for (const resumed of result.resumed ?? []) this.resumePausedRun(resumed)
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: result.state.revision,
      tasks: result.state.tasks,
      scheduler: result.state.scheduler,
      power: this.power.snapshot(),
      sessionDefaultPermission: this.ledger.sessionDefaultPermission,
      stateMachine: this.ledger.stateMachine.toJSON(),
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxDoneTasks: this.ledger.maxDoneTasksLimit,
      awaitingAnswer: { ...this.awaitingAnswer },
    }
  }

  dispose(): void {
    this.disposed = true
    this.launchQueue = []
    this.launchesInFlight.clear()
    this.awaitingAnswer = {}
    this.answerWatches.clear()
    for (const timer of this.timers.splice(0)) clearInterval(timer)
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
    // The card's clarification run goes through this very queue, but not
    // through the lane limit: `todo` is WIP-free, so it may start next to a
    // working run of the same workspace. Its session is the card's
    // clarification conversation, so it is continued rather than duplicated,
    // and its prompt is the run prompt plus the clarification addendum
    // (composed by the runner).
    const clarification = opened.execution.kind === 'clarify'
    try {
      // Work happens on the card's feature branch: check it out in the pinned
      // workspace worktree before the session starts (no-op without git state).
      // A clarification run is exempt: it implements nothing, and checking a
      // branch out while a same-lane run is working would yank that run's
      // worktree out from under it.
      if (!clarification) this.git.useBranch(opened.task)
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
      const implement = !clarification && reuseSessionId !== undefined && reuseSessionId === opened.task.clarificationSessionId
      const clarificationSessionId = opened.task.clarificationSessionId
      const sessionId = await this.runner.launch(opened.task, clarification
        ? {
            clarification: true,
            ...(clarificationSessionId === undefined ? {} : { reuseSessionId: clarificationSessionId }),
          }
        : {
            ...(reuseSessionId === undefined ? {} : { reuseSessionId }),
            ...(rework ? { rework: true } : {}),
            ...(implement ? { implement: true } : {}),
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
      // go-ahead superseded, which is the normal race now that `todo` starts
      // without waiting for a slot: the card owns exactly one conversation, so
      // this late session is stopped and never attached. The implementation
      // meanwhile opened its own.
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
      try {
        await this.runner.cancel(sessionId)
      } catch (error) {
        this.ledger.clearPause(paused.taskId)
        safeConsoleError(`[dsh-task-board] pausing task ${paused.taskId} could not stop its session; the run stays unpaused`, error)
      }
    })().catch(error => { safeConsoleError('[dsh-task-board] pause handling failed', error) })
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
    void (async () => {
      try {
        await this.runner.launch(resumed.task, { reuseSessionId: sessionId, resume: true })
      } catch (error) {
        // The conversation is gone (deleted, or the Host lost it): the run
        // cannot continue, so it fails visibly instead of hanging in progress.
        this.ledger.settle(resumed.task.id, resumed.execution.id, 'failed', error instanceof Error ? error.message : String(error))
      }
    })().catch(error => { safeConsoleError('[dsh-task-board] resume handling failed', error) })
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
    // A card that parked in the review/failed column and whose human then wrote
    // in its own chat is a rework: the Host sends it back to `todo` and stamps
    // it, and the correction itself stays in that conversation.
    await this.watchReworkChats(running.items)
    // Read after the settles above: a clarification round that just settled is
    // exactly the moment its card starts waiting for the human's answer.
    await this.refreshAwaitingAnswers(running.items)
    // A settle (or a pause) just released a lane: start whatever is waiting.
    this.pumpLaunchQueue()
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
        this.ledger.applyRequest(`rework:${taskId}:${human.at}`, { kind: 'move', taskId, status: 'todo' })
      } catch (error) {
        // A card whose machine declares no way back (or that changed column in
        // between) simply stays put; the next human turn tries again.
        console.warn(`[dsh-task-board] could not send task ${taskId} back to todo for rework`, error)
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
   * reads as waiting and cannot be opened twice. A clarification run is never
   * held back — `todo` has no WIP limit. Called on enqueue, on every ledger
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
      // A clarification run (the `todo` column's execution) holds no slot at
      // all: `todo` is WIP-free, so a card pulled in always starts right away —
      // next to a working run of the same workspace if need be. Its prompt
      // forbids implementing anything, which is what makes the overlap safe.
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
