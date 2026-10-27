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
import { parentPort } from 'node:worker_threads'
import { LocalCommandRunner, type CommandWorkerReply, type CommandWorkerRequest } from './command-runner.ts'

const runner = new LocalCommandRunner()
const port = parentPort

if (port !== null) {
  port.on('message', (message: CommandWorkerRequest) => {
    if (message.type === 'run') {
      void runner.run(message.request).then((result) => {
        port.postMessage({ type: 'result', id: message.id, result } satisfies CommandWorkerReply)
      }, (error: unknown) => {
        port.postMessage({
          type: 'result',
          id: message.id,
          result: {
            code: null,
            signal: null,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            timedOut: false,
            aborted: true,
          },
        } satisfies CommandWorkerReply)
      })
      return
    }
    if (message.type === 'cancel') {
      const killed = runner.cancelScope(message.scope)
      port.postMessage({ type: 'cancelled', scope: message.scope, killed } satisfies CommandWorkerReply)
      return
    }
    port.postMessage({ type: 'busy', scopes: runner.busyScopes() } satisfies CommandWorkerReply)
  })
}
