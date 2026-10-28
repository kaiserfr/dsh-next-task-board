#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { request } from "node:http";
//#region src/core/watchdog.ts
/** A fresh state: unarmed, no streak, no restarts. */
function initialWatchdogState() {
	return {
		unhealthyStreak: 0,
		restarts: [],
		armed: false
	};
}
const HOUR_MS = 60 * 6e4;
/**
* Apply one probe outcome.
* @param outcome - the probe's verdict.
* @param state - the persisted state from the previous run.
* @param policy - thresholds and the current time.
* @returns the decision and the state to write back.
*/
function decideWatchdog(outcome, state, policy) {
	const now = policy.now;
	const restarts = state.restarts.filter((at) => now - at < HOUR_MS);
	const base = {
		...state,
		restarts
	};
	switch (outcome) {
		case "healthy": return {
			action: "idle",
			state: {
				...base,
				lastHealthyAt: now,
				unhealthyStreak: 0,
				armed: true
			},
			reason: "host answered health"
		};
		case "refused": return {
			action: "idle",
			state: {
				...base,
				unhealthyStreak: 0,
				armed: false
			},
			reason: "host is not running (connection refused) — not starting it"
		};
		case "missing": return {
			action: "idle",
			state: {
				...base,
				unhealthyStreak: 0,
				armed: false
			},
			reason: "health route is missing (plugin not mounted or older build) — leaving the host alone"
		};
		case "foreign": return {
			action: "idle",
			state: {
				...base,
				unhealthyStreak: 0,
				armed: false
			},
			reason: "another service answered on this port — leaving the host alone"
		};
		case "unhealthy": {
			const streak = state.unhealthyStreak + 1;
			if (!state.armed) return {
				action: "idle",
				state: {
					...base,
					unhealthyStreak: streak
				},
				reason: `probe ${streak} failed, but the host was never seen healthy in this series — not restarting`
			};
			if (streak < Math.max(2, policy.unhealthyLimit)) return {
				action: "idle",
				state: {
					...base,
					unhealthyStreak: streak
				},
				reason: `probe ${streak}/${Math.max(2, policy.unhealthyLimit)} failed — waiting for the sustained window`
			};
			if (state.lastRestartAt !== void 0 && now - state.lastRestartAt < policy.cooldownMs) return {
				action: "idle",
				state: {
					...base,
					unhealthyStreak: streak
				},
				reason: "host is unresponsive, but the cooldown after the last restart has not elapsed"
			};
			if (restarts.length >= policy.maxRestartsPerHour) return {
				action: "idle",
				state: {
					...base,
					unhealthyStreak: streak
				},
				reason: `host is unresponsive, but ${policy.maxRestartsPerHour} automatic restarts happened in the last hour`
			};
			return {
				action: "restart",
				state: {
					...base,
					unhealthyStreak: 0,
					lastRestartAt: now,
					restarts: [...restarts, now],
					armed: false
				},
				reason: `host has not answered for ${streak} consecutive probes — restarting dsh`
			};
		}
	}
}
//#endregion
//#region src/watchdog.ts
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
const LOG_LIMIT_BYTES = 1024 * 1024;
function usage() {
	return "usage: node lib/watchdog.js [--home <dir>] [--port <n>] [--probe-timeout-ms <n>] [--unhealthy-limit <n>] [--cooldown-ms <n>] [--max-restarts-per-hour <n>] [--restart-command <path>] [--state-file <path>] [--log <path>] [--dry-run] [--verbose]";
}
/** Integer flag with a validated fallback (a typo must not silently change policy). */
function intFlag(raw, fallback, min) {
	if (raw === void 0) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}
function parseArgs(argv) {
	const home = process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	const options = {
		home,
		port: intFlag(process.env.DSH_LOOPBACK_PORT, 3080, 1),
		probeTimeoutMs: 1e4,
		unhealthyLimit: 4,
		cooldownMs: 10 * 6e4,
		maxRestartsPerHour: 3,
		restartCommand: join(homedir(), ".local", "bin", "dsh-stop"),
		stateFile: join(home, "task-board", "watchdog-state.json"),
		logFile: join(home, "logs", "task-board-watchdog.log"),
		dryRun: false,
		verbose: false
	};
	let stateFileExplicit = false;
	let logFileExplicit = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = () => {
			const next = argv[index + 1];
			if (next === void 0 || next.startsWith("--")) return void 0;
			index += 1;
			return next;
		};
		switch (arg) {
			case "--help":
			case "-h": return "help";
			case "--home": {
				const next = value();
				if (next === void 0) return usage();
				options.home = next;
				break;
			}
			case "--port":
				options.port = intFlag(value(), options.port, 1);
				break;
			case "--probe-timeout-ms":
				options.probeTimeoutMs = intFlag(value(), options.probeTimeoutMs, 100);
				break;
			case "--unhealthy-limit":
				options.unhealthyLimit = intFlag(value(), options.unhealthyLimit, 2);
				break;
			case "--cooldown-ms":
				options.cooldownMs = intFlag(value(), options.cooldownMs, 0);
				break;
			case "--max-restarts-per-hour":
				options.maxRestartsPerHour = intFlag(value(), options.maxRestartsPerHour, 0);
				break;
			case "--restart-command": {
				const next = value();
				if (next === void 0) return usage();
				options.restartCommand = next;
				break;
			}
			case "--state-file": {
				const next = value();
				if (next === void 0) return usage();
				options.stateFile = next;
				stateFileExplicit = true;
				break;
			}
			case "--log": {
				const next = value();
				if (next === void 0) return usage();
				options.logFile = next;
				logFileExplicit = true;
				break;
			}
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--verbose":
				options.verbose = true;
				break;
			default: return usage();
		}
	}
	if (!stateFileExplicit) options.stateFile = join(options.home, "task-board", "watchdog-state.json");
	if (!logFileExplicit) options.logFile = join(options.home, "logs", "task-board-watchdog.log");
	return options;
}
function log(options, line) {
	const text = `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`;
	try {
		mkdirSync(dirname(options.logFile), { recursive: true });
		if (existsSync(options.logFile) && statSync(options.logFile).size > LOG_LIMIT_BYTES) writeFileSync(options.logFile, "");
		appendFileSync(options.logFile, text);
	} catch {}
}
function readState(path) {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return {
			unhealthyStreak: typeof raw.unhealthyStreak === "number" && Number.isFinite(raw.unhealthyStreak) ? Math.max(0, raw.unhealthyStreak) : 0,
			restarts: Array.isArray(raw.restarts) ? raw.restarts.filter((at) => typeof at === "number" && Number.isFinite(at)) : [],
			armed: raw.armed === true,
			...typeof raw.lastHealthyAt === "number" ? { lastHealthyAt: raw.lastHealthyAt } : {},
			...typeof raw.lastRestartAt === "number" ? { lastRestartAt: raw.lastRestartAt } : {}
		};
	} catch {
		return initialWatchdogState();
	}
}
function writeState(path, state) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
		renameSync(tmp, path);
	} catch {}
}
/**
* Probe `GET /api/task-board/health` once.
*
* The classification is the whole safety story: a closed port (`refused`) or a
* missing route (`missing`) must never trigger a restart, only a hang does.
*/
function probe(port, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (outcome, detail) => {
			if (settled) return;
			settled = true;
			resolve({
				outcome,
				detail
			});
		};
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/api/task-board/health",
			method: "GET",
			timeout: timeoutMs,
			headers: {
				accept: "application/json",
				origin: `http://127.0.0.1:${port}`,
				"sec-fetch-site": "same-origin"
			}
		}, (res) => {
			const status = res.statusCode ?? 0;
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				if (body.length < 16384) body += chunk;
			});
			res.on("end", () => {
				if (status === 200) {
					try {
						const parsed = JSON.parse(body);
						const level = typeof parsed.pressure?.level === "string" ? parsed.pressure.level : "unknown";
						finish("healthy", `level=${level}`);
					} catch {
						finish("foreign", "status=200 but not the task-board health JSON");
					}
					return;
				}
				if (status === 404) return finish("missing", "status=404 (route not mounted)");
				if (status >= 500) return finish("unhealthy", `status=${status}`);
				if (status === 401 || status === 403) return finish("foreign", `status=${status} (health route absent or an auth fence answered)`);
				finish("foreign", `status=${status}`);
			});
			res.on("error", () => finish("unhealthy", "response stream failed"));
		});
		req.on("timeout", () => {
			req.destroy();
			finish("unhealthy", `no answer within ${timeoutMs} ms`);
		});
		req.on("error", (error) => {
			const code = error.code;
			if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL") {
				finish("refused", `connection refused (${code})`);
				return;
			}
			finish("unhealthy", error instanceof Error ? error.message : String(error));
		});
		req.end();
	});
}
/** Write the notice the fresh Host shows, then ask dsh-stop to restart it. */
function restart(options, reason) {
	const noticeFile = join(options.home, "task-board", "watchdog-notice.json");
	try {
		mkdirSync(dirname(noticeFile), { recursive: true });
		writeFileSync(noticeFile, `${JSON.stringify({
			at: Date.now(),
			reason
		}, null, 2)}\n`);
	} catch {}
	try {
		const child = spawn(options.restartCommand, ["--restart"], {
			detached: true,
			stdio: "ignore",
			env: process.env
		});
		child.unref();
		child.on("error", () => {});
		return true;
	} catch {
		return false;
	}
}
/** Best-effort desktop notification (the GUI may be gone). */
function notify(message) {
	try {
		spawn("notify-send", ["DeepSeek Harness", message], {
			detached: true,
			stdio: "ignore"
		}).unref();
	} catch {}
}
async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed === "help") {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	if (typeof parsed === "string") {
		process.stderr.write(`${parsed}\n`);
		return 2;
	}
	const options = parsed;
	const now = Date.now();
	const { outcome, detail } = await probe(options.port, options.probeTimeoutMs);
	const state = readState(options.stateFile);
	const decision = decideWatchdog(outcome, state, {
		unhealthyLimit: options.unhealthyLimit,
		cooldownMs: options.cooldownMs,
		maxRestartsPerHour: options.maxRestartsPerHour,
		now
	});
	const changed = decision.state.unhealthyStreak !== state.unhealthyStreak || decision.state.armed !== state.armed || decision.action !== "idle";
	if (options.verbose || changed || outcome !== "healthy") log(options, `probe=${outcome} (${detail}) streak=${decision.state.unhealthyStreak} armed=${decision.state.armed} decision=${decision.action} reason="${decision.reason}"`);
	writeState(options.stateFile, decision.state);
	if (decision.action !== "restart") return 0;
	if (options.dryRun) {
		log(options, "dry-run: would restart dsh now");
		return 0;
	}
	const started = restart(options, decision.reason);
	log(options, started ? `restart requested: ${options.restartCommand} --restart (${decision.reason})` : `restart could not be spawned: ${options.restartCommand} (${decision.reason})`);
	if (started) notify("Der Task-Board-Host antwortet nicht mehr — dsh wird automatisch neu gestartet.");
	return 0;
}
main().then((code) => process.exit(code)).catch((error) => {
	process.stderr.write(`watchdog failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
//#endregion
export {};
