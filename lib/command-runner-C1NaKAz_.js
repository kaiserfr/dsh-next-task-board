import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
//#region src/command-runner.ts
/**
* One command surface for every child process the Host starts on behalf of a
* card: git, docker compose, the review commands and the read-only snapshots.
*
* The runner exists for two reasons:
*
* 1. **Priority and cancellation.** A command can be cancelled by scope (the
*    card id), so "abort this card's running action" reaches the child process
*    instead of waiting for its timeout. Without that, a wedged `git rebase` or
*    a docker build kept the board's card busy for minutes.
* 2. **Off the Host's event loop.** In the Host the runner is backed by a
*    worker thread (see `command-worker.ts`): child-process output, encoding and
*    the timeout bookkeeping live in the worker, so a chatty build cannot
*    compete with `/state`, `/parse` or the SSE stream for the main loop.
*
* The worker is an implementation detail: tests and the pure workflow classes
* use the in-process runner, which behaves identically apart from running on
* the caller's loop.
*/
/** A settled command that was killed by the scope's cancellation. */
function abortedResult(stdout, stderr) {
	return {
		code: null,
		signal: "SIGKILL",
		stdout,
		stderr: `${stderr}${stderr === "" ? "" : "\n"}cancelled by the operator`,
		timedOut: false,
		aborted: true
	};
}
/**
* In-process runner: the behaviour the workflows had before, plus scope
* cancellation. Suitable for tests and for the worker's own child handling.
*/
var LocalCommandRunner = class {
	running = /* @__PURE__ */ new Map();
	run(request) {
		const id = randomUUID();
		return new Promise((resolve) => {
			let settled = false;
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let aborted = false;
			const child = spawn(request.command, [...request.args ?? []], {
				cwd: request.cwd,
				shell: false,
				env: {
					...process.env,
					...request.env ?? {}
				},
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
			const finish = (result) => {
				if (settled) return;
				settled = true;
				this.running.delete(id);
				clearTimeout(timer);
				resolve(result);
			};
			this.running.set(id, {
				child,
				...request.scope === void 0 ? {} : { scope: request.scope },
				finish: (result) => {
					aborted = result.aborted;
					finish(result);
				}
			});
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", (error) => {
				finish({
					code: null,
					signal: null,
					stdout,
					stderr: `${stderr}${error.message}`,
					timedOut,
					aborted
				});
			});
			child.once("close", (code, signal) => {
				finish({
					code,
					signal: signal ?? null,
					stdout,
					stderr,
					timedOut,
					aborted
				});
			});
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {}
			}, request.timeoutMs);
		});
	}
	cancelScope(scope) {
		let killed = 0;
		for (const command of [...this.running.values()]) {
			if (command.scope !== scope) continue;
			killed += 1;
			command.finish(abortedResult("", ""));
			try {
				command.child.kill("SIGKILL");
			} catch {}
		}
		return killed;
	}
	busyScopes() {
		const scopes = /* @__PURE__ */ new Set();
		for (const command of this.running.values()) if (command.scope !== void 0) scopes.add(command.scope);
		return [...scopes];
	}
	dispose() {
		for (const command of [...this.running.values()]) {
			try {
				command.child.kill("SIGKILL");
			} catch {}
			command.finish(abortedResult("", "runner disposed"));
		}
		this.running.clear();
	}
};
/**
* Worker-backed runner: child processes and their output handling run in a
* `worker_threads` worker, so a build that produces megabytes of output cannot
* starve the Host's event loop. The worker is created lazily and restarted after
* a crash; a command that was in flight when the worker died is reported as
* cancelled rather than silently lost.
*/
var WorkerCommandRunner = class {
	workerUrl;
	worker;
	fallback;
	pending = /* @__PURE__ */ new Map();
	constructor(workerUrl = new URL("./command-worker.js", import.meta.url)) {
		this.workerUrl = workerUrl;
	}
	ensure() {
		if (this.worker !== void 0) return this.worker;
		const worker = new Worker(this.workerUrl, { name: "dsh-task-board-commands" });
		worker.unref();
		worker.on("message", (message) => {
			if (message.type === "result") {
				const pending = this.pending.get(message.id);
				if (pending === void 0) return;
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				pending.resolve(message.result);
			}
		});
		worker.on("error", (error) => {
			this.fail(error);
		});
		worker.on("exit", (code) => {
			if (code !== 0) this.fail(/* @__PURE__ */ new Error(`command worker exited with code ${code}`));
		});
		this.worker = worker;
		return worker;
	}
	fail(error) {
		this.worker = void 0;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.resolve({
				code: null,
				signal: null,
				stdout: "",
				stderr: `command worker failed: ${error.message}`,
				timedOut: false,
				aborted: true
			});
		}
	}
	run(request) {
		let worker;
		try {
			worker = this.ensure();
		} catch {
			this.fallback ??= new LocalCommandRunner();
			return this.fallback.run(request);
		}
		const id = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (pending === void 0) return;
				this.pending.delete(id);
				pending.resolve({
					code: null,
					signal: null,
					stdout: "",
					stderr: "command worker did not answer",
					timedOut: true,
					aborted: false
				});
				this.cancelScope(request.scope ?? "");
				worker.terminate();
				this.worker = void 0;
			}, request.timeoutMs + 5e3);
			this.pending.set(id, {
				resolve,
				request,
				timer
			});
			worker.postMessage({
				type: "run",
				id,
				request
			});
		});
	}
	cancelScope(scope) {
		if (this.fallback !== void 0) return this.fallback.cancelScope(scope);
		if (scope === "" || this.worker === void 0) return 0;
		let killed = 0;
		for (const [id, pending] of [...this.pending]) {
			if (pending.request.scope !== scope) continue;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.resolve(abortedResult("", ""));
			killed += 1;
		}
		if (killed > 0) this.worker.postMessage({
			type: "cancel",
			scope
		});
		return killed;
	}
	busyScopes() {
		if (this.fallback !== void 0) return this.fallback.busyScopes();
		const scopes = /* @__PURE__ */ new Set();
		for (const pending of this.pending.values()) if (pending.request.scope !== void 0) scopes.add(pending.request.scope);
		return [...scopes];
	}
	dispose() {
		this.fallback?.dispose();
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.resolve(abortedResult("", "runner disposed"));
		}
		this.worker?.terminate();
		this.worker = void 0;
	}
};
/**
* Build the runner the Host uses: the worker-backed one when the built worker
* entry exists, otherwise the in-process runner (source checkout, tests, or a
* build that predates the worker). A worker that cannot start is not an error
* the board should surface — the commands still run.
*/
function createHostCommandRunner(workerUrl) {
	try {
		return new WorkerCommandRunner(workerUrl);
	} catch {
		return new LocalCommandRunner();
	}
}
//#endregion
export { createHostCommandRunner as n, LocalCommandRunner as t };
