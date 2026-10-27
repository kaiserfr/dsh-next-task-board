import { t as LocalCommandRunner } from "./command-runner-C1NaKAz_.js";
import { parentPort } from "node:worker_threads";
//#region src/command-worker.ts
/**
* Worker entry for {@link WorkerCommandRunner}: runs the card's child processes
* off the Host's event loop.
*
* The worker owns exactly one job — start a child, collect its output, enforce
* the deadline, kill it on cancellation — and reports the result back. It has no
* ledger, no session access and no configuration of its own, so a crash can only
* cost the commands that were in flight (the runner reports them as cancelled
* and the card's action fails visibly).
*/
const runner = new LocalCommandRunner();
const port = parentPort;
if (port !== null) port.on("message", (message) => {
	if (message.type === "run") {
		runner.run(message.request).then((result) => {
			port.postMessage({
				type: "result",
				id: message.id,
				result
			});
		}, (error) => {
			port.postMessage({
				type: "result",
				id: message.id,
				result: {
					code: null,
					signal: null,
					stdout: "",
					stderr: error instanceof Error ? error.message : String(error),
					timedOut: false,
					aborted: true
				}
			});
		});
		return;
	}
	if (message.type === "cancel") {
		const killed = runner.cancelScope(message.scope);
		port.postMessage({
			type: "cancelled",
			scope: message.scope,
			killed
		});
		return;
	}
	port.postMessage({
		type: "busy",
		scopes: runner.busyScopes()
	});
});
//#endregion
export {};
