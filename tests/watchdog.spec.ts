/**
 * The watchdog's decision rules. The action is destructive (a dsh restart ends
 * every running session), so the conservative edges are what these tests pin:
 * never restart a host that was not seen healthy, never on a closed port or a
 * missing route, never in a loop.
 */
import { describe, expect, it } from 'vitest'
import { decideWatchdog, initialWatchdogState, type WatchdogState } from '../src/core/watchdog.ts'

const HOUR = 60 * 60_000
const MIN = 60_000

function policy(now: number, overrides: Partial<{ unhealthyLimit: number; cooldownMs: number; maxRestartsPerHour: number }> = {}) {
  return {
    unhealthyLimit: 4,
    cooldownMs: 10 * MIN,
    maxRestartsPerHour: 3,
    now,
    ...overrides,
  }
}

function armed(streak = 0): WatchdogState {
  return { ...initialWatchdogState(), armed: true, lastHealthyAt: 0, unhealthyStreak: streak }
}

describe('watchdog decisions', () => {
  it('arms on a healthy probe and clears the streak', () => {
    const decision = decideWatchdog('healthy', { ...initialWatchdogState(), unhealthyStreak: 2 }, policy(5_000))
    expect(decision.action).toBe('idle')
    expect(decision.state.armed).toBe(true)
    expect(decision.state.unhealthyStreak).toBe(0)
    expect(decision.state.lastHealthyAt).toBe(5_000)
  })

  it('never restarts a host that was not seen healthy', () => {
    const decision = decideWatchdog('unhealthy', initialWatchdogState(), policy(10 * MIN))
    expect(decision.action).toBe('idle')
    expect(decision.state.unhealthyStreak).toBe(1)
  })

  it('does not count a closed port or a missing route as a hang', () => {
    for (const outcome of ['refused', 'missing', 'foreign'] as const) {
      const decision = decideWatchdog(outcome, armed(3), policy(5 * MIN))
      expect(decision.action).toBe('idle')
      expect(decision.state.unhealthyStreak).toBe(0)
      // A host the watchdog does not own must prove itself before another restart.
      expect(decision.state.armed).toBe(false)
    }
  })

  it('waits for the sustained window before restarting', () => {
    const first = decideWatchdog('unhealthy', armed(0), policy(30_000))
    expect(first.action).toBe('idle')
    expect(first.state.unhealthyStreak).toBe(1)
    const third = decideWatchdog('unhealthy', armed(2), policy(90_000))
    expect(third.action).toBe('idle')
    expect(third.state.unhealthyStreak).toBe(3)
    const fourth = decideWatchdog('unhealthy', armed(3), policy(120_000))
    expect(fourth.action).toBe('restart')
    expect(fourth.state.unhealthyStreak).toBe(0)
    expect(fourth.state.lastRestartAt).toBe(120_000)
    expect(fourth.state.armed).toBe(false)
    expect(fourth.state.restarts).toEqual([120_000])
  })

  it('keeps the cooldown after a restart', () => {
    const state: WatchdogState = { ...armed(3), lastRestartAt: 5 * MIN, restarts: [5 * MIN] }
    const decision = decideWatchdog('unhealthy', state, policy(6 * MIN))
    expect(decision.action).toBe('idle')
    expect(decision.reason).toContain('cooldown')
  })

  it('caps the automatic restarts per hour', () => {
    const state: WatchdogState = {
      ...armed(3),
      lastRestartAt: 40 * MIN,
      restarts: [5 * MIN, 20 * MIN, 40 * MIN],
    }
    // The cooldown has passed, the hourly cap has not.
    const decision = decideWatchdog('unhealthy', state, policy(55 * MIN))
    expect(decision.action).toBe('idle')
    expect(decision.reason).toContain('last hour')
  })

  it('prunes restart timestamps older than an hour', () => {
    const state: WatchdogState = { ...armed(3), lastRestartAt: 90 * MIN, restarts: [90 * MIN] }
    const decision = decideWatchdog('unhealthy', state, policy(3 * HOUR))
    expect(decision.action).toBe('restart')
    expect(decision.state.restarts).toEqual([3 * HOUR])
  })
})
