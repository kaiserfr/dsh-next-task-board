/**
 * Machine-pressure verdicts: the board holds new runs only on a *sustained*
 * overload, never on a single busy sample. These tests pin the thresholds and
 * the "since" anchor, because both are what a human sees on the card.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluatePressure,
  PressureMonitor,
  PRESSURE_OVERLOADED_LOAD_RATIO,
  PRESSURE_OVERLOADED_LOOP_P95_MS,
  type PressureSample,
} from '../src/core/pressure.ts'

const CORES = 4

function sample(at: number, load1: number, loopP95Ms = 5): PressureSample {
  return { at, load1, cores: CORES, loopP95Ms }
}

describe('evaluatePressure', () => {
  it('reads ok before the first sample', () => {
    const verdict = evaluatePressure([], 1_000)
    expect(verdict).toMatchObject({ level: 'ok', load1: 0, cores: 1, loadRatio: 0, loopP95Ms: 0 })
    expect(verdict.since).toBeUndefined()
  })

  it('ignores one isolated busy sample', () => {
    const verdict = evaluatePressure([sample(0, 40)], 1_000)
    expect(verdict.level).toBe('ok')
  })

  it('reports busy once the load ratio stays at or above one per core', () => {
    const verdict = evaluatePressure([sample(0, CORES), sample(10_000, CORES)], 15_000)
    expect(verdict.level).toBe('busy')
    expect(verdict.since).toBe(0)
  })

  it('reports overloaded for a sustained load of twice the cores', () => {
    const verdict = evaluatePressure(
      [sample(0, CORES * PRESSURE_OVERLOADED_LOAD_RATIO), sample(10_000, CORES * PRESSURE_OVERLOADED_LOAD_RATIO), sample(20_000, CORES * PRESSURE_OVERLOADED_LOAD_RATIO)],
      25_000,
    )
    expect(verdict.level).toBe('overloaded')
    expect(verdict.loadRatio).toBe(PRESSURE_OVERLOADED_LOAD_RATIO)
    expect(verdict.since).toBe(0)
  })

  it('reports overloaded for a sustained event-loop delay even when the load is low', () => {
    const verdict = evaluatePressure(
      [sample(0, 0.2, PRESSURE_OVERLOADED_LOOP_P95_MS), sample(10_000, 0.2, PRESSURE_OVERLOADED_LOOP_P95_MS)],
      20_000,
    )
    expect(verdict.level).toBe('overloaded')
    expect(verdict.loopP95Ms).toBe(PRESSURE_OVERLOADED_LOOP_P95_MS)
  })

  it('drops back as soon as one sample inside the window is calm', () => {
    const verdict = evaluatePressure([sample(0, 40), sample(10_000, 40), sample(20_000, 0.2)], 25_000)
    expect(verdict.level).not.toBe('overloaded')
  })

  it('anchors "since" on the first sample of the current run', () => {
    const verdict = evaluatePressure([sample(0, 40), sample(10_000, 40), sample(20_000, 40)], 30_000)
    expect(verdict.since).toBe(0)
  })
})

describe('PressureMonitor', () => {
  it('samples on the injected clock and load, and exposes the verdict without a new sample', () => {
    let now = 0
    let load = CORES * 1.2
    const monitor = new PressureMonitor({ now: () => now, load1: () => load, cores: () => CORES })
    monitor.sample(5)
    expect(monitor.snapshot().level).toBe('ok')
    now = 10_000
    monitor.sample(5)
    expect(monitor.snapshot().level).toBe('busy')
    load = 40
    now = 30_000
    monitor.sample(5)
    now = 45_000
    monitor.sample(5)
    expect(monitor.isOverloaded()).toBe(true)
    // Reading does not add a sample: the last verdict stays until the next tick.
    expect(monitor.snapshot().level).toBe('overloaded')
  })
})
