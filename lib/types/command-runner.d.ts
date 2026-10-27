/** One command to run, addressed to a card (`scope`) when it has one. */
export interface CommandRequest {
    /** Executable (absolute path or PATH lookup), never a shell string. */
    command: string;
    args?: readonly string[];
    cwd: string;
    /** Extra environment on top of `process.env`. */
    env?: Record<string, string>;
    /** Upper bound for this command; the child is killed when it expires. */
    timeoutMs: number;
    /**
     * Card id the command works for. Every command of one scope is killed by
     * {@link CommandRunner.cancelScope}, which is how "Abbrechen" reaches a
     * running commit, merge, compose build or review command.
     */
    scope?: string;
}
/** Outcome of one command; never throws for a non-zero exit. */
export interface CommandResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    /** The runner's own deadline killed the child. */
    timedOut: boolean;
    /** The card's cancellation killed the child before it finished. */
    aborted: boolean;
}
/** How the workflows start commands; the Host injects a worker-backed one. */
export interface CommandRunner {
    run(request: CommandRequest): Promise<CommandResult>;
    /** Kill every running command of one card; returns how many were killed. */
    cancelScope(scope: string): number;
    /** Card ids with a command running right now (for the board's "Abbrechen"). */
    busyScopes(): string[];
    dispose(): void;
}
/** A settled command that was killed by the scope's cancellation. */
export declare function abortedResult(stdout: string, stderr: string): CommandResult;
/**
 * In-process runner: the behaviour the workflows had before, plus scope
 * cancellation. Suitable for tests and for the worker's own child handling.
 */
export declare class LocalCommandRunner implements CommandRunner {
    private readonly running;
    run(request: CommandRequest): Promise<CommandResult>;
    cancelScope(scope: string): number;
    busyScopes(): string[];
    dispose(): void;
}
/** Message shapes between {@link WorkerCommandRunner} and `command-worker.ts`. */
export type CommandWorkerRequest = {
    type: 'run';
    id: string;
    request: CommandRequest;
} | {
    type: 'cancel';
    scope: string;
} | {
    type: 'busy';
};
export type CommandWorkerReply = {
    type: 'result';
    id: string;
    result: CommandResult;
} | {
    type: 'cancelled';
    scope: string;
    killed: number;
} | {
    type: 'busy';
    scopes: string[];
};
/**
 * Worker-backed runner: child processes and their output handling run in a
 * `worker_threads` worker, so a build that produces megabytes of output cannot
 * starve the Host's event loop. The worker is created lazily and restarted after
 * a crash; a command that was in flight when the worker died is reported as
 * cancelled rather than silently lost.
 */
export declare class WorkerCommandRunner implements CommandRunner {
    private readonly workerUrl;
    private worker;
    private fallback;
    private readonly pending;
    constructor(workerUrl?: URL);
    private ensure;
    private fail;
    run(request: CommandRequest): Promise<CommandResult>;
    cancelScope(scope: string): number;
    busyScopes(): string[];
    dispose(): void;
}
/**
 * Build the runner the Host uses: the worker-backed one when the built worker
 * entry exists, otherwise the in-process runner (source checkout, tests, or a
 * build that predates the worker). A worker that cannot start is not an error
 * the board should surface — the commands still run.
 */
export declare function createHostCommandRunner(workerUrl?: URL): CommandRunner;
