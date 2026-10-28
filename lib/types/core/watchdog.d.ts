/**
 * The task-board watchdog's decision core, kept pure so the "restart or not"
 * rule is testable without a live dsh.
 *
 * Why an external process: when the Host's event loop is blocked (a machine
 * oversubscribed by three agent sessions, a stuck tool job), the Host cannot
 * report its own death — every timer it owns is late, including the one that
 * would raise the alarm. Only a process outside dsh can observe "the health
 * route stopped answering" and act.
 *
 * The rules are deliberately conservative, because the action is destructive
 * (a dsh restart ends every running session):
 *
 * - Never restart a host that was not *seen healthy* in this series: a closed
 *   port, a missing route or a refused connection means "not our host" (the
 *   user stopped it, it is still starting, or the plugin is not mounted).
 * - Only a *hang* (timeout / 5xx) counts as unhealthy. A connection refused is
 *   not a hang.
 * - Restart only after `unhealthyLimit` consecutive hangs (≈ 2 minutes at a
 *   30 s probe interval), never in a loop (cooldown and hourly cap), and write
 *   a notice the fresh Host will show.
 */
/** One probe's verdict. */
export type ProbeOutcome = 
/** The health route answered 2xx with a body. */
'healthy'
/** The route did not answer in time, or answered 5xx. */
 | 'unhealthy'
/** No such route (404): the plugin is not mounted, or an older build runs. */
 | 'missing'
/** The port is closed: dsh is not running (or the user stopped it). */
 | 'refused'
/** Something else answered (401/403/4xx, a foreign service). */
 | 'foreign';
/** What the watchdog remembers across probes (persisted, so a timer run is stateless). */
export interface WatchdogState {
    /** Last answered healthy probe. */
    lastHealthyAt?: number;
    /** Consecutive hangs since the last non-hanging outcome. */
    unhealthyStreak: number;
    /** Successful automatic restarts within the last hour (pruned on write). */
    restarts: number[];
    /** The last automatic restart. */
    lastRestartAt?: number;
    /**
     * Whether this series saw the Host healthy at least once. Only an armed
     * watchdog may restart: a host that never answered is left alone.
     */
    armed: boolean;
}
/** Tunables (the CLI passes them from its flags). */
export interface WatchdogPolicy {
    /** Consecutive hangs that trigger the restart (>= 2). */
    unhealthyLimit: number;
    /** Minimum time between two automatic restarts. */
    cooldownMs: number;
    /** Hard cap of automatic restarts inside one hour. */
    maxRestartsPerHour: number;
    now: number;
}
/** The decision plus the state to persist. */
export interface WatchdogDecision {
    action: 'idle' | 'restart';
    state: WatchdogState;
    /** Human-readable reason, logged and carried into the board notice. */
    reason: string;
}
/** A fresh state: unarmed, no streak, no restarts. */
export declare function initialWatchdogState(): WatchdogState;
/**
 * Apply one probe outcome.
 * @param outcome - the probe's verdict.
 * @param state - the persisted state from the previous run.
 * @param policy - thresholds and the current time.
 * @returns the decision and the state to write back.
 */
export declare function decideWatchdog(outcome: ProbeOutcome, state: WatchdogState, policy: WatchdogPolicy): WatchdogDecision;
