import type { TaskRecord } from '../core/tasks.ts'
import { t } from './locales.ts'
import {
  isTaskParseDraft,
  TASK_BOARD_API_PREFIX,
  type TaskBoardAction,
  type TaskBoardActionEnvelope,
  type TaskBoardEventFrame,
  type TaskBoardEventPayload,
  type TaskBoardParseDraft,
  type TaskBoardParseRequest,
  type TaskBoardReviewRequest,
  type TaskBoardReviewResponse,
  type TaskBoardSnapshot,
} from '../protocol.ts'

/**
 * How long one action POST may stay unanswered before the outbox treats it as a
 * stalled request (a queued browser connection, a frozen Host) and retries it
 * with the same requestId. Not a user-visible deadline: the action stays in the
 * outbox, the banner explains it, and the first successful answer wins.
 */
export const ACTION_REQUEST_TIMEOUT_MS = 20_000
const IMPORT_MARKER = 'dsh.taskBoard.v2.hostImported'
const SOURCE_KEY = 'dsh.taskBoard.v2.sourceId'
const IMPORT_REQUEST_KEY = 'dsh.taskBoard.v2.importRequestId'
/** Re-notify the panel at most this often while the event stream stays broken. */
const STREAM_ERROR_NOTIFY_MS = 15_000
/** Mirrors the Host's own parse budget; only used to phrase the timeout. */
const TASK_PARSE_TIMEOUT_SECONDS = 45

/**
 * Failure classes of the Host API, in the language the panel renders
 * (issue #1528). The Host is the only part that knows whether a task-board
 * route exists at all, so a raw fetch/parse error must never reach the user:
 * "Unexpected token 'o', \"not found\" is not valid JSON" is what a missing
 * Host half looks like today.
 */
export type HostApiFailure = 'not-mounted' | 'unauthorized' | 'locked' | 'rejected' | 'busy' | 'timeout' | 'unreachable' | 'unexpected'

/** Transport failure carrying a stable class next to its user-facing message. */
export class HostApiError extends Error {
  constructor(readonly failure: HostApiFailure, message: string, readonly status?: number) {
    super(message)
    this.name = 'HostApiError'
  }
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Read one Host response without ever handing a non-JSON body to JSON.parse:
 * the core webserver answers an unmounted `/api/*` path with the plain text
 * "not found", which used to surface as a JavaScript parse error in the panel.
 */
async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: unknown
  let readable = false
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text)
      readable = true
    } catch {
      readable = false
    }
  }
  const hostError = readable && typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
    ? (parsed as { error: string }).error
    : undefined
  if (response.ok) {
    if (!readable) throw new HostApiError('unexpected', t('board.hostError.unexpected', { status: String(response.status) }), response.status)
    return parsed as T
  }
  if (hostError !== undefined) {
    // The Host answered with a reason of its own. A ledger lock is the one
    // class worth naming in the panel's words; the authentication fence and
    // every other action rejection are reported as they arrive.
    if (hostError === 'forbidden') throw new HostApiError('unauthorized', t('board.hostError.unauthorized'), response.status)
    if (response.status === 503 || /lock/i.test(hostError)) {
      throw new HostApiError('locked', t('board.hostError.locked', { detail: hostError }), response.status)
    }
    throw new HostApiError('rejected', hostError, response.status)
  }
  if (response.status === 404) throw new HostApiError('not-mounted', t('board.hostError.notMounted'), 404)
  if (response.status === 401 || response.status === 403) throw new HostApiError('unauthorized', t('board.hostError.unauthorized'), response.status)
  throw new HostApiError('unexpected', t('board.hostError.unexpected', { status: String(response.status) }), response.status)
}

export interface TaskBoardHostTransport {
  bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>
  state(): Promise<TaskBoardSnapshot>
  /**
   * Submit one action. The Host answers `202 accepted` immediately; the outcome
   * arrives as an `action-result` event (the controller resolves its outbox from
   * it). The requestId is the idempotency key: a resend after a connection loss
   * gets the same outcome instead of applying the action twice.
   */
  action(action: TaskBoardAction, initiator?: string, requestId?: string): Promise<{ requestId: string }>
  subscribe(listener: (frame?: TaskBoardEventFrame) => void): () => void
  /** One-shot model parse of pasted text (issue #1540). */
  parseDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft>
  /** One review read: open the worktree, snapshot logs, diff the reviewed commit. */
  reviewOp(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse>
}

export class HttpTaskBoardHostTransport implements TaskBoardHostTransport {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {}

  async bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot> {
    const initial = await this.state()
    const ledgerId = initial.scheduler.ledgerId
    if (legacy.length > 0 && ledgerId !== undefined && this.storage?.getItem(IMPORT_MARKER) !== ledgerId) {
      let sourceId = this.storage?.getItem(SOURCE_KEY)
      if (sourceId === null || sourceId === undefined || sourceId === '') {
        sourceId = uuid()
        this.storage?.setItem(SOURCE_KEY, sourceId)
      }
      let requestId = this.storage?.getItem(IMPORT_REQUEST_KEY)
      if (requestId === null || requestId === undefined || requestId === '') {
        requestId = uuid()
        this.storage?.setItem(IMPORT_REQUEST_KEY, requestId)
      }
      await this.post(requestId, { kind: 'import', sourceId, tasks: [...legacy] })
      // Accepted is not applied: the import runs on the Host's action lane, so
      // the marker may only be written once the cards are really in the ledger.
      // The requestId is persisted, which makes the retry idempotent.
      const ids = new Set(legacy.map(task => task.id))
      const deadline = Date.now() + 3_000
      let snapshot = await this.state()
      while (Date.now() < deadline && !snapshot.tasks.some(task => ids.has(task.id))) {
        await new Promise(resolve => setTimeout(resolve, 100))
        snapshot = await this.state()
      }
      if (snapshot.tasks.some(task => ids.has(task.id))) {
        this.storage?.setItem(IMPORT_MARKER, snapshot.scheduler.ledgerId ?? ledgerId)
      }
      return snapshot
    }
    return initial
  }

  async state(): Promise<TaskBoardSnapshot> {
    return await this.request<TaskBoardSnapshot>(`${TASK_BOARD_API_PREFIX}/state`, { cache: 'no-store' })
  }

  async action(action: TaskBoardAction, initiator?: string, requestId?: string): Promise<{ requestId: string }> {
    return await this.post(requestId ?? uuid(), action, initiator)
  }

  private async post(requestId: string, action: TaskBoardAction, initiator?: string): Promise<{ requestId: string }> {
    const envelope: TaskBoardActionEnvelope = { requestId, action, ...(initiator === undefined || initiator === '' ? {} : { initiator }) }
    return await this.request<{ requestId: string }>(`${TASK_BOARD_API_PREFIX}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    }, ACTION_REQUEST_TIMEOUT_MS)
  }

  /**
   * One Host read. There is deliberately **no timeout**: a slow Host is not a
   * user-visible failure. The action outbox in the controller retries a broken
   * connection with the same requestId, and the board stays usable throughout.
   */
  private async request<T>(url: string, init: RequestInit, timeoutMs?: number): Promise<T> {
    const stall = timeoutMs === undefined ? undefined : new AbortController()
    const timer = stall === undefined ? undefined : setTimeout(() => { stall.abort() }, timeoutMs)
    try {
      return await readJson<T>(await fetch(url, stall === undefined ? init : { ...init, signal: stall.signal }))
    } catch (error) {
      if (error instanceof HostApiError) throw error
      // A request the browser never got an answer for (a queued connection, a
      // frozen Host) is a retryable stall, not an unreachable server.
      if (stall?.signal.aborted === true && timeoutMs !== undefined) {
        throw new HostApiError('timeout', t('board.hostError.timeout', { seconds: String(Math.round(timeoutMs / 1_000)) }))
      }
      // fetch itself failed (server stopped, connection reset, DNS): the panel
      // says so in its own words instead of leaking "Failed to fetch".
      throw new HostApiError('unreachable', t('board.hostError.unreachable'))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Ask the Host to turn pasted text into task fields. The route answers a
   * typed failure (no model, timeout, unparseable reply) already phrased for
   * the form, so the UI never renders a raw status code (issue #1540).
   */
  async parseDraft(request: TaskBoardParseRequest, signal?: AbortSignal): Promise<TaskBoardParseDraft> {
    let response: Response
    try {
      response = await fetch(`${TASK_BOARD_API_PREFIX}/parse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      // A cancelled parse and a stopped Host look the same to fetch; the form
      // checks its own abort flag before showing anything.
      throw new HostApiError('unreachable', t('board.hostError.unreachable'))
    }
    const text = await response.text()
    let parsed: unknown
    let readable = false
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text)
        readable = true
      } catch {
        readable = false
      }
    }
    const record = readable && typeof parsed === 'object' && parsed !== null
      ? parsed as { code?: unknown; error?: unknown; draft?: unknown }
      : undefined
    if (response.ok) {
      if (record !== undefined && isTaskParseDraft(record.draft)) return record.draft
      throw new HostApiError('unexpected', t('new.aiParseFailed', { error: t('board.hostError.unexpected', { status: String(response.status) }) }), response.status)
    }
    if (response.status === 404) throw new HostApiError('not-mounted', t('new.aiParseUnavailable'), 404)
    if (response.status === 401 || response.status === 403) throw new HostApiError('unauthorized', t('board.hostError.unauthorized'), response.status)
    const code = typeof record?.code === 'string' ? record.code : undefined
    if (code === 'no-model') throw new HostApiError('rejected', t('new.aiParseNoModel'), response.status)
    // Overload is a fast, retryable refusal: the Host does not hold the request
    // open on a saturated machine. The form keeps its text, so the same button
    // is the retry.
    if (code === 'overloaded') {
      const retryAfterMs = typeof (record as { retryAfterMs?: unknown }).retryAfterMs === 'number'
        ? Math.max(1, Math.round((record as { retryAfterMs: number }).retryAfterMs / 1_000))
        : 5
      throw new HostApiError('busy', t('new.aiParseOverloaded', { seconds: String(retryAfterMs) }), response.status)
    }
    if (code === 'timeout') throw new HostApiError('timeout', t('new.aiParseTimeout', { seconds: String(TASK_PARSE_TIMEOUT_SECONDS) }), response.status)
    const detail = typeof record?.error === 'string' && record.error !== '' ? record.error : String(response.status)
    throw new HostApiError('rejected', t('new.aiParseFailed', { error: detail }), response.status)
  }

  /**
   * One review read. The Host answers every one of them with `{ ok, text?,
   * error? }` — including its own refusals — so a failed read stays a sentence
   * in the panel instead of a transport error. Only a Host that never mounted
   * the route (404) and an authentication refusal are reported as such, because
   * those are not about the card.
   */
  async reviewOp(request: TaskBoardReviewRequest): Promise<TaskBoardReviewResponse> {
    let response: Response
    try {
      response = await fetch(`${TASK_BOARD_API_PREFIX}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
    } catch {
      throw new HostApiError('unreachable', t('board.hostError.unreachable'))
    }
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.trim() === '' ? undefined : JSON.parse(text) as unknown
    } catch {
      parsed = undefined
    }
    const record = typeof parsed === 'object' && parsed !== null ? parsed as Partial<TaskBoardReviewResponse> : undefined
    if (response.ok) {
      if (record === undefined || typeof record.ok !== 'boolean') {
        throw new HostApiError('unexpected', t('board.hostError.unexpected', { status: String(response.status) }), response.status)
      }
      return {
        ok: record.ok,
        ...(typeof record.text === 'string' ? { text: record.text } : {}),
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
      }
    }
    if (response.status === 404) throw new HostApiError('not-mounted', t('review.unavailable'), 404)
    if (response.status === 401 || response.status === 403) throw new HostApiError('unauthorized', t('board.hostError.unauthorized'), response.status)
    throw new HostApiError('rejected', typeof record?.error === 'string' && record.error !== '' ? record.error : String(response.status), response.status)
  }

  subscribe(listener: (frame?: TaskBoardEventFrame) => void): () => void {
    let events: EventSource | undefined
    let disposed = false
    let lastStreamErrorNotify = 0
    const open = (): void => {
      if (disposed || events !== undefined) return
      events = this.openStream(listener, () => lastStreamErrorNotify, (value) => { lastStreamErrorNotify = value })
    }
    const close = (): void => {
      events?.close()
      events = undefined
    }
    // A browser tab that is not visible has no reason to hold an event stream:
    // closing it frees one of the few per-origin connections, which is what a
    // background board used to cost (and what could leave a foreground request
    // queued behind them). Reopening delivers a fresh snapshot, so nothing is
    // missed.
    const onVisibility = (): void => {
      if (disposed) return
      if (typeof document !== 'undefined' && (document as { hidden?: boolean }).hidden === true) close()
      else open()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
      if ((document as { hidden?: boolean }).hidden !== true) open()
    } else {
      open()
    }
    return () => {
      disposed = true
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      close()
    }
  }

  /** One event stream; separated so a hidden tab can drop and reopen it. */
  private openStream(
    listener: (frame?: TaskBoardEventFrame) => void,
    lastNotify: () => number,
    setLastNotify: (value: number) => void,
  ): EventSource {
    const events = new EventSource(`${TASK_BOARD_API_PREFIX}/events`)
    events.onmessage = (message: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(message.data) as TaskBoardEventFrame
        if (parsed === null || typeof parsed !== 'object') throw new Error('invalid event frame')
        // The stream opens with a full snapshot, then carries deltas.
        if (parsed.type === 'snapshot') {
          if (parsed.snapshot === null || typeof parsed.snapshot !== 'object') throw new Error('invalid snapshot frame')
          listener(parsed)
          return
        }
        if (parsed.type !== 'delta' || parsed.payload === null || typeof parsed.payload !== 'object' || typeof parsed.payload.revision !== 'number') {
          throw new Error('invalid delta frame')
        }
        listener(parsed)
      } catch {
        listener()
      }
    }
    // A stream that cannot connect at all (unmounted route, refused socket) is
    // how a Host half that never mounted looks from the browser; nudge the
    // panel into one state read so the failure becomes visible (#1528).
    events.onerror = (): void => {
      const now = Date.now()
      if (now - lastNotify() < STREAM_ERROR_NOTIFY_MS) return
      setLastNotify(now)
      listener()
    }
    return events
  }
}
