#!/usr/bin/env node
/**
 * External watchdog for the task-board Host (one probe per invocation).
 *
 * Run it from a systemd user timer every ~30 s (see
 * `scripts/install-task-board-watchdog.sh`). It probes the Host's loopback
 * health route and, only when the host was healthy before and has now been
 * unresponsive for the sustained window, restarts dsh through
 * `dsh-stop --restart` and leaves a notice the fresh Host shows.
 *
 * The decision rules live in `src/core/watchdog.ts` (pure, unit-tested); this
 * file is the I/O shell: probe, read/write state, log, restart.
 *
 * Usage:
 *   node lib/watchdog.js [--home <dir>] [--port <n>] [--dry-run] [--verbose]
 *
 * Flags:
 *   --home <dir>               DSH home (default $DSH_HOME or ~/.dsh)
 *   --port <n>                 dsh loopback port (default $DSH_LOOPBACK_PORT or 3080)
 *   --probe-timeout-ms <n>     one probe's timeout (default 10000)
 *   --unhealthy-limit <n>      consecutive hangs before a restart (default 4)
 *   --cooldown-ms <n>          minimum gap between restarts (default 600000)
 *   --max-restarts-per-hour <n> hourly cap (default 3)
 *   --restart-command <path>   restart script, called with `--restart`
 *                              (default ~/.local/bin/dsh-stop)
 *   --state-file <path>        default <home>/task-board/watchdog-state.json
 *   --log <path>               default <home>/logs/task-board-watchdog.log
 *   --dry-run                  decide and log, never restart
 *   --verbose                  log every probe, not only changes
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { decideWatchdog, initialWatchdogState, type ProbeOutcome, type WatchdogState } from './core/watchdog.ts'

const LOG_LIMIT_BYTES = 1024 * 1024

interface Options {
  home: string
  port: number
  probeTimeoutMs: number
  unhealthyLimit: number
  cooldownMs: number
  maxRestartsPerHour: number
  restartCommand: string
  stateFile: string
  logFile: string
  dryRun: boolean
  verbose: boolean
}

function usage(): string {
  return 'usage: node lib/watchdog.js [--home <dir>] [--port <n>] [--probe-timeout-ms <n>] '
    + '[--unhealthy-limit <n>] [--cooldown-ms <n>] [--max-restarts-per-hour <n>] '
    + '[--restart-command <path>] [--state-file <path>] [--log <path>] [--dry-run] [--verbose]'
}

/** Integer flag with a validated fallback (a typo must not silently change policy). */
function intFlag(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback
}

function parseArgs(argv: readonly string[]): Options | string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const options: Options = {
    home,
    port: intFlag(process.env.DSH_LOOPBACK_PORT, 3080, 1),
    probeTimeoutMs: 10_000,
    unhealthyLimit: 4,
    cooldownMs: 10 * 60_000,
    maxRestartsPerHour: 3,
    restartCommand: join(homedir(), '.local', 'bin', 'dsh-stop'),
    stateFile: join(home, 'task-board', 'watchdog-state.json'),
    logFile: join(home, 'logs', 'task-board-watchdog.log'),
    dryRun: false,
    verbose: false,
  }
  let stateFileExplicit = false
  let logFileExplicit = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = (): string | undefined => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) return undefined
      index += 1
      return next
    }
    switch (arg) {
      case '--help':
      case '-h':
        return 'help'
      case '--home': { const next = value(); if (next === undefined) return usage(); options.home = next; break }
      case '--port': options.port = intFlag(value(), options.port, 1); break
      case '--probe-timeout-ms': options.probeTimeoutMs = intFlag(value(), options.probeTimeoutMs, 100); break
      case '--unhealthy-limit': options.unhealthyLimit = intFlag(value(), options.unhealthyLimit, 2); break
      case '--cooldown-ms': options.cooldownMs = intFlag(value(), options.cooldownMs, 0); break
      case '--max-restarts-per-hour': options.maxRestartsPerHour = intFlag(value(), options.maxRestartsPerHour, 0); break
      case '--restart-command': { const next = value(); if (next === undefined) return usage(); options.restartCommand = next; break }
      case '--state-file': { const next = value(); if (next === undefined) return usage(); options.stateFile = next; stateFileExplicit = true; break }
      case '--log': { const next = value(); if (next === undefined) return usage(); options.logFile = next; logFileExplicit = true; break }
      case '--dry-run': options.dryRun = true; break
      case '--verbose': options.verbose = true; break
      default:
        return usage()
    }
  }
  // `--home` may come after the defaults were built: derive the per-home paths
  // once more, unless the caller named them explicitly.
  if (!stateFileExplicit) options.stateFile = join(options.home, 'task-board', 'watchdog-state.json')
  if (!logFileExplicit) options.logFile = join(options.home, 'logs', 'task-board-watchdog.log')
  return options
}

function log(options: Options, line: string): void {
  const text = `${new Date().toISOString()} ${line}\n`
  try {
    mkdirSync(dirname(options.logFile), { recursive: true })
    // Bounded log: the timer runs forever, so rotate instead of growing.
    if (existsSync(options.logFile) && statSync(options.logFile).size > LOG_LIMIT_BYTES) writeFileSync(options.logFile, '')
    appendFileSync(options.logFile, text)
  } catch {
    // A watchdog that cannot write its log must still probe/restart.
  }
}

function readState(path: string): WatchdogState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<WatchdogState>
    return {
      unhealthyStreak: typeof raw.unhealthyStreak === 'number' && Number.isFinite(raw.unhealthyStreak) ? Math.max(0, raw.unhealthyStreak) : 0,
      restarts: Array.isArray(raw.restarts) ? raw.restarts.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)) : [],
      armed: raw.armed === true,
      ...(typeof raw.lastHealthyAt === 'number' ? { lastHealthyAt: raw.lastHealthyAt } : {}),
      ...(typeof raw.lastRestartAt === 'number' ? { lastRestartAt: raw.lastRestartAt } : {}),
    }
  } catch {
    return initialWatchdogState()
  }
}

function writeState(path: string, state: WatchdogState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(tmp, path)
  } catch {
    // Losing the state only costs a restart window, never correctness.
  }
}

/**
 * Probe `GET /api/task-board/health` once.
 *
 * The classification is the whole safety story: a closed port (`refused`) or a
 * missing route (`missing`) must never trigger a restart, only a hang does.
 */
function probe(port: number, timeoutMs: number): Promise<{ outcome: ProbeOutcome; detail: string }> {
  return new Promise(resolve => {
    let settled = false
    const finish = (outcome: ProbeOutcome, detail: string): void => {
      if (settled) return
      settled = true
      resolve({ outcome, detail })
    }
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/api/task-board/health',
      method: 'GET',
      timeout: timeoutMs,
      // dsh's outer layer treats `/api/*` without a same-origin marker as a
      // foreign API call and answers 401/403 before the plugin route runs.
      // The watchdog is a local process, so it carries the same browser marker
      // the board sends — without it a healthy host would look foreign.
      headers: {
        accept: 'application/json',
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
      },
    }, res => {
      const status = res.statusCode ?? 0
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { if (body.length < 16_384) body += chunk })
      res.on('end', () => {
        if (status === 200) {
          try {
            const parsed = JSON.parse(body) as { pressure?: { level?: unknown }; runs?: { queued?: unknown } }
            const level = typeof parsed.pressure?.level === 'string' ? parsed.pressure.level : 'unknown'
            finish('healthy', `level=${level}`)
          } catch {
            finish('foreign', 'status=200 but not the task-board health JSON')
          }
          return
        }
        if (status === 404) return finish('missing', 'status=404 (route not mounted)')
        if (status >= 500) return finish('unhealthy', `status=${status}`)
        // dsh masks unknown /api paths as 401, and an auth fence looks the same:
        // the host is alive, so this is never a restart reason — but the log
        // must name it, or an old build silently disables the watchdog.
        if (status === 401 || status === 403) {
          return finish('foreign', `status=${status} (health route absent or an auth fence answered)`)
        }
        finish('foreign', `status=${status}`)
      })
      res.on('error', () => finish('unhealthy', 'response stream failed'))
    })
    req.on('timeout', () => {
      req.destroy()
      finish('unhealthy', `no answer within ${timeoutMs} ms`)
    })
    req.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'EADDRNOTAVAIL') {
        finish('refused', `connection refused (${code})`)
        return
      }
      finish('unhealthy', error instanceof Error ? error.message : String(error))
    })
    req.end()
  })
}

/** Write the notice the fresh Host shows, then ask dsh-stop to restart it. */
function restart(options: Options, reason: string): boolean {
  const noticeFile = join(options.home, 'task-board', 'watchdog-notice.json')
  try {
    mkdirSync(dirname(noticeFile), { recursive: true })
    writeFileSync(noticeFile, `${JSON.stringify({ at: Date.now(), reason }, null, 2)}\n`)
  } catch {
    // The restart matters more than the notice.
  }
  try {
    const child = spawn(options.restartCommand, ['--restart'], { detached: true, stdio: 'ignore', env: process.env })
    child.unref()
    child.on('error', () => { /* logged below via the return value */ })
    return true
  } catch {
    return false
  }
}

/** Best-effort desktop notification (the GUI may be gone). */
function notify(message: string): void {
  try {
    const child = spawn('notify-send', ['DeepSeek Harness', message], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // No notification daemon: the log and the board notice remain.
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n`)
    return 2
  }
  const options = parsed
  const now = Date.now()
  const { outcome, detail } = await probe(options.port, options.probeTimeoutMs)
  const state = readState(options.stateFile)
  const decision = decideWatchdog(outcome, state, {
    unhealthyLimit: options.unhealthyLimit,
    cooldownMs: options.cooldownMs,
    maxRestartsPerHour: options.maxRestartsPerHour,
    now,
  })
  const changed = decision.state.unhealthyStreak !== state.unhealthyStreak
    || decision.state.armed !== state.armed
    || decision.action !== 'idle'
  if (options.verbose || changed || outcome !== 'healthy') {
    log(options, `probe=${outcome} (${detail}) streak=${decision.state.unhealthyStreak} armed=${decision.state.armed} decision=${decision.action} reason="${decision.reason}"`)
  }
  writeState(options.stateFile, decision.state)
  if (decision.action !== 'restart') return 0
  if (options.dryRun) {
    log(options, 'dry-run: would restart dsh now')
    return 0
  }
  const started = restart(options, decision.reason)
  log(options, started
    ? `restart requested: ${options.restartCommand} --restart (${decision.reason})`
    : `restart could not be spawned: ${options.restartCommand} (${decision.reason})`)
  if (started) notify('Der Task-Board-Host antwortet nicht mehr — dsh wird automatisch neu gestartet.')
  return 0
}

main().then(code => process.exit(code)).catch(error => {
  process.stderr.write(`watchdog failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
