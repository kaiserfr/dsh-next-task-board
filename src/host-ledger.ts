import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import { isValidCron, nextRunAtMs } from './core/schedule.ts'
import { isTaskRecord, parseLedger } from './core/store.ts'
import type { TaskCompose, TaskGit, TaskMerge, TaskReview } from './core/tasks.ts'
import { DEFAULT_MAX_DONE_TASKS, MERGE_RESOLVE_ATTEMPTS, hasOpenRun, isReworkReturn, openExecution, retainRecentExecutions, settleExecution, startExecution, taskLane, withPause, withReworkStamp, withStatus, type ExecutionRecord, type TaskRecord } from './core/tasks.ts'
import { resolveStateMachine, type StateMachine, type StateTransition } from './core/state-machine.ts'
import { applyArchiveTask, applyRestoreTask } from './core/use-cases/task-archive.ts'
import { applyCreateTask } from './core/use-cases/task-create.ts'
import { applyDeleteTask } from './core/use-cases/task-delete.ts'
import { enforceDoneLimit } from './core/use-cases/done-limit.ts'
import { applySetSchedule, applyScheduleNextRun } from './core/use-cases/task-schedule.ts'
import { applyUpdateTask, canEditTaskContent, hasContentPatch } from './core/use-cases/task-update.ts'
import { TASK_BOARD_LEGACY_SCHEMA_VERSION, TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardNotice, type TaskBoardSchedulerSnapshot } from './protocol.ts'
import { DEFAULT_SESSION_PERMISSION, requiresPermissionConfirmation, type TaskPermission } from './core/handover.ts'
import { MergeConflictError, type GitWorkflow } from './git-workflow.ts'

interface PersistedScheduler extends TaskBoardSchedulerSnapshot {
  importedSources?: string[]
}

interface PersistedRequest {
  requestId: string
  fingerprint: string
}

/** On-disk document of any schema generation (schemaVersion untyped until the load branches decide). */
type ParsedLedgerDocument = Omit<Partial<LedgerDocument>, 'schemaVersion'> & { schemaVersion?: unknown }

interface LedgerDocument {
  schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  scheduler: PersistedScheduler
  recentRequests: PersistedRequest[]
}

export interface LedgerState {
  revision: number
  tasks: TaskRecord[]
  scheduler: TaskBoardSchedulerSnapshot
}

/**
 * A card whose execution the Host still has to start. The execution is either
 * the card's run (`execution.kind` undefined — the `run` action, cron) or its
 * clarification run (`execution.kind === 'clarify'`, the `backlog →
 * clarification` step): the two share the launch queue, but only the
 * implementation run obeys the lane WIP limit — the clarification column is
 * WIP-free; they also differ in the prompt and in whether settling moves the
 * card.
 */
export interface OpenedRun {
  task: TaskRecord
  execution: ExecutionRecord
}

/**
 * Outcome of one merge release (the card's "Freigeben (Merge)"): the card as it
 * stands afterwards — in `done` when the merge went through (or when there was
 * nothing to merge), in `failed` with the reason when it did not, still in
 * `ready_for_test` with a `running` execution when the conflict was handed to the
 * card's agent — plus the run that release started, if any.
 */
interface ReleaseResult {
  task: TaskRecord
  run?: OpenedRun
  /** The card was not moved: the merge runs in the background and writes its outcome later. */
  pending?: boolean
}

/** How long a derived Host notice stays visible in the board's toast area. */
const NOTICE_TTL_MS = 5 * 60_000
/** How many derived Host notices are kept for the toast area. */
const NOTICE_LIMIT = 12

/**
 * One merge release the Host is carrying out in the background. The plan is
 * computed synchronously (it binds the release to the reviewed commit the card
 * stands on), so a later park can never merge a commit nobody reviewed; the git
 * work itself runs on the card's work chain, off the action request.
 */
interface ReleasePlan {
  taskId: string
  reviewedCommit: string
  base: TaskMerge
  initiator?: string
  at: number
}

/** Result of the background merge, before the ledger writes the outcome back. */
interface ReleaseOutcome {
  merged?: TaskGit
  conflict?: MergeConflictError
  error?: string
}

/**
 * A run the `pause` action suspended: the Host service stops `sessionId` (when
 * the run had already attached one) so the agent stops working. The card keeps
 * its column and its open execution; only the session's active turn is ended.
 */
export interface PausedRun {
  taskId: string
  sessionId: string | undefined
}

/**
 * A run the `resume` action released: the Host service continues the run's own
 * conversation with a "continue" turn (`sessionId`), or — for a run that was
 * still waiting for a WIP slot and never got one — hands it back to the launch
 * queue.
 */
export interface ResumedRun {
  task: TaskRecord
  execution: ExecutionRecord
}

/**
 * A review action the Host service has to carry out: the ledger validates it
 * (the card exists, is not archived and stands in the review column) and hands
 * the intent back instead of doing the work itself. Starting or stopping a
 * version can take minutes — compose builds images, a start script runs — so the
 * service runs it off the ledger write and writes the outcome back with
 * {@link HostTaskLedger.noteReview}; nothing about the in-flight action is
 * persisted, which is exactly why a Host restart cannot leave a card claiming a
 * start it never finished.
 */
export interface ReviewIntent {
  taskId: string
  intent: 'start' | 'stop' | 'restart'
}

/** Minimal value copy used by the Host session monitor. */
export interface OpenExecutionReference {
  readonly taskId: string
  readonly executionId: string
  readonly sessionId: string | undefined
  readonly startedAt: number
  /** WIP lane (effective workspace id) the run counts against; '' when unpinned. */
  readonly lane: string
  /** `'clarify'` for the card's clarification round; a real run otherwise. */
  readonly kind: 'clarify' | 'merge' | undefined
}

/**
 * One card the rework watch follows (see {@link HostTaskLedger.reworkWatch}): a
 * settled card plus the conversation a human turn would arrive in.
 */
export interface ReworkWatchEntry {
  readonly taskId: string
  readonly sessionId: string
  /** When the card parked; older turns belong to the run that settled. */
  readonly since: number
}

/**
 * One card the question watch follows (see
 * {@link HostTaskLedger.awaitingAnswerWatch}): a card plus the conversation a
 * question of the agent would be waiting in.
 */
export interface AnswerWatchEntry {
  readonly taskId: string
  readonly sessionId: string
}

/** Minimal value copy used by the Host scheduler. */
export interface DueScheduleReference {
  readonly taskId: string
  readonly cron: string
  readonly nextRunAt: number
}

/** Derived runtime data for one session-poll pass. */
export interface LedgerRuntimeView {
  readonly armedSchedules: number
  readonly openExecutions: readonly OpenExecutionReference[]
}

const MAX_REQUEST_CACHE = 256

interface CachedRequest {
  fingerprint: string
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

function cloneTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return JSON.parse(JSON.stringify(tasks)) as TaskRecord[]
}

/** Clamp a configured Done-column limit; a missing/invalid value keeps the default. */
function normalizeMaxDoneTasks(limit: number | undefined): number {
  return limit !== undefined && Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_MAX_DONE_TASKS
}

function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined)
}

/**
 * Process states that are dead but still occupy the PID table: `Z` (zombie)
 * and `X` (dead, being reaped). `process.kill(pid, 0)` reports such PIDs as
 * alive, so a crash leftover whose child was never reaped would otherwise be
 * mistaken for a live owner and block ledger startup forever.
 */
const DEAD_STATES = new Set(['Z', 'X'])

/**
 * Best-effort single-letter process state ('R','S','D','Z',...) or undefined
 * when no probe is available on this platform. Linux reads /proc/<pid>/stat
 * directly (no subprocess); other POSIX shells out to `ps -o stat=`; Windows
 * has no zombie state, so it returns undefined and the kill(0) probe alone
 * is authoritative there.
 */
export function processState(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      if (end === -1) return undefined
      return stat.slice(end + 2).split(' ')[0] || undefined
    } catch {
      return undefined // no such process (or unreadable)
    }
  }
  if (process.platform === 'win32') return undefined
  try {
    const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS })
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const state = probe.stdout.toString('utf8').trim()
    return state.length > 0 ? state[0] : undefined
  } catch {
    return undefined
  }
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  const state = processState(pid)
  if (state !== undefined && DEAD_STATES.has(state)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const PROCESS_PROBE_TIMEOUT_MS = 3000

let ownStartTime: number | undefined
let ownStartTimeResolved = false

/**
 * Exact process start time (Unix epoch ms) on Linux, read straight from
 * /proc (field 22 = start ticks since boot, btime = boot epoch seconds).
 * No subprocess and no rounding, so the recorded `startedAt` from a previous
 * boot compares exactly against the live process identity.
 */
function linuxStartTimeMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    if (end === -1) return undefined
    const ticks = Number(stat.slice(end + 2).split(' ')[19])
    if (!Number.isFinite(ticks)) return undefined
    const bootMatch = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))
    if (bootMatch === null) return undefined
    const btime = Number(bootMatch[1])
    if (!Number.isFinite(btime)) return undefined
    return btime * 1000 + (ticks * 1000) / 100 // USER_HZ is 100 on Linux
  } catch {
    return undefined
  }
}

/**
 * Best-effort start time (Unix epoch ms) of a live process. Used to prove
 * whether the ledger lock really belongs to the PID recorded in it, so a
 * crash leftover whose PID was reused by an unrelated process (issue #786)
 * is detected as stale instead of blocking startup forever. Returns
 * undefined when the platform probe is unavailable; callers fail closed.
 */
function processStartTimeMs(pid: number): number | undefined {
  if (process.platform === 'linux') return linuxStartTimeMs(pid)
  if (process.platform === 'win32') {
    const probe = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        '[DateTimeOffset]::FromFileTime((Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToFileTime()).ToUnixTimeMilliseconds()'],
      { timeout: PROCESS_PROBE_TIMEOUT_MS, windowsHide: true },
    )
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const started = Number(probe.stdout.toString('utf8').trim())
    return Number.isFinite(started) ? started : undefined
  }
  // Other POSIX (macOS...): ps lstart with a forced English locale, falling
  // back to the elapsed-seconds column when lstart cannot be parsed.
  const env = { ...process.env, LC_ALL: 'C' }
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (probe.status === 0 && probe.stdout.length > 0) {
    const started = Date.parse(probe.stdout.toString('utf8').trim())
    if (Number.isFinite(started)) return started
  }
  const elapsed = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (elapsed.status !== 0 || elapsed.stdout.length === 0) return undefined
  const seconds = Number(elapsed.stdout.toString('utf8').trim())
  if (!Number.isFinite(seconds)) return undefined
  return Date.now() - seconds * 1000
}

function ownProcessStartTimeMs(): number | undefined {
  if (!ownStartTimeResolved) {
    ownStartTimeResolved = true
    ownStartTime = processStartTimeMs(process.pid)
  }
  return ownStartTime
}

/**
 * Bounded tolerance for legacy lock records. Locks written before the
 * ms-precise probe recorded `startedAt` from `ps -o lstart=` at whole-second
 * resolution; probing the SAME live process exactly (via /proc) then differs
 * in the sub-second remainder. Treating that as PID reuse would steal a live
 * owner's lock during a rolling upgrade and start a second ledger writer.
 * Records written by the ms-precise probe carry `probe: 'exact'` and are
 * compared strictly; anything else (older locks, second-granularity probes)
 * falls back to this bounded tolerance.
 */
const LEGACY_START_TOLERANCE_MS = 2000

/**
 * How long an unreadable lock must sit untouched before it may be reclaimed.
 * The owner writes and fsyncs its record immediately after creating the file
 * with O_EXCL, so a lock that cannot be parsed may still be mid-write by a
 * live owner; only one that has been unreadable for longer than any write can
 * take is treated as an unclean-shutdown leftover (issue #1528: a 0-byte lock
 * kept the Host half from mounting until it was deleted by hand).
 */
const UNREADABLE_LOCK_GRACE_MS = 60_000

/** Whether the recorded start time proves the recorded PID is another process. */
function startTimeMismatch(recorded: number, actual: number, exact: boolean): boolean {
  return exact ? recorded !== actual : Math.abs(recorded - actual) > LEGACY_START_TOLERANCE_MS
}

function betterExecution(a: ExecutionRecord, b: ExecutionRecord): ExecutionRecord {
  if (a.endedAt === undefined && b.endedAt !== undefined) return b
  if (b.endedAt === undefined && a.endedAt !== undefined) return a
  return (b.endedAt ?? b.startedAt) >= (a.endedAt ?? a.startedAt) ? b : a
}

function mergeTask(a: TaskRecord, b: TaskRecord): TaskRecord {
  // Existing Host state wins ties so an equally old browser backup cannot
  // roll authoritative fields back during multi-browser v1 migration.
  const newer = b.updatedAt > a.updatedAt ? b : a
  const byId = new Map<string, ExecutionRecord>()
  for (const entry of [...a.executions, ...b.executions]) {
    const previous = byId.get(entry.id)
    byId.set(entry.id, previous === undefined ? entry : betterExecution(previous, entry))
  }
  const executions = [...byId.values()].sort((x, y) => x.startedAt - y.startedAt)
  return { ...newer, executions: retainRecentExecutions(executions) }
}

function parseHostTasks(values: readonly unknown[]): TaskRecord[] {
  const rawById = new Map<string, Record<string, unknown>>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    if (typeof raw.id === 'string') rawById.set(raw.id, raw)
  }
  return parseLedger(JSON.stringify(values)).map(task => {
    const rawSchedule = rawById.get(task.id)?.schedule
    if (typeof rawSchedule !== 'object' || rawSchedule === null) return task
    const schedule = rawSchedule as Record<string, unknown>
    if (typeof schedule.cron !== 'string' || isValidCron(schedule.cron)) return task
    return {
      ...task,
      schedule: {
        enabled: false,
        cron: schedule.cron,
        nextRunAt: undefined,
        lastTriggeredAt: typeof schedule.lastTriggeredAt === 'number' && Number.isFinite(schedule.lastTriggeredAt)
          ? schedule.lastTriggeredAt
          : undefined,
      },
    }
  })
}

export class HostTaskLedger {
  private document: LedgerDocument
  private readonly listeners = new Set<() => void>()
  private readonly requestCache = new Map<string, CachedRequest>()
  private readonly lockToken = crypto.randomUUID()
  private lockFd: number | undefined
  readonly file: string
  readonly lockFile: string
  /** Small sidecar for the 30 s scheduler heartbeat (lastTickAt only). */
  readonly schedulerFile: string

  /** Session-default permission the confirmation gate compares against. */
  readonly sessionDefaultPermission: TaskPermission

  /** Optional git integration; undefined disables the branch/merge hooks. */
  private readonly git: GitWorkflow | undefined

  /** Done-column limit: on-board `done` cards allowed before FIFO displacement. */
  private maxDoneTasks: number

  /**
   * The Done-column limit in force. Read-only accessor for the Host snapshot,
   * which reports the configuration to the browser alongside the state.
   */
  get maxDoneTasksLimit(): number {
    return this.maxDoneTasks
  }

  /** The configurable state machine that validates every move and names its actions. */
  private machine: StateMachine

  /**
   * Per-card work chain: every heavy git job (branch/worktree creation, commit,
   * merge, worktree removal) runs here, off the action request and strictly in
   * order for one card. The action path therefore stays synchronous and fast;
   * an action that needs the result of earlier work awaits the chain first
   * ({@link awaitCard}), which the service does before applying it.
   */
  private readonly cardWork = new Map<string, Promise<void>>()
  /** Last background git failure per card (branch/worktree creation). */
  private readonly gitFailures = new Map<string, string>()
  /** Cards whose merge release is running right now (derived, never persisted). */
  private readonly releases = new Map<string, number>()
  /** Recent derived messages for the board's toast area. */
  private readonly noticeList: TaskBoardNotice[] = []
  /** Runs opened by a background job (conflict resolution); the service takes them. */
  private pendingRuns: OpenedRun[] = []
  private disposed = false

  constructor(dir: string = join(dshHome(), 'task-board'), private readonly now: () => number = Date.now, options: { sessionDefaultPermission?: TaskPermission; git?: GitWorkflow; maxDoneTasks?: number; stateMachine?: unknown } = {}) {
    this.sessionDefaultPermission = options.sessionDefaultPermission ?? DEFAULT_SESSION_PERMISSION
    this.git = options.git
    this.maxDoneTasks = normalizeMaxDoneTasks(options.maxDoneTasks)
    this.machine = resolveStateMachine(options.stateMachine).machine
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'ledger-v2.json')
    this.lockFile = join(dir, 'ledger-v2.lock')
    this.schedulerFile = join(dir, 'scheduler-v2.json')
    this.cleanStaleTemporaryFiles(dir)
    this.lockFd = this.acquireLock()
    try {
      this.document = this.load(dir)
      for (const request of this.document.recentRequests) {
        this.requestCache.set(request.requestId, { fingerprint: request.fingerprint })
      }
      this.repairSchedules(true)
      this.reconcileInterruptedStarts()
      // Persist a freshly generated ledger identity and any recovery error
      // immediately, even when there are no tasks to trigger a later action.
      this.commit(false)
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Remove leftover *.tmp-* files from previous crashes or interrupted writes. */
  private cleanStaleTemporaryFiles(dir: string): void {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.includes('.tmp-')) {
          try {
            unlinkSync(join(dir, entry))
          } catch {
            // Best-effort cleanup
          }
        }
      }
    } catch {
      // Directory may not exist yet or cannot be read
    }
  }

  /** Revision + scheduler without any task cloning; feeds the SSE event frame. */
  summary(): { revision: number; scheduler: TaskBoardSchedulerSnapshot } {
    const { importedSources: _imports, ...scheduler } = this.document.scheduler
    return { revision: this.document.revision, scheduler: { ...scheduler } }
  }

  state(): LedgerState {
    const { revision, scheduler } = this.summary()
    return { revision, tasks: cloneTasks(this.document.tasks), scheduler }
  }

  /**
   * One card as a live ledger reference (no clone), for Host-side bookkeeping
   * that must not pay for a whole-ledger copy — a review action resolving its
   * card, or a cleanup notice after the card is gone.
   */
  task(taskId: string): TaskRecord | undefined {
    return this.document.tasks.find(item => item.id === taskId)
  }

  // --- background work --------------------------------------------------------

  /**
   * Wait until every background git job queued for one card has finished.
   *
   * The action path calls this before applying an action that depends on the
   * card's git state (a commit must be stamped before the card can be released,
   * a branch must exist before a run starts). It never blocks the browser: the
   * UI has already accepted the action into its outbox, and the event loop keeps
   * serving `/state`, `/parse` and SSE while this promise waits.
   */
  async awaitCard(taskId: string): Promise<void> {
    // A job may be queued while we wait (a settle during the await); keep waiting
    // until the card's chain really stands still, so an action never overtakes
    // the work it depends on.
    for (;;) {
      const pending = this.cardWork.get(taskId)
      if (pending === undefined) return
      await pending.catch(() => {})
      if (this.cardWork.get(taskId) === pending) return
    }
  }

  /** Merge releases currently running, as the derived snapshot marker. */
  pendingReleases(): Record<string, { startedAt: number }> {
    return Object.fromEntries([...this.releases.entries()].map(([taskId, startedAt]) => [taskId, { startedAt }]))
  }

  /** Recent derived Host messages (git failures, refused releases), newest last. */
  notices(): TaskBoardNotice[] {
    const now = this.now()
    return this.noticeList.filter(notice => now - notice.at <= NOTICE_TTL_MS).map(notice => ({ ...notice }))
  }

  /** Runs opened by a background job; the service schedules them and calls this again. */
  takeRuns(): OpenedRun[] {
    const runs = this.pendingRuns
    this.pendingRuns = []
    return runs
  }

  /**
   * Make sure the card stands on its feature branch and worktree before a run
   * starts. Awaits earlier background work first, then creates the branch when
   * the card has a repository but no branch yet. Fails closed: a git error is
   * thrown to the caller (which fails the run visibly), never silently ignored.
   */
  async ensureBranch(taskId: string): Promise<TaskRecord | undefined> {
    await this.awaitCard(taskId)
    const task = this.task(taskId)
    if (task === undefined || task.git !== undefined) return task
    if (this.git === undefined || this.git.repoPath(task) === undefined) return task
    try {
      const git = await this.git.openBranch(task)
      if (git === undefined) return task
      this.gitFailures.delete(taskId)
      this.patchTask(taskId, current => current.git === undefined ? { ...current, git, updatedAt: this.now() } : current)
      return this.task(taskId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.gitFailures.set(taskId, message)
      this.pushNotice(taskId, `branch could not be created: ${message}`)
      throw error
    }
  }

  /**
   * Queue one heavy job on a card's chain. Jobs never reject the chain (their
   * own errors become notices/card records), so one failure cannot wedge the
   * card's later work; the chain resolves when the job has written its outcome.
   */
  private enqueueCardWork(taskId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.cardWork.get(taskId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      if (this.disposed) return
      await work()
    })
    const tail = operation.then(() => {}, () => {})
    this.cardWork.set(taskId, tail)
    void operation.finally(() => {
      if (this.cardWork.get(taskId) === tail) this.cardWork.delete(taskId)
      this.notify()
    }).catch(() => {})
    return operation
  }

  /**
   * Patch one card in place and persist when it really changed. Background jobs
   * use this so a card moved/deleted while the job ran is not resurrected and
   * an untouched document is not rewritten.
   */
  private patchTask(taskId: string, update: (task: TaskRecord) => TaskRecord | undefined): boolean {
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      if (task.id !== taskId) return task
      const next = update(task)
      if (next === undefined || next === task) return task
      changed = true
      return next
    })
    if (changed) this.commit()
    return changed
  }

  /** Record one derived user-facing message (kept short-lived; never persisted). */
  private pushNotice(taskId: string | undefined, message: string): void {
    this.noticeList.push({
      id: crypto.randomUUID(),
      ...(taskId === undefined ? {} : { taskId }),
      message,
      at: this.now(),
    })
    while (this.noticeList.length > NOTICE_LIMIT) this.noticeList.shift()
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Cheap projection for the review plan map: the cards standing in the review
   * column. The derived plans are recomputed on every ledger change, so this
   * path must not clone the ledger ({@link HostTaskLedger.state}); the planner
   * only reads each card and the filesystem behind it.
   */
  reviewCandidates(): readonly TaskRecord[] {
    return this.document.tasks.filter(task => task.archivedAt === undefined && task.status === 'ready_for_test')
  }

  /**
   * The state machine currently in force, i.e. what the Host validates moves
   * against and what the browser renders its columns and drop targets from.
   */
  get stateMachine(): StateMachine {
    return this.machine
  }

  /**
   * Apply the board's state machine (settings namespace `task-board`, field
   * `stateMachine`). Takes effect on the next move; an invalid config is
   * ignored by the resolver, which keeps the machine already in force.
   * @param config - raw machine config; undefined keeps the shipped machine.
   * @returns the refusals of an invalid config (empty when it was applied).
   */
  setStateMachine(config: unknown): string[] {
    const resolved = resolveStateMachine(config)
    this.machine = resolved.machine
    return resolved.errors
  }

  /**
   * Apply the board's Done-column limit (settings namespace `task-board`,
   * `maxDoneTasks`) and converge the column immediately: an already over-limit
   * `done` column (a lowered limit, restored cards, a freshly imported ledger)
   * is trimmed right here, so the board never keeps showing more than N cards
   * until the next move. Displacement keeps the FIFO order and archives (never
   * deletes) exactly the surplus.
   * @param limit - configured maximum; values below 1 or non-finite keep the default.
   */
  setMaxDoneTasks(limit: number): void {
    this.maxDoneTasks = normalizeMaxDoneTasks(limit)
    const { tasks, archivedIds } = enforceDoneLimit(this.document.tasks, this.maxDoneTasks, this.now())
    if (archivedIds.length === 0) return
    this.document.tasks = [...tasks]
    this.releaseArchivedWorktrees(archivedIds)
    this.commit()
  }

  /**
   * Runtime-only projection for the 5 s Host poll. It copies just primitive
   * identifiers and timestamps, never the complete task/execution history or
   * an authoritative mutable object from the ledger.
   */
  runtimeView(): LedgerRuntimeView {
    let armedSchedules = 0
    const openExecutions: OpenExecutionReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) armedSchedules += 1
      // A paused run is deliberately invisible here: the monitor must not
      // inspect (and settle) a run the user suspended, and the freed WIP slot is
      // what lets the lane's remaining work start.
      if (task.pausedAt !== undefined) continue
      for (const execution of task.executions) {
        if (execution.endedAt !== undefined) continue
        openExecutions.push({
          taskId: task.id,
          executionId: execution.id,
          sessionId: execution.sessionId,
          startedAt: execution.startedAt,
          lane: taskLane(task),
          kind: execution.kind,
        })
      }
    }
    return { armedSchedules, openExecutions }
  }

  /**
   * The cards the rework watch follows: every settled card in `ready_for_test`
   * or `failed`, with the conversation the human would write the correction
   * into. A cheap projection on purpose — the watch runs on the hot poll path,
   * which must not clone the whole document.
   */
  reworkWatch(): ReworkWatchEntry[] {
    const entries: ReworkWatchEntry[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt !== undefined) continue
      if (task.status !== 'ready_for_test' && task.status !== 'failed') continue
      // The newest settled conversation, scanning from the tail: that is where
      // the human would write the correction (a clarification round that never
      // opened an implementation has no settle and cannot match).
      for (let index = task.executions.length - 1; index >= 0; index -= 1) {
        const execution = task.executions[index]
        if (execution.sessionId === undefined || execution.endedAt === undefined) continue
        entries.push({ taskId: task.id, sessionId: execution.sessionId, since: execution.endedAt })
        break
      }
    }
    return entries
  }

  /**
   * The cards the question watch follows: every card that can currently be
   * waiting for the human's answer, with the conversation that answer would go
   * into. Cheap on purpose — the watch runs on the hot poll path, which must not
   * clone the whole document.
   *
   * Two kinds qualify. A card with an open, unsettled run: the agent may ask
   * inside it (a blocking `ask_user_question`, or a prose question it stopped
   * on). And a `clarification` card that already ran its clarification round:
   * that run settles without moving the card, so the questions it asked are
   * still unanswered in the very conversation the card keeps. Paused cards are
   * left out — their session was stopped deliberately, which is not a wait.
   */
  awaitingAnswerWatch(): AnswerWatchEntry[] {
    const entries: AnswerWatchEntry[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt !== undefined || task.pausedAt !== undefined) continue
      const latest = task.executions[task.executions.length - 1]
      const open = latest !== undefined && latest.endedAt === undefined
      const clarifying = task.status === 'clarification' && task.clarificationSessionId !== undefined
      if (!open && !clarifying) continue
      // The card's own jump target: the newest execution's conversation, and the
      // clarification conversation of a card that only ever had that one.
      const sessionId = latest?.sessionId ?? task.clarificationSessionId
      if (sessionId === undefined) continue
      entries.push({ taskId: task.id, sessionId })
    }
    return entries
  }

  /** Whether the card's open run is currently suspended by a pause. */
  isPaused(taskId: string): boolean {
    return this.document.tasks.find(task => task.id === taskId)?.pausedAt !== undefined
  }

  /**
   * Whether `executionId` of `taskId` is still unsettled. A queued launch asks
   * this right before it starts: the go-ahead of a card whose clarification run
   * was still waiting closes that execution, and starting its session anyway
   * would mint the second conversation the card must never have.
   */
  isOpenExecution(taskId: string, executionId: string): boolean {
    const task = this.document.tasks.find(item => item.id === taskId)
    return task !== undefined && task.executions.some(execution =>
      execution.id === executionId && execution.endedAt === undefined)
  }

  /**
   * Clear a pause stamp without resuming the run. Used when stopping the paused
   * session failed (no live agent to stop): the card goes back to the normal
   * monitor, which settles the run on its own instead of leaving it frozen.
   */
  clearPause(taskId: string): void {
    const now = this.now()
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      if (task.id !== taskId || task.pausedAt === undefined) return task
      changed = true
      return withPause(task, false, now)
    })
    if (changed) this.commit()
  }

  /** Count armed, non-archived schedules without cloning task histories. */
  armedScheduleCount(): number {
    let count = 0
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) count += 1
    }
    return count
  }

  /** Return value-only references for schedules due at the supplied Host time. */
  dueSchedules(now: number): DueScheduleReference[] {
    const due: DueScheduleReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt !== undefined) continue
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      due.push({ taskId: task.id, cron: schedule.cron, nextRunAt: schedule.nextRunAt })
    }
    return due
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Close the card's open clarification round, if it has one, because the human
   * pulled the card on to the run column: the implementation takes over that
   * conversation, and the card must never hold two open executions (or two
   * conversations). The round is recorded as cancelled — it was neither
   * completed by the agent nor failed — and a launch not started yet is dropped
   * by the pump.
   */
  private supersedeClarification(task: TaskRecord, now: number): TaskRecord {
    const round = openExecution(task)
    if (round?.kind !== 'clarify') return task
    return settleExecution(task, round.id, 'cancelled', now, 'superseded by the implementation run')
  }

  /**
   * Ensure the card has a feature branch before it starts. The backlog →
   * clarification pull normally opens it; a cron trigger or the detail Run
   * button may bypass that, and those runs must not land on the base branch.
   * The branch is created on the card's work chain (off the action request);
   * the run waits for it in `HostTaskBoardService.launch`, which calls
   * {@link ensureBranch}.
   */
  private ensureFeatureBranchLater(task: TaskRecord): TaskRecord {
    if (task.git !== undefined) return task
    this.enqueueOpenBranch(task.id)
    return task
  }

  /** Queue `git.openBranch` for one card (no-op when a branch already exists). */
  private enqueueOpenBranch(taskId: string): void {
    void this.enqueueCardWork(taskId, async () => {
      const task = this.task(taskId)
      if (task === undefined || task.git !== undefined) return
      if (this.git === undefined || this.git.repoPath(task) === undefined) return
      try {
        const git = await this.git.openBranch(task)
        if (git === undefined) return
        this.gitFailures.delete(taskId)
        this.patchTask(taskId, current => current.git === undefined ? { ...current, git, updatedAt: this.now() } : current)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.gitFailures.set(taskId, message)
        this.pushNotice(taskId, `branch could not be created: ${message}`)
      }
    })
  }

  /**
   * The card after a transition's git hooks were **scheduled**. Only the first
   * git action of a transition applies; `"git": false` skips them entirely;
   * without a repository the hooks are no-ops. The hooks run on the card's work
   * chain instead of inside the action, so a commit or worktree creation never
   * blocks the event loop or the user. Shared by the single-card and the batch
   * move so a group drop fires exactly the hooks a single drop would.
   */
  private transitionGit(task: TaskRecord, transition: StateTransition, now: number): TaskRecord {
    if (transition.git === false) return task
    for (const action of transition.actions ?? []) {
      if (action === 'git.openBranch') {
        this.enqueueOpenBranch(task.id)
        return task
      }
      // Parking the card for the review drops the release record of the review
      // before it: the next release starts from a clean slate. The commit itself
      // is queued and stamps `reviewedCommit` when it lands.
      if (action === 'git.commitBranch') {
        this.enqueueCommit(task.id)
        return this.clearRelease(task)
      }
      // A merge transition is the release path and never runs here: the caller
      // checks for it and starts a release plan instead.
      if (action === 'git.mergeBranch') return task
    }
    return task
  }

  /**
   * Queue a commit of the card's worktree onto its feature branch. A git failure
   * never fails the move or the settle — the worktree is the human's to repair —
   * so the error is appended to the card's newest *settled* execution `error`
   * and surfaced as a notice. A card without a settled execution has nothing to
   * carry it and only gets the Host warning + notice.
   */
  private enqueueCommit(taskId: string): void {
    void this.enqueueCardWork(taskId, async () => {
      const task = this.task(taskId)
      if (task === undefined || this.git === undefined) return
      try {
        const git = await this.git.commitBranch(task, this.now())
        if (git === undefined) return
        this.gitFailures.delete(taskId)
        this.patchTask(taskId, current => ({ ...current, git }))
      } catch (error) {
        this.recordCommitError(taskId, error)
      }
    })
  }

  private recordCommitError(taskId: string, error: unknown): void {
    const detail = `commit failed: ${error instanceof Error ? error.message : String(error)}`
    const task = this.task(taskId)
    if (task === undefined) return
    this.pushNotice(taskId, detail)
    let index = -1
    for (let entryIndex = task.executions.length - 1; entryIndex >= 0; entryIndex -= 1) {
      if (task.executions[entryIndex].endedAt !== undefined) {
        index = entryIndex
        break
      }
    }
    if (index === -1) {
      console.warn(`task board: ${taskId}: ${detail}`)
      return
    }
    this.patchTask(taskId, current => ({
      ...current,
      executions: current.executions.map((entry, entryIndex) => entryIndex === index
        ? { ...entry, error: entry.error === undefined || entry.error === '' ? detail : `${entry.error}; ${detail}` }
        : entry),
    }))
  }

  /**
   * Commit the work an implementation run left behind as it settles, so the
   * worktree never keeps uncommitted card work — not even when the run failed
   * or was cancelled, and not after a restart reconciled an interrupted start.
   * A clarification run implements nothing and checks no branch out, so it
   * never mints a commit of whatever the worktree happens to hold.
   */
  private commitSettledWork(task: TaskRecord, executionId: string, now: number): TaskRecord {
    const execution = task.executions.find(entry => entry.id === executionId)
    if (execution === undefined || execution.kind === 'clarify') return task
    this.enqueueCommit(task.id)
    return task
  }

  /**
   * Drop the previous release record: the card is back in the review column for
   * a new review. Called from the park hooks (the `git.commitBranch` action and
   * a settling run), so the next release starts from a clean slate instead of
   * showing the state of the review before it.
   */
  private clearRelease(task: TaskRecord): TaskRecord {
    if (task.merge === undefined) return task
    const { merge: _released, ...rest } = task
    return rest
  }

  /** The merge record a release starts from (destructured out of the current card). */
  private releaseBase(task: TaskRecord, now: number): TaskMerge {
    const git = task.git
    const previous = task.merge
    return {
      releasedAt: previous?.releasedAt ?? now,
      ...(git?.reviewedCommit === undefined ? {} : { commit: git.reviewedCommit }),
      attempts: previous?.attempts ?? 0,
      ...(previous?.conflict === undefined ? {} : { conflict: previous.conflict }),
      ...(previous?.resolvedAt === undefined ? {} : { resolvedAt: previous.resolvedAt }),
    }
  }

  /**
   * Release the worktrees of cards that just became archived — the explicit
   * archive action and the Done-column limit alike. Archiving is the last board
   * state a card reaches, so no later run needs the directory; the branch, its
   * commits and the review stamp stay in the repository. A git that refuses
   * (a locked worktree, an open file) never fails the archive: the Host poll
   * retries it on the archived card ({@link HostTaskLedger.archivedWorktrees}).
   * @param ids - cards that the archive just took off the board.
   */
  private releaseArchivedWorktrees(ids: readonly string[]): void {
    for (const id of ids) {
      const task = this.document.tasks.find(item => item.id === id)
      if (task?.git === undefined) continue
      // The removal runs on the card's work chain, never in the action path. A
      // refusal is not fatal: the Host poll's reconcileArchivedWorktrees retries
      // it and logs it once (a locked worktree is never unlocked behind the
      // human's back).
      void this.enqueueCardWork(task.id, async () => {
        await this.git?.releaseWorktree(task)
      })
    }
  }

  /**
   * Archived cards whose own worktree directory still exists, so the Host poll
   * can retry releasing it: git may have refused at archive time, or the card
   * was archived before archiving released the worktree. A runtime projection on
   * the hot poll path — it never clones the document.
   */
  archivedWorktrees(): TaskRecord[] {
    return this.document.tasks.filter(task => task.archivedAt !== undefined
      && task.git?.worktreePath !== undefined
      && existsSync(task.git.worktreePath))
  }

  /**
   * The merge release of one card: replay its feature branch onto the base
   * branch as that stands now and merge it back. The git work is queued on the
   * card's work chain and the action returns at once with `pending: true`: the
   * card stays in `ready_for_test` (a derived "release running" marker explains
   * the wait) until the outcome is written back. Nothing optimistic ever claims
   * a column the Host has not written.
   *
   * The decision table (the human's "Freigeben (Merge)"):
   *
   * - no branch at all (no repository, or a workspace outside git): the release
   *   is the plain move to `done`, recorded as skipped so the card says "no
   *   branch" instead of pretending it merged something,
   * - merge succeeds: `done`, `TaskGit.mergedAt` and {@link TaskMerge.mergedAt}
   *   stamped,
   * - merge refused (dirty worktree, moved branch, no reviewed commit) or fails:
   *   the card goes to `failed` with the reason,
   * - the replay conflicts: the half-done rebase is left in the card's own
   *   worktree and the card goes to `running` on a `merge` run; one automatic
   *   resolution run per release, whose settle retries the release.
   */
  private beginRelease(task: TaskRecord, now: number, initiator?: string): ReleaseResult {
    const git = task.git
    if (git === undefined) {
      const merge: TaskMerge = { releasedAt: now, attempts: 0, skipped: true }
      return { task: withStatus({ ...task, merge }, 'done', now) }
    }
    const base = this.releaseBase(task, now)
    const plan: ReleasePlan = {
      taskId: task.id,
      reviewedCommit: git.reviewedCommit ?? '',
      base,
      at: now,
      ...(initiator === undefined || initiator === '' ? {} : { initiator }),
    }
    this.releases.set(task.id, now)
    this.notify()
    this.enqueueRelease(plan)
    return { task, pending: true }
  }

  private enqueueRelease(plan: ReleasePlan): void {
    void this.enqueueCardWork(plan.taskId, async () => { await this.runRelease(plan) })
  }

  /**
   * The background half of a release: check the card is still the card the
   * human approved, then run the merge and write the outcome back. A card that
   * left the review column meanwhile is never moved by a late release.
   */
  private async runRelease(plan: ReleasePlan): Promise<void> {
    try {
      const task = this.task(plan.taskId)
      if (task === undefined || task.archivedAt !== undefined || task.status !== 'ready_for_test') {
        this.pushNotice(plan.taskId, 'release cancelled: the card left the review column before the merge started')
        return
      }
      if (task.git === undefined || this.git === undefined) {
        this.finishRelease(plan, { error: 'the card has no git state to merge' })
        return
      }
      if (plan.reviewedCommit === '') {
        this.finishRelease(plan, { error: 'merge refused: the card has no reviewed commit; park the card in "Ready for test" again so the approval is bound to the commit you reviewed' })
        return
      }
      if (task.git.reviewedCommit !== plan.reviewedCommit) {
        this.finishRelease(plan, { error: 'the card was parked again while the release was waiting; review the new commit and release again' })
        return
      }
      if (this.git.hasUnresolvedMerge(task)) {
        this.git.abortUnresolvedMerge(task)
        throw new Error('the merge conflict was not resolved: the worktree still holds an unfinished conflict (unmerged files, or a rebase that was never continued)')
      }
      const merged = await this.git.mergeBranch(task, plan.at)
      this.finishRelease(plan, { merged })
    } catch (error) {
      if (error instanceof MergeConflictError) this.finishRelease(plan, { conflict: error })
      else this.finishRelease(plan, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.releases.delete(plan.taskId)
      this.notify()
    }
  }

  /** Write a finished release back to the ledger (the only place a release moves a card). */
  private finishRelease(plan: ReleasePlan, outcome: ReleaseOutcome): void {
    const task = this.task(plan.taskId)
    if (task === undefined) return
    const now = this.now()
    // The card left the review column while the merge ran (another tab, a
    // send-back): record what git did, but never overwrite the human's move.
    if (task.status !== 'ready_for_test') {
      this.patchTask(task.id, current => ({
        ...current,
        ...(outcome.merged === undefined ? {} : { git: outcome.merged }),
        ...(outcome.merged === undefined && outcome.conflict === undefined && outcome.error === undefined
          ? {}
          : { merge: { ...plan.base, ...(outcome.merged === undefined ? { error: outcome.error ?? outcome.conflict?.message ?? 'the release finished after the card left the review column' } : { mergedAt: now }) } }),
        updatedAt: now,
      }))
      this.pushNotice(task.id, 'release finished after the card left the review column; the result was recorded but the column was not changed')
      return
    }
    if (outcome.merged !== undefined || task.git?.mergedAt !== undefined) {
      const merged = outcome.merged ?? task.git
      const merge: TaskMerge = { ...plan.base, mergedAt: now }
      this.applyReleaseResult(withStatus({ ...task, ...(merged === undefined ? {} : { git: merged }), merge }, 'done', now))
      return
    }
    if (outcome.conflict !== undefined) {
      const result = this.resolveConflict({ ...task, merge: plan.base }, plan.base, outcome.conflict, now, plan.initiator)
      // Register the run before the commit notification: the service's ledger
      // subscription takes pending runs, and it runs during that notification.
      if (result.run !== undefined) this.pendingRuns.push(result.run)
      this.applyReleaseResult(result.task)
      return
    }
    const message = outcome.error ?? 'the release failed'
    this.applyReleaseResult(withStatus({ ...task, merge: { ...plan.base, error: message } }, 'failed', now))
    this.pushNotice(task.id, `release failed: ${message}`)
  }

  /** Persist one release result and keep the Done-column limit converged. */
  private applyReleaseResult(task: TaskRecord): void {
    const moved = this.document.tasks.map(item => item.id === task.id ? task : item)
    if (task.status === 'done') {
      const limited = enforceDoneLimit(moved, this.maxDoneTasks, this.now())
      this.document.tasks = [...limited.tasks]
      this.releaseArchivedWorktrees(limited.archivedIds)
    } else {
      this.document.tasks = moved
    }
    this.commit()
  }

  /**
   * Hand the release's conflict to the card's agent. The replay onto the base is
   * already sitting in the card's own worktree — conflict markers, a rebase
   * waiting for `git rebase --continue` — so nothing has to be started here: the
   * run sees exactly that state and finishes it.
   *
   * Exactly one resolution run per release (`MERGE_RESOLVE_ATTEMPTS`): a second
   * conflict aborts the half-done replay and fails the release, so the release
   * can never become a loop. Aborting puts the branch back onto the commit the
   * human reviewed, which is what a later release starts from again.
   */
  private resolveConflict(task: TaskRecord, merge: TaskMerge, conflict: MergeConflictError, now: number, initiator?: string): ReleaseResult {
    const conflicted: TaskMerge = { ...merge, conflict: conflict.message }
    if (merge.attempts >= MERGE_RESOLVE_ATTEMPTS) {
      this.git?.abortUnresolvedMerge(task)
      return { task: withStatus({ ...task, merge: { ...conflicted, error: conflict.message } }, 'failed', now) }
    }
    const opened = startExecution(
      { ...task, merge: { ...conflicted, attempts: merge.attempts + 1 } },
      now,
      crypto.randomUUID(),
      initiator,
      'merge',
    )
    return { task: opened.task, run: { task: opened.task, execution: opened.execution } }
  }

  /**
   * What happens once a conflict-resolution run settled. A run that did not
   * succeed (or one that ended with the replay still unfinished) leaves the
   * conflict unresolved: the worktree is put back into a clean state, the card
   * says why, and the release ends in `failed` — the second attempt the decision
   * allows is used up. A run that did resolve it queues the release retry after
   * that run's settle commit, which either finishes the release (`done`) or
   * fails it.
   */
  private onMergeRunSettled(task: TaskRecord, outcome: 'succeeded' | 'failed' | 'cancelled', error: string | undefined, now: number): TaskRecord {
    const merge = task.merge
    if (merge === undefined || merge.mergedAt !== undefined) return task
    if (outcome !== 'succeeded') {
      this.git?.abortUnresolvedMerge(task)
      const reason = error !== undefined && error !== '' ? error : outcome === 'cancelled'
        ? 'the conflict-resolution run was cancelled'
        : 'the conflict-resolution run failed'
      this.pushNotice(task.id, `release failed: ${reason}`)
      return { ...task, merge: { ...merge, error: reason }, updatedAt: now }
    }
    // The run resolved the conflict; its settle enqueued the commit above, so
    // this job runs after it and its plan binds the new reviewed commit.
    this.releases.set(task.id, now)
    this.notify()
    void this.enqueueCardWork(task.id, async () => {
      const current = this.task(task.id)
      if (current === undefined || current.status !== 'ready_for_test' || current.git?.reviewedCommit === undefined) {
        this.releases.delete(task.id)
        this.notify()
        return
      }
      const base: TaskMerge = { ...this.releaseBase(current, this.now()), resolvedAt: now }
      await this.runRelease({
        taskId: task.id,
        reviewedCommit: current.git.reviewedCommit,
        base,
        at: this.now(),
      })
    })
    return task
  }

  dispose(): void {
    this.disposed = true
    this.cardWork.clear()
    this.releases.clear()
    this.pendingRuns = []
    const fd = this.lockFd
    if (fd === undefined) return
    this.lockFd = undefined
    closeSync(fd)
    try {
      const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { token?: unknown }
      if (owner.token === this.lockToken) unlinkSync(this.lockFile)
    } catch {
      // A missing or externally replaced lock must not be removed blindly.
    }
  }

  applyRequest(
    requestId: string,
    action: TaskBoardAction,
    initiator?: string,
  ): { state: LedgerState; run?: OpenedRun; clarification?: OpenedRun; paused?: PausedRun[]; resumed?: ResumedRun[]; review?: ReviewIntent[] } {
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex')
    const cached = this.requestCache.get(requestId)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) throw new Error('request id was reused with a different action')
      return { state: this.state() }
    }

    // Add the fingerprint before apply(): successful actions persist it in the
    // same atomic ledger write as their state transition.
    this.requestCache.set(requestId, { fingerprint })
    while (this.requestCache.size > MAX_REQUEST_CACHE) this.requestCache.delete(this.requestCache.keys().next().value as string)
    this.syncRecentRequests()
    try {
      return this.apply(action, initiator)
    } catch (error) {
      this.requestCache.delete(requestId)
      this.syncRecentRequests()
      throw error
    }
  }

  openScheduled(taskId: string, nextRunAt: number | undefined, triggeredAt: number): OpenedRun | undefined {
    const task = this.document.tasks.find(item => item.id === taskId)
    if (task === undefined || task.archivedAt !== undefined) return undefined
    if (requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
      // An unconfirmed above-default permission must never run unattended:
      // cron refuses the card and rolls to the next occurrence, exactly
      // like the already-running refusal.
      this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, task.schedule?.lastTriggeredAt, triggeredAt)]
      this.commit()
      return undefined
    }
    if (task.status === 'running' || hasOpenExecution(task)) {
      this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, task.schedule?.lastTriggeredAt, triggeredAt)]
      this.commit()
      return undefined
    }
    const opened = startExecution(this.ensureFeatureBranchLater(task), triggeredAt, crypto.randomUUID())
    this.document.tasks = this.document.tasks.map(item => item.id === taskId ? opened.task : item)
    this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, triggeredAt, triggeredAt)]
    this.commit()
    return opened
  }

  skipMissed(now: number): void {
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: nextRunAtMs(schedule.cron, now) }, updatedAt: now }
    })
    if (changed) this.commit()
  }

  setScheduler(patch: Partial<TaskBoardSchedulerSnapshot>): void {
    this.document.scheduler = { ...this.document.scheduler, ...patch }
    // The 30 s heartbeat only moves lastTickAt; rewriting the whole ledger
    // for it made idle idle cost O(ledger bytes) every tick. Persist it to a
    // tiny sidecar instead; any other patch still goes through the full
    // atomic commit.
    if (patch.lastTickAt !== undefined && Object.keys(patch).every(key => key === 'lastTickAt')) {
      try {
        this.writeSchedulerSidecar()
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
          // Disk is full; sidecar persistence fails, but in-memory heartbeat
          // remains updated. Swallow to prevent unhandled log cascade crashes.
          return
        }
        throw error
      }
      return
    }
    this.commit(false)
  }

  attachSession(taskId: string, executionId: string, sessionId: string): void {
    const now = this.now()
    this.document.tasks = this.document.tasks.map(task => {
      if (task.id !== taskId) return task
      const target = task.executions.find(entry => entry.id === executionId)
      return {
        ...task,
        updatedAt: now,
        // A clarification's session is the card's conversation: recording it on
        // the card is what its link, the run that continues it (no second
        // session) and the reuse rule read.
        ...(target?.kind === 'clarify' ? { clarificationSessionId: sessionId } : {}),
        executions: task.executions.map(entry => entry.id === executionId ? { ...entry, sessionId } : entry),
      }
    })
    this.commit()
  }

  /**
   * Record the card's Docker Compose environment (or clear it with `undefined`).
   * Like {@link HostTaskLedger.attachSession} this is a Host-side write, not a
   * browser action: the service owns the lifecycle, and the record only makes
   * the state — project, ports, failure — visible on the card.
   */
  noteCompose(taskId: string, compose: TaskCompose | undefined): void {
    const now = this.now()
    const task = this.document.tasks.find(item => item.id === taskId)
    if (task === undefined) return
    const current = JSON.stringify(task.compose ?? null)
    const next = JSON.stringify(compose ?? null)
    if (current === next) return
    this.document.tasks = this.document.tasks.map(item => item.id === taskId
      ? { ...item, compose, updatedAt: now }
      : item)
    this.commit()
  }

  /**
   * Record the card's review environment (or clear it with `undefined`). Like
   * {@link HostTaskLedger.noteCompose} this is a Host-side write, not a browser
   * action: the service owns the lifecycle, and the record only makes the state
   * — how it runs, where, which URLs answer, what failed — visible on the card.
   * A card that left the review column in the meantime keeps no record.
   */
  noteReview(taskId: string, review: TaskReview | undefined): void {
    const now = this.now()
    const task = this.document.tasks.find(item => item.id === taskId)
    if (task === undefined) return
    const current = JSON.stringify(task.review ?? null)
    const next = JSON.stringify(review ?? null)
    if (current === next) return
    this.document.tasks = this.document.tasks.map(item => item.id === taskId
      ? { ...item, review, updatedAt: now }
      : item)
    this.commit()
  }

  settle(taskId: string, executionId: string, outcome: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    const now = this.now()
    this.document.tasks = this.document.tasks.map(task => {
      // A paused run is not settled: the aborted turn the pause produced must
      // not park the card in `failed`/`clarification`. This also closes the race
      // where an inspection started just before the pause was written.
      if (task.id !== taskId || task.pausedAt !== undefined) return task
      const execution = task.executions.find(entry => entry.id === executionId)
      const settled = settleExecution(task, executionId, outcome, now, error)
      // The work leaves the worktree the moment the run settles — success parks
      // the card in `ready_for_test` on its committed feature branch, and a
      // failure or cancellation commits just the same so nothing lingers.
      if (settled === task) return task
      const committed = this.commitSettledWork(settled, executionId, now)
      // A conflict-resolution run is not a review: its settle is what makes the
      // Host retry the merge the card was released for.
      if (execution?.kind === 'merge') return this.onMergeRunSettled(committed, outcome, error, now)
      // A finished implementation run parks the card for a new review, so the
      // release record of the review before it is dropped here.
      return outcome === 'succeeded' ? this.clearRelease(committed) : committed
    })
    this.commit()
  }

  private apply(action: TaskBoardAction, initiator?: string): { state: LedgerState; run?: OpenedRun; clarification?: OpenedRun; paused?: PausedRun[]; resumed?: ResumedRun[]; review?: ReviewIntent[] } {
    const now = this.now()
    let run: OpenedRun | undefined
    let clarification: OpenedRun | undefined
    let paused: PausedRun[] | undefined
    let resumed: ResumedRun[] | undefined
    let review: ReviewIntent[] | undefined
    switch (action.kind) {
      case 'import': {
        const sources = new Set(this.document.scheduler.importedSources ?? [])
        if (sources.has(action.sourceId)) return { state: this.state() }
        const invalidScheduleIds = action.tasks
          .filter(task => task.schedule !== undefined && !isValidCron(task.schedule.cron))
          .map(task => task.id)
        const incoming = parseHostTasks(action.tasks)
        const merged = new Map(this.document.tasks.map(task => [task.id, task]))
        for (const task of incoming) merged.set(task.id, merged.has(task.id) ? mergeTask(merged.get(task.id)!, task) : task)
        this.document.tasks = [...merged.values()]
        this.document.scheduler.importedSources = [...sources, action.sourceId]
        this.document.scheduler.error = invalidScheduleIds.length === 0
          ? undefined
          : `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}`
        this.repairSchedules(true, false)
        this.reconcileInterruptedStarts(false)
        break
      }
      case 'create': {
        if (this.document.tasks.some(task => task.id === action.id)) throw new Error('task id already exists')
        if (action.input.schedule?.enabled === true && (!isValidCron(action.input.schedule.cron) || nextRunAtMs(action.input.schedule.cron, now) === undefined)) {
          throw new Error('invalid schedule')
        }
        const input = action.input.freeze === undefined || initiator === undefined || initiator === ''
          ? action.input
          : { ...action.input, freeze: { ...action.input.freeze, frozenBy: initiator } }
        const result = applyCreateTask(this.document.tasks, input, now, action.id, this.machine.initialStatus)
        if (result.task === undefined) throw new Error('invalid task')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'update': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        // The task content (title/description/prompt and the parse source) is
        // the record of what was planned. It stays editable only while the
        // card waits in a pre-execution column: a running task must not change
        // under its session, and a card that moved on to
        // ready_for_test/done/failed keeps the content that ran. Execution
        // targets stay editable (they only affect future runs).
        if (hasContentPatch(action.patch) && !canEditTaskContent(task)) {
          throw new Error('task content is locked outside backlog and clarification')
        }
        if ('title' in action.patch && action.patch.title?.trim() === '') throw new Error('title is required')
        // A replaced snapshot is re-stamped with the updating session (the
        // initiator), so a swapped freeze cannot keep the old author stamp.
        const patch = action.patch.freeze === null || action.patch.freeze === undefined || initiator === undefined || initiator === ''
          ? action.patch
          : { ...action.patch, freeze: { ...action.patch.freeze, frozenBy: initiator } }
        this.document.tasks = [...applyUpdateTask(this.document.tasks, action.taskId, patch, now)]
        break
      }
      case 'delete':
        {
          const task = this.document.tasks.find(task => task.id === action.taskId)
          if (task === undefined) throw new Error('task not found')
          if (task.status === 'running' || hasOpenExecution(task)) throw new Error('running task cannot be deleted')
          // The card's worktree is only ever referenced by this card, so deleting
          // the card releases it (the branch and its commits stay in the repo).
          // The removal runs on the card's work chain: a slow filesystem never
          // keeps the browser waiting for the delete. Deleting is final, so a
          // refusal is logged here (there is no archived card for the poll to
          // retry on).
          if (task.git !== undefined) {
            void this.enqueueCardWork(task.id, async () => {
              const failure = await this.git?.releaseWorktree(task)
              if (failure !== undefined) console.warn(`task board: could not remove the worktree of deleted task ${task.id} (${failure})`)
            })
          }
        }
        this.document.tasks = [...applyDeleteTask(this.document.tasks, undefined, action.taskId).tasks]
        break
      case 'move': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task.status === 'running' || hasOpenRun(task)) throw new Error('running task cannot be moved')
        // The state machine decides whether this move exists at all: an
        // unconfigured transition is refused here, not in the browser. The
        // browser validates its drop targets against the same machine.
        const transition = this.machine.transition(task.status, action.status, 'manual')
        if (transition === undefined) throw new Error(`invalid state transition: ${task.status} → ${action.status}`)
        // Transition actions, in their configured order: the git hooks of the
        // agentic-programming workflow (no-ops without a repository), then the
        // `run` action that opens an execution. A branch or merge hook that
        // throws fails the whole move, so a card never claims a branch or a
        // merge that did not happen — the commit hook is the exception: it
        // records its failure on the card instead, because uncommitted work must
        // not keep a card from reaching the review column. `"git": false` on the
        // transition skips the hooks.
        const actions = transition.actions ?? []
        // A move that merges the card back (the shipped machine:
        // `ready_for_test → done`) is the human's merge release and runs the
        // whole release path — merge, automatic conflict resolution, failure →
        // `failed` — so a drag onto "Done" and the card's release button can
        // never behave differently. Every other move keeps the plain git hooks.
        const merges = action.status === 'done' && transition.git !== false && actions.includes('git.mergeBranch')
        const released = merges ? this.beginRelease(task, now, initiator) : undefined
        const gitted = merges ? task : this.transitionGit(task, transition, now)
        // The target state over the transition's git hooks: the base the
        // transition's actions build on, in their configured order. A queued
        // release (`pending`) leaves the card exactly where it is; its background
        // job writes `done`/`failed` later.
        let next: TaskRecord = released?.task ?? withStatus(gitted, action.status, now)
        if (released?.run !== undefined) run = released.run
        // Leaving the review column (or a failed run) for `clarification` is a
        // rework — whether the human dragged the card or the Host noticed a
        // correction in its chat. Only the stamp is written; the correction lives
        // in the card's conversation, not in a board field.
        if (isReworkReturn(task.status, action.status)) next = withReworkStamp(next, now)
        // The clarification step: a transition carrying `clarify` opens the
        // card's clarification run — the same execution the run column starts
        // (it goes through the launch queue, but not the lane's WIP limit: the
        // card starts right away and links its session), only its prompt asks
        // first and stops. The card keeps the clarification column: the human
        // answers in the chat and pulls it straight on to the run column, and
        // the implementation continues this very session. A card that already
        // has a clarification conversation re-enters it instead, so a round trip
        // never mints a second session.
        if (actions.includes('clarify') && !hasOpenExecution(task)) {
          const opened = startExecution(next, now, crypto.randomUUID(), initiator, 'clarify')
          next = opened.task
          clarification = { task: next, execution: opened.execution }
        }
        // `run` moves the card by opening an execution (drag onto the run
        // column); everything else is a plain status change. The execution's
        // entry column is the transition target, so a configured machine may
        // park runs wherever its `run` transitions point. 
        if (actions.includes('run')) {
          if (requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
            throw new Error(`confirmation-required: the effective permission is above the session default (${this.sessionDefaultPermission}); confirm the card's permission binding first`)
          }
          // Starting the work is the go-ahead and supersedes the card's open
          // clarification round: that execution is closed here, so the card
          // never carries two open runs. A launch not started yet is dropped by
          // the pump's self-heal, so the round never mints the second session
          // either — the implementation continues the conversation the round
          // opened (or, when it never got one, starts the card's first session).
          const base: TaskRecord = this.supersedeClarification(next, now)
          const opened = startExecution(base, now, crypto.randomUUID(), initiator)
          run = { task: { ...opened.task, status: action.status }, execution: opened.execution }
          next = run.task
        }
        const moved = this.document.tasks.map(item => item.id === action.taskId ? next : item)
        // The Done-column limit: a move that would leave more than N on-board
        // cards in `done` archives the oldest ones (FIFO) until it holds again.
        // Every other column is untouched and surviving cards keep their order.
        // Archived cards give their worktrees to the poll's retry (they are the
        // only cards that no longer need a checkout). A queued release keeps the
        // card in ready_for_test and therefore does not touch the Done column.
        if (action.status === 'done' && released?.pending !== true) {
          const limited = enforceDoneLimit(moved, this.maxDoneTasks, now)
          this.document.tasks = [...limited.tasks]
          this.releaseArchivedWorktrees(limited.archivedIds)
        } else {
          this.document.tasks = moved
        }
        break
      }
      case 'move-many': {
        // Group drag: validate every card in the batch before writing any, so
        // an invalid card aborts the whole drop and the ledger is untouched
        // (the browser only submits cards whose transition it already checked;
        // this is the authority for the ones it did not).
        const batch = action.taskIds.map(id => {
          const task = this.document.tasks.find(item => item.id === id)
          if (task === undefined) throw new Error(`task not found: ${id}`)
          if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
          if (task.status === 'running' || hasOpenRun(task)) throw new Error('running task cannot be moved')
          const transition = this.machine.transition(task.status, action.status, 'manual')
          if (transition === undefined) throw new Error(`invalid state transition: ${task.status} → ${action.status}`)
          // A batch never opens executions: the runner owns the single run
          // slot and the board routes the run column through `rerun`. The
          // clarification round is an execution too, so a group drop may not
          // land on a transition that opens one — a batch-parked card would
          // otherwise sit in the clarification column without its round.
          if ((transition.actions ?? []).includes('run')) throw new Error('batch move cannot start executions')
          if ((transition.actions ?? []).includes('clarify')) throw new Error('batch move cannot start the clarification round')
          return { task, transition }
        })
        const moved = new Map<string, TaskRecord>()
        for (const { task, transition } of batch) {
          const actions = transition.actions ?? []
          const merges = action.status === 'done' && transition.git !== false && actions.includes('git.mergeBranch')
          // A group drop onto Done releases every card that carries the merge
          // hook; each release runs on its own card's work chain and writes its
          // own outcome (done/failed/conflict run), exactly like a single drop.
          if (merges) {
            moved.set(task.id, this.beginRelease(task, now, initiator).task)
            continue
          }
          const target = withStatus(this.transitionGit(task, transition, now), action.status, now)
          moved.set(task.id, isReworkReturn(task.status, action.status) ? withReworkStamp(target, now) : target)
        }
        // `map` over the ledger array keeps every untouched card in place and
        // the moved cards in their existing order among themselves; the
        // Done-column limit then trims exactly as the single-card move does.
        const next = this.document.tasks.map(item => moved.get(item.id) ?? item)
        if (action.status === 'done') {
          const limited = enforceDoneLimit(next, this.maxDoneTasks, now)
          this.document.tasks = [...limited.tasks]
          this.releaseArchivedWorktrees(limited.archivedIds)
        } else {
          this.document.tasks = next
        }
        break
      }
      case 'archive': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        const result = applyArchiveTask(this.document.tasks, action.taskId, now)
        if (!result.archived) throw new Error('task cannot be archived')
        this.document.tasks = [...result.tasks]
        // Archive is the last board state: release the card's own checkout. A
        // refusal is not fatal — the Host poll retries it.
        if (task !== undefined) this.releaseArchivedWorktrees([task.id])
        break
      }
      case 'restore': {
        const result = applyRestoreTask(this.document.tasks, action.taskId, now)
        if (!result.archived) throw new Error('task is not archived')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'confirm-permission': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.permissionConfirmedAt !== undefined) break
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId
          ? { ...item, permissionConfirmedAt: now, updatedAt: now }
          : item)
        break
      }
      case 'approve-merge': {
        // The human's release for the merge (the card's "Freigeben (Merge)"
        // button). Deliberately not a plain `move`: the release merges, may hand
        // a conflict to the card's agent, and ends in `done` or `failed`, none of
        // which the browser may decide. The state machine still owns whether this
        // card may be accepted at all (the shipped machine: `ready_for_test →
        // done`), so a custom machine can forbid it.
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task.status === 'running' || hasOpenRun(task)) throw new Error('running task cannot be moved')
        if (task.status !== 'ready_for_test') throw new Error('merge-requires-ready-for-test')
        const transition = this.machine.transition(task.status, 'done', 'manual')
        if (transition === undefined) throw new Error(`invalid state transition: ${task.status} → done`)
        const released = (transition.git === false || !(transition.actions ?? []).includes('git.mergeBranch'))
          ? { task: withStatus(task, 'done', now) }
          : this.beginRelease(task, now, initiator)
        if (released.run !== undefined) run = released.run
        const moved = this.document.tasks.map(item => item.id === task.id ? released.task : item)
        this.document.tasks = released.task.status === 'done'
          ? [...enforceDoneLimit(moved, this.maxDoneTasks, now).tasks]
          : moved
        break
      }
      case 'review-start':
      case 'review-stop':
      case 'review-restart': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        // The review controls exist in the review column only; the Host is the
        // authority for that, not the browser's rendering. A card that left the
        // column while the click was in flight is refused here.
        if (task.status !== 'ready_for_test') throw new Error('review-action-requires-ready-for-test')
        review = [{
          taskId: task.id,
          intent: action.kind === 'review-start' ? 'start' : action.kind === 'review-stop' ? 'stop' : 'restart',
        }]
        break
      }
      case 'set-schedule': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        const result = applySetSchedule(this.document.tasks, action.taskId, action.patch, now)
        if (!result.applied) throw new Error('invalid schedule')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'pause': {
        // Suspend every named card's open run without moving it: the card keeps
        // its column and its execution record, it just stops being worked on.
        // The service stops the attached sessions from the returned list. Cards
        // without an open run are skipped, so a batch is robust against a card
        // that settled in the meantime. A clarification run in `clarification`
        // is suspended like any other run.
        const ids = new Set(action.taskIds)
        const suspended: PausedRun[] = []
        this.document.tasks = this.document.tasks.map(task => {
          if (!ids.has(task.id) || task.archivedAt !== undefined) return task
          if (task.pausedAt !== undefined) return task
          const execution = openExecution(task)
          if (execution === undefined) return task
          suspended.push({ taskId: task.id, sessionId: execution.sessionId })
          return withPause(task, true, now)
        })
        if (suspended.length > 0) paused = suspended
        break
      }
      case 'resume': {
        // Release the pause and hand the run back to the service, which writes
        // the "continue" turn into the run's own conversation (or, for a run
        // that never got a session, back into the launch queue). The card never
        // changes column.
        const ids = new Set(action.taskIds)
        const released: ResumedRun[] = []
        this.document.tasks = this.document.tasks.map(task => {
          if (!ids.has(task.id) || task.pausedAt === undefined) return task
          const resumedTask = withPause(task, false, now)
          const execution = openExecution(task)
          if (execution !== undefined) released.push({ task: resumedTask, execution })
          return resumedTask
        })
        if (released.length > 0) resumed = released
        break
      }
      case 'rerun':
      case 'run': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task === undefined || task.status === 'running' || hasOpenRun(task)) throw new Error('task is already running or missing')
        if (requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
          throw new Error(`confirmation-required: the effective permission is above the session default (${this.sessionDefaultPermission}); confirm the card's permission binding first`)
        }
        // The Run button is the same go-ahead as the drag onto the run column:
        // it closes the card's open clarification round, and the run continues
        // that conversation with the implementation.
        const released: TaskRecord = this.supersedeClarification(task, now)
        // Safety net for a card started without the backlog → clarification
        // pull (the detail Run button or a cron trigger): still work on a
        // feature branch when the workspace has a repository.
        run = startExecution(this.ensureFeatureBranchLater(released), now, crypto.randomUUID(), initiator)
        this.document.tasks = this.document.tasks.map(item => item.id === task.id ? run!.task : item)
        break
      }
    }
    this.commit()
    return {
      state: this.state(),
      ...(run === undefined ? {} : { run }),
      ...(clarification === undefined ? {} : { clarification }),
      ...(paused === undefined ? {} : { paused }),
      ...(resumed === undefined ? {} : { resumed }),
      ...(review === undefined ? {} : { review }),
    }
  }

  private repairSchedules(skipPast: boolean, persist = true): void {
    const now = this.now()
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled) return task
      if (!skipPast && schedule.nextRunAt !== undefined) return task
      const next = nextRunAtMs(schedule.cron, now)
      if (next === undefined) {
        changed = true
        this.document.scheduler.error = `invalid cron disabled for task: ${task.id}`
        return { ...task, schedule: { ...schedule, enabled: false, nextRunAt: undefined }, updatedAt: now }
      }
      if (schedule.nextRunAt === next) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: next }, updatedAt: now }
    })
    if (changed && persist) this.commit()
  }

  private reconcileInterruptedStarts(persist = true): void {
    const now = this.now()
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const execution = task.executions.at(-1)
      // Same for the card's clarification run: it lives in its own column, but
      // an interrupted start of it is just as unresumable (settling it does not
      // move the card).
      if (task.status !== 'running' && execution?.kind !== 'clarify') return task
      // A paused card was suspended by the user, not interrupted by the crash:
      // its run is resumed from the board, never cancelled on startup.
      if (task.pausedAt !== undefined) return task
      if (execution === undefined || execution.endedAt !== undefined || execution.sessionId !== undefined) return task
      changed = true
      const settled = settleExecution(task, execution.id, 'cancelled', now, 'host restarted before the execution session was recorded')
      // The restart cancels an interrupted implementation run just like any
      // other cancellation, so its work is committed rather than left in the
      // worktree (queued on the card's work chain); a clarification round owns
      // nothing to commit.
      if (execution.kind !== 'clarify') this.enqueueCommit(settled.id)
      return settled
    })
    if (changed && persist) this.commit()
  }

  /**
   * Field-preserving v2 to v3 migration. The migration reuses the v3
   * normalization, but it first proves every task row is structurally valid: a
   * v2 document that would silently drop or coerce rows fails loudly instead
   * (no quarantined-empty restart). The retired `todo` column is mapped to
   * `clarification` before that check, because its role — the waiting column
   * before implementation — moved there.
   */
  private migrateLegacyDocument(parsed: ParsedLedgerDocument): LedgerDocument {
    const tasks: unknown[] | undefined = Array.isArray(parsed.tasks)
      ? parsed.tasks.map((row) => {
          if (typeof row !== 'object' || row === null) return row
          const record = row as unknown as Record<string, unknown>
          return record.status === 'todo' ? { ...record, status: 'clarification' } : row
        })
      : parsed.tasks
    if (tasks === undefined || !tasks.every((row): row is TaskRecord => isTaskRecord(row))) {
      throw new Error('v2 document contains structurally invalid task rows')
    }
    return this.normalizeDocument({ ...parsed, tasks })
  }

  private load(dir: string): LedgerDocument {
    const existed = existsSync(this.file)
    // schemaVersion stays unknown-typed here: on-disk documents may be v2
    // (legacy), v3, or any future/invalid value the branches below sort out.
    let parsed: ParsedLedgerDocument
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ParsedLedgerDocument
    } catch (error) {
      return this.recoverCorrupt(dir, existed, error)
    }
    if (parsed.schemaVersion === TASK_BOARD_LEGACY_SCHEMA_VERSION) {
      try {
        return this.migrateLegacyDocument(parsed)
      } catch (error) {
        // Migration failure is explicit: the original v2 file stays in place
        // for manual recovery and the ledger refuses to start (fail closed).
        throw new Error(`ledger v2 to v3 migration failed; original file kept at ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      if (parsed.schemaVersion !== TASK_BOARD_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) throw new Error('unsupported ledger schema')
      return this.normalizeDocument(parsed)
    } catch (error) {
      return this.recoverCorrupt(dir, existed, error)
    }
  }

  private normalizeDocument(parsed: ParsedLedgerDocument): LedgerDocument {
    const tasks = parseHostTasks(parsed.tasks as readonly unknown[]).map(task => ({ ...task, executions: retainRecentExecutions(task.executions) }))
    const invalidScheduleIds = (parsed.tasks as unknown[]).flatMap(value => {
      if (typeof value !== 'object' || value === null) return []
      const row = value as { id?: unknown; schedule?: unknown }
      if (typeof row.schedule !== 'object' || row.schedule === null) return []
      const cron = (row.schedule as { cron?: unknown }).cron
      return typeof cron !== 'string' || !isValidCron(cron)
        ? [typeof row.id === 'string' ? row.id : 'unknown']
        : []
    })
    const documentLastTickAt = typeof parsed.scheduler?.lastTickAt === 'number' ? parsed.scheduler.lastTickAt : undefined
    const sidecarLastTickAt = this.readSchedulerSidecar()
    // A sidecar write can be newer than the last full commit (crash between
    // the two); lastTickAt only ever moves forward, so take the greater.
    const lastTickAt = sidecarLastTickAt === undefined || (documentLastTickAt !== undefined && documentLastTickAt >= sidecarLastTickAt)
      ? documentLastTickAt
      : sidecarLastTickAt
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: Number.isSafeInteger(parsed.revision) && (parsed.revision as number) >= 0 ? parsed.revision as number : 0,
      tasks,
      scheduler: {
        timeZone: timeZone(),
        ledgerId: typeof parsed.scheduler?.ledgerId === 'string' && parsed.scheduler.ledgerId !== '' ? parsed.scheduler.ledgerId : crypto.randomUUID(),
        ...(lastTickAt === undefined ? {} : { lastTickAt }),
        ...(typeof parsed.scheduler?.error === 'string' ? { error: parsed.scheduler.error } : {}),
        ...(invalidScheduleIds.length > 0 ? { error: `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}` } : {}),
        ...(Array.isArray(parsed.scheduler?.importedSources) ? { importedSources: parsed.scheduler.importedSources.filter(x => typeof x === 'string') } : {}),
      },
      recentRequests: Array.isArray(parsed.recentRequests)
        ? parsed.recentRequests.flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return []
            const request = entry as { requestId?: unknown; fingerprint?: unknown }
            return typeof request.requestId === 'string' && request.requestId !== '' && typeof request.fingerprint === 'string'
              ? [{ requestId: request.requestId, fingerprint: request.fingerprint }]
              : []
          }).slice(-MAX_REQUEST_CACHE)
        : [],
    }
  }

  /** Quarantine an unreadable document and start from an empty ledger. */
  private recoverCorrupt(dir: string, existed: boolean, error: unknown): LedgerDocument {
    if (existed) renameSync(this.file, `${this.file}.corrupt-${this.now()}-${process.pid}-${crypto.randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: 0,
      tasks: [],
      scheduler: { timeZone: timeZone(), ledgerId: crypto.randomUUID(), ...(existed ? { error: `corrupt ledger was quarantined: ${error instanceof Error ? error.message : String(error)}` } : {}) },
      recentRequests: [],
    }
  }

  private syncRecentRequests(): void {
    this.document.recentRequests = [...this.requestCache].map(([requestId, request]) => ({
      requestId,
      fingerprint: request.fingerprint,
    }))
  }

  private readSchedulerSidecar(): number | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.schedulerFile, 'utf8')) as { lastTickAt?: unknown }
      return typeof parsed.lastTickAt === 'number' && Number.isFinite(parsed.lastTickAt) ? parsed.lastTickAt : undefined
    } catch {
      return undefined
    }
  }

  /** Atomic write of the scheduler heartbeat sidecar (0600, tmp + rename + fsync). */
  private writeSchedulerSidecar(): void {
    const payload = JSON.stringify({ lastTickAt: this.document.scheduler.lastTickAt })
    mkdirSync(dirname(this.schedulerFile), { recursive: true })
    const tmp = `${this.schedulerFile}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, payload, { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      renameSync(tmp, this.schedulerFile)
      try {
        const dirFd = openSync(dirname(this.schedulerFile), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(tmp) } catch { /* best-effort temporary cleanup */ }
      throw error
    }
    this.notify()
  }

  private commit(bumpRevision = true): void {
    // A background git job may finish after the Host shut down; never write
    // through a released lock.
    if (this.disposed) return
    if (bumpRevision) this.document.revision += 1
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, JSON.stringify(this.document, null, 2), { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      renameSync(tmp, this.file)
      try {
        const dirFd = openSync(dirname(this.file), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(tmp) } catch { /* best-effort temporary cleanup */ }
      throw error
    }
    this.notify()
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600)
        const startedAt = ownProcessStartTimeMs()
        // Linux /proc and Windows PowerShell probes are ms-precise; locks they
        // write are compared strictly. Other POSIX probes (ps) stay
        // second-granularity, so their records are compared with the bounded
        // legacy tolerance.
        const probe = process.platform === 'linux' || process.platform === 'win32' ? 'exact' : 'legacy'
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt, probe }), { encoding: 'utf8' })
        fsyncSync(fd)
        try { chmodSync(this.lockFile, 0o600) } catch { /* Windows ACLs own access */ }
        return fd
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        let pid: number | undefined
        let ownerStartedAt: number | undefined
        let ownerExact = false
        try {
          const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { pid?: unknown; startedAt?: unknown; probe?: unknown }
          if (typeof owner.pid === 'number') pid = owner.pid
          if (typeof owner.startedAt === 'number') ownerStartedAt = owner.startedAt
          ownerExact = owner.probe === 'exact'
        } catch {
          // A power-loss mid-write can leave an empty or truncated lock. Such a
          // lock still fails closed while it is fresh (a live owner may be
          // mid-write); once it is older than the grace window nothing can be
          // writing it, so the leftover is reclaimed instead of blocking every
          // later start until someone deletes it by hand (issue #1528).
          const age = (() => {
            try { return this.now() - statSync(this.lockFile).mtimeMs } catch { return Number.POSITIVE_INFINITY }
          })()
          if (age < UNREADABLE_LOCK_GRACE_MS) {
            throw new Error(`task-board ledger lock is unreadable: ${this.lockFile}; if this is a leftover from an unclean shutdown and no other DSH host is running, remove it manually and retry`)
          }
          try { unlinkSync(this.lockFile) } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
          }
          continue
        }
        if (pid !== undefined && processIsAlive(pid)) {
          const actualStartedAt = pid === process.pid ? ownProcessStartTimeMs() : processStartTimeMs(pid)
          // A reused PID is exposed when the live process identity no longer
          // matches the recorded one: either the recorded start time differs
          // beyond the probe's resolution (strict for ms-precise 'exact'
          // records, a bounded legacy tolerance for old second-granularity
          // records written by ps), or (legacy locks without a start time)
          // the lock file predates the live process and therefore cannot
          // have been written by it. Takeover is safe in both cases — the
          // original owner is gone.
          const staleReuse = actualStartedAt !== undefined && (
            ownerStartedAt !== undefined
              ? startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
              : (() => {
                try { return statSync(this.lockFile).mtimeMs < actualStartedAt } catch { return true }
              })()
          )
          if (!staleReuse) {
            const confirmedOwner = ownerStartedAt !== undefined && actualStartedAt !== undefined && !startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
            const hint = confirmedOwner
              ? ''
              : `; if this PID was reused after a crash and no other DSH host is running, remove ${this.lockFile} manually and retry`
            throw new Error(`task-board ledger is already owned by process ${pid}${hint}`)
          }
        }
        try { unlinkSync(this.lockFile) } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
        }
      }
    }
    throw new Error(`task-board ledger lock could not be acquired: ${this.lockFile}`)
  }
}