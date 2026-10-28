/**
 * Host pressure: how overloaded the machine running dsh is right now.
 *
 * The board learned this the hard way: three concurrent sessions plus the
 * browser left the process and the page without CPU, and the symptoms looked
 * like product bugs — a form that never started, a counter frozen at 0 s, a
 * bulk pause that "did nothing". The Host therefore measures two honest
 * signals that do not depend on any single plugin:
 *
 * - `load1 / cores` (run-queue pressure of the whole machine), and
 * - the event-loop delay p95 (how late the Host's own timers run).
 *
 * Levels are *sustained*: one busy sample is noise, a minute of it is
 * overload. The thresholds are deliberately generous — the board must keep
 * working on a normally busy machine and only hold new runs when the machine
 * is clearly oversubscribed.
 */

/** How often the Host samples the event loop (the health route reads the last sample). */
export const PRESSURE_SAMPLE_MS = 10_000
/** Sustained window that turns a busy sample into the `busy` level. */
export const PRESSURE_BUSY_WINDOW_MS = 15_000
/** Sustained window that turns a busy sample into the `overloaded` level. */
export const PRESSURE_OVERLOADED_WINDOW_MS = 30_000
/** `load1 / cores` at or above this is `busy`. */
export const PRESSURE_BUSY_LOAD_RATIO = 1
/** `load1 / cores` at or above this is `overloaded`. */
export const PRESSURE_OVERLOADED_LOAD_RATIO = 2
/** Event-loop p95 at or above this is `busy`. */
export const PRESSURE_BUSY_LOOP_P95_MS = 150
/** Event-loop p95 at or above this is `overloaded`. */
export const PRESSURE_OVERLOADED_LOOP_P95_MS = 400
/**
 * How long the Host may hold *new* runs back on an overloaded machine before
 * it starts them anyway (with a notice). A permanently busy machine must not
 * turn the board's queue into a dead end.
 */
export const PRESSURE_MAX_HOLD_MS = 10 * 60_000
/** Samples older than the longest window are irrelevant. */
const HISTORY_MS = 5 * 60_000
/** Minimum samples inside a window before its verdict counts (1 sample is noise). */
const MIN_SAMPLES = 2

export type PressureLevel = 'ok' | 'busy' | 'overloaded'

/** One measurement of the machine the Host runs on. */
export interface PressureSample {
  /** Wall clock of the sample. */
  at: number
  /** 1-minute load average (`os.loadavg()[0]`). */
  load1: number
  /** Logical CPU count (`os.cpus().length`), at least 1. */
  cores: number
  /** Event-loop delay p95 over the sample interval, in milliseconds. */
  loopP95Ms: number
}

/** The verdict the Host publishes, carries on the wire, and gates launches on. */
export interface PressureSnapshot {
  level: PressureLevel
  load1: number
  cores: number
  /** `load1 / cores`, rounded to two decimals (0 when no sample exists yet). */
  loadRatio: number
  loopP95Ms: number
  /** When the current level was first observed (absent for `ok` without a hold). */
  since?: number
}

/** The last sample's values, or a neutral zero reading before the first sample. */
function neutral(now: number): PressureSample {
  return { at: now, load1: 0, cores: 1, loopP95Ms: 0 }
}

function loadRatioOf(sample: PressureSample): number {
  const cores = Math.max(1, sample.cores)
  return Math.round((sample.load1 / cores) * 100) / 100
}

function busySample(sample: PressureSample): boolean {
  return loadRatioOf(sample) >= PRESSURE_BUSY_LOAD_RATIO || sample.loopP95Ms >= PRESSURE_BUSY_LOOP_P95_MS
}

function overloadedSample(sample: PressureSample): boolean {
  return loadRatioOf(sample) >= PRESSURE_OVERLOADED_LOAD_RATIO || sample.loopP95Ms >= PRESSURE_OVERLOADED_LOOP_P95_MS
}

/** Samples inside `windowMs`, oldest first (the last one is the newest). */
function windowOf(samples: readonly PressureSample[], now: number, windowMs: number): PressureSample[] {
  return samples.filter(sample => now - sample.at <= windowMs)
}

/**
 * The sustained condition: every sample inside the window must satisfy the
 * predicate, and there must be at least two of them. This is what keeps the
 * level from flapping on a single hiccup (a GC pause, one build step).
 */
function sustained(
  samples: readonly PressureSample[],
  now: number,
  windowMs: number,
  predicate: (sample: PressureSample) => boolean,
): PressureSample | undefined {
  const window = windowOf(samples, now, windowMs)
  if (window.length < MIN_SAMPLES) return undefined
  return window.every(predicate) ? window[0] : undefined
}

/**
 * Evaluate the samples. Pure, so the thresholds are testable without a live
 * event loop.
 * @param samples - measurements in any order; only the last five minutes count.
 * @param now - the evaluation time (the level's `since` is anchored on it).
 */
export function evaluatePressure(samples: readonly PressureSample[], now: number): PressureSnapshot {
  const newest = samples.length === 0 ? neutral(now) : samples[samples.length - 1]!
  const overload = sustained(samples, now, PRESSURE_OVERLOADED_WINDOW_MS, overloadedSample)
  const busy = sustained(samples, now, PRESSURE_BUSY_WINDOW_MS, busySample)
  const level: PressureLevel = overload !== undefined ? 'overloaded' : busy !== undefined ? 'busy' : 'ok'
  const since = overload?.at ?? busy?.at
  return {
    level,
    load1: newest.load1,
    cores: Math.max(1, newest.cores),
    loadRatio: loadRatioOf(newest),
    loopP95Ms: Math.round(newest.loopP95Ms),
    ...(since === undefined ? {} : { since }),
  }
}

/**
 * The Host's sample buffer. The entry pushes one sample per interval (the
 * service computes the event-loop percentile and resets its histogram), every
 * reader gets the sustained verdict on demand.
 */
export class PressureMonitor {
  private readonly samples: PressureSample[] = []
  private readonly now: () => number
  private readonly load1: () => number
  private readonly cores: () => number

  constructor(options: { now?: () => number; load1?: () => number; cores?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.load1 = options.load1 ?? (() => 0)
    this.cores = options.cores ?? (() => 1)
  }

  /**
   * Record one measurement.
   * @param loopP95Ms - event-loop delay p95 since the previous sample.
   * @returns the verdict after the sample.
   */
  sample(loopP95Ms: number): PressureSnapshot {
    const now = this.now()
    this.samples.push({ at: now, load1: this.load1(), cores: this.cores(), loopP95Ms })
    // Keep a bounded history: the evaluation only looks at the last five
    // minutes, and a long-running Host must not grow an array forever.
    while (this.samples.length > 0 && now - this.samples[0]!.at > HISTORY_MS) this.samples.shift()
    return this.snapshot()
  }

  /** The current verdict (no new sample). */
  snapshot(): PressureSnapshot {
    return evaluatePressure(this.samples, this.now())
  }

  /** Whether new runs should be held back right now. */
  isOverloaded(): boolean {
    return this.snapshot().level === 'overloaded'
  }
}
