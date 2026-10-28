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
export declare const PRESSURE_SAMPLE_MS = 10000;
/** Sustained window that turns a busy sample into the `busy` level. */
export declare const PRESSURE_BUSY_WINDOW_MS = 15000;
/** Sustained window that turns a busy sample into the `overloaded` level. */
export declare const PRESSURE_OVERLOADED_WINDOW_MS = 30000;
/** `load1 / cores` at or above this is `busy`. */
export declare const PRESSURE_BUSY_LOAD_RATIO = 1;
/** `load1 / cores` at or above this is `overloaded`. */
export declare const PRESSURE_OVERLOADED_LOAD_RATIO = 2;
/** Event-loop p95 at or above this is `busy`. */
export declare const PRESSURE_BUSY_LOOP_P95_MS = 150;
/** Event-loop p95 at or above this is `overloaded`. */
export declare const PRESSURE_OVERLOADED_LOOP_P95_MS = 400;
/**
 * How long the Host may hold *new* runs back on an overloaded machine before
 * it starts them anyway (with a notice). A permanently busy machine must not
 * turn the board's queue into a dead end.
 */
export declare const PRESSURE_MAX_HOLD_MS: number;
export type PressureLevel = 'ok' | 'busy' | 'overloaded';
/** One measurement of the machine the Host runs on. */
export interface PressureSample {
    /** Wall clock of the sample. */
    at: number;
    /** 1-minute load average (`os.loadavg()[0]`). */
    load1: number;
    /** Logical CPU count (`os.cpus().length`), at least 1. */
    cores: number;
    /** Event-loop delay p95 over the sample interval, in milliseconds. */
    loopP95Ms: number;
}
/** The verdict the Host publishes, carries on the wire, and gates launches on. */
export interface PressureSnapshot {
    level: PressureLevel;
    load1: number;
    cores: number;
    /** `load1 / cores`, rounded to two decimals (0 when no sample exists yet). */
    loadRatio: number;
    loopP95Ms: number;
    /** When the current level was first observed (absent for `ok` without a hold). */
    since?: number;
}
/**
 * Evaluate the samples. Pure, so the thresholds are testable without a live
 * event loop.
 * @param samples - measurements in any order; only the last five minutes count.
 * @param now - the evaluation time (the level's `since` is anchored on it).
 */
export declare function evaluatePressure(samples: readonly PressureSample[], now: number): PressureSnapshot;
/**
 * The Host's sample buffer. The entry pushes one sample per interval (the
 * service computes the event-loop percentile and resets its histogram), every
 * reader gets the sustained verdict on demand.
 */
export declare class PressureMonitor {
    private readonly samples;
    private readonly now;
    private readonly load1;
    private readonly cores;
    constructor(options?: {
        now?: () => number;
        load1?: () => number;
        cores?: () => number;
    });
    /**
     * Record one measurement.
     * @param loopP95Ms - event-loop delay p95 since the previous sample.
     * @returns the verdict after the sample.
     */
    sample(loopP95Ms: number): PressureSnapshot;
    /** The current verdict (no new sample). */
    snapshot(): PressureSnapshot;
    /** Whether new runs should be held back right now. */
    isOverloaded(): boolean;
}
