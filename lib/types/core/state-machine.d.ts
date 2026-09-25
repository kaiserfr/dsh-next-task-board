/**
 * Configurable task-board state machine. The board's columns *are* the task
 * states; this module holds the machine as plain data plus the pure functions
 * that read it:
 *
 * - `states`       — the columns: which task status exists, its label, order.
 * - `transitions`  — the allowed state changes; anything not listed is refused,
 *                    which is what validates a drag & drop target.
 * - `actions`      — what runs when a transition fires (`git.openBranch`,
 *                    `git.mergeBranch`, `run`, `stamp`).
 *
 * Framework-free (no cordis, no runtime imports) so the two sides that need it
 * can share it: the Host enforces moves with the very same machine the browser
 * validates its drop targets against. The Host hands its resolved machine to
 * the browser in the snapshot, so a customized machine cannot drift between
 * the two halves.
 *
 * `DEFAULT_STATE_MACHINE` is the machine the board has always run; a
 * deployment can override it (plugin config / settings namespace `task-board`,
 * field `stateMachine`). Invalid configuration never bricks the board: the
 * normalizer reports why and the caller keeps the default.
 */
/** Task lifecycle status. The closed union is stable; the machine says which are columns. */
export type TaskStatus = 'backlog' | 'todo' | 'running' | 'ready_for_test' | 'done' | 'failed';
/** Every status the ledger knows, independent of any machine configuration. */
export declare const ALL_STATUSES: readonly TaskStatus[];
/** Brand an unknown string as a status; undefined when it is not one. */
export declare function isTaskStatus(value: unknown): value is TaskStatus;
/** Who may take a transition: a human drag/drop, the run settling, or the cron scheduler. */
export type StateTrigger = 'manual' | 'runner' | 'cron';
/**
 * An action fired by a transition. The string form names a Host action (the
 * `kind` with default options); the object form names it explicitly and adds
 * options:
 *
 * - `'git.openBranch'`   — cut the card's feature branch (no-op without a repo).
 * - `'git.mergeBranch'`  — commit the run's work and merge the branch back.
 * - `'run'`              — open an execution for the card (see the ledger).
 * - `{ kind: 'stamp', field: 'doneAt' }` — write a timestamped task field.
 */
export type StateAction = string | {
    kind: string;
    field?: string;
};
/** One transition between two states. */
export interface StateTransition {
    /** Status the card is in. */
    from: TaskStatus;
    /** Status the card moves to. */
    to: TaskStatus;
    /** Who may fire it; defaults to `manual`. */
    trigger?: StateTrigger;
    /** When false the card's git state is left untouched; defaults to true. */
    git?: boolean;
    /** Actions fired in order when the transition runs. */
    actions?: StateAction[];
}
/** One column of the board: a state of the machine. */
export interface StateNode {
    /** The task status this column shows. */
    status: TaskStatus;
    /** Human-facing column title; absent falls back to the built-in locale label. */
    label?: string;
    /** Column order on the board; absent keeps the previous/declaration order. */
    order?: number;
    /** Whether cards may be dropped here at all; defaults to true. */
    drop?: boolean;
}
/** The declarative machine. Everything the board needs to validate and act. */
export interface StateMachineConfig {
    /** Columns to show, in board order (unless `order` says otherwise). */
    states: StateNode[];
    /** Allowed state changes with their actions. */
    transitions: StateTransition[];
    /** Status a newly created task lands in; defaults to the neutral `backlog`. */
    initial?: TaskStatus;
}
/** Actions the built-in Host understands; anything else is rejected by the normalizer. */
export declare const STATE_ACTION_KINDS: readonly ["git.openBranch", "git.mergeBranch", "run", "stamp"];
/** Action kind. */
export type StateActionKind = typeof STATE_ACTION_KINDS[number];
/** Task fields the `stamp` action may write. */
export declare const STAMP_FIELDS: readonly ["doneAt"];
/**
 * The machine the board ships with, spelling out exactly the lifecycle the
 * hardcoded board implemented:
 *
 * - new cards land in `backlog`; a human pulls them in
 * - `backlog → todo` opens the feature branch
 * - `running` is the runner's own state: it is entered by a run and left by
 *   that run settling (success → `ready_for_test`, failure → `failed`),
 *   never by a drag
 * - `ready_for_test → done` commits and merges the feature branch back
 * - every manual → manual move is allowed, as before
 *
 * `git` is a hand-maintained summary of the host's git hooks in comments only;
 * the operational hooks live in `git-workflow.ts`.
 */
export declare const DEFAULT_STATE_MACHINE: StateMachineConfig;
/**
 * A machine resolved from a config: the interface both the Host ledger and the
 * browser use. Instances are cheap and immutable; build one per config change.
 */
export declare class StateMachine {
    /** The normalized configuration this machine was built from. */
    readonly config: StateMachineConfig;
    constructor(config: StateMachineConfig);
    /** Columns in board order. */
    get states(): readonly StateNode[];
    /** Status of the first column, i.e. where new cards land. */
    get initialStatus(): TaskStatus;
    /** Whether `status` is a configured column. */
    hasState(status: TaskStatus): boolean;
    /** The column definition of a status; undefined when it is not a column. */
    state(status: TaskStatus): StateNode | undefined;
    /** Whether a card may be dropped on this column at all. */
    acceptsDrop(status: TaskStatus): boolean;
    /** The transition for `from → to` and trigger, or undefined when it is not allowed. */
    transition(from: TaskStatus, to: TaskStatus, trigger?: StateTrigger): StateTransition | undefined;
    /** Whether `from → to` may be fired by `trigger`. The one drag-validation entry point. */
    canTransition(from: TaskStatus, to: TaskStatus, trigger?: StateTrigger): boolean;
    /** Every status reachable from `from` with `trigger`, in declaration order. */
    targets(from: TaskStatus, trigger?: StateTrigger): TaskStatus[];
    /**
     * The actions fired by `from → to`, in configured order. Empty for an
     * unknown transition — refuse the move before asking for actions.
     */
    actionsFor(from: TaskStatus, to: TaskStatus, trigger?: StateTrigger): StateAction[];
    /** Serialized machine, for the wire and for the diagram. */
    toJSON(): StateMachineConfig;
}
/** A config value plus the reasons it was refused; `machine` is undefined when invalid. */
export interface NormalizedStateMachine {
    machine?: StateMachine;
    /** Human-readable refusals; empty when the input was accepted. */
    errors: string[];
}
/**
 * Validate and normalize a machine config — the only place a config enters the
 * system. Unknown statuses, unknown actions, bad triggers, self-transitions,
 * duplicate columns/transitions and a nonsensical `initial` are refused with a
 * reason; a non-empty `errors` means the caller must keep the default machine.
 *
 * @param value - the raw config (settings JSON, composition default, test fixture).
 * @returns the machine plus every refusal found (empty `errors` = accepted).
 */
export declare function normalizeStateMachine(value: unknown): NormalizedStateMachine;
/**
 * Resolve a config to a machine, falling back to {@link DEFAULT_STATE_MACHINE}
 * on any refusal. The Host and the browser both call this, so "invalid config =
 * shipped machine" is one decision, not two.
 * @param value - raw config; undefined/absent uses the default machine.
 */
export declare function resolveStateMachine(value: unknown): {
    machine: StateMachine;
    errors: string[];
};
/** Short label of one action, as the diagram prints it next to the arrow. */
export declare function actionLabel(action: StateAction): string;
/**
 * Render a machine as a Mermaid `stateDiagram-v2` — the board's state engine as
 * a picture. Deterministic: same machine, same text, so a checked-in diagram
 * can be diffed against the definition (see `scripts/render-state-machine.mjs`).
 *
 * Edges are grouped by trigger: `runner`/`cron` transitions of one source state
 * share a single annotated arrow, manual ones keep their own arrow so the
 * actions hanging off them stay readable.
 */
export declare function renderStateMachineMermaid(machine: StateMachine): string;
/** The board's state machine as Mermaid text, ready for the diagram document. */
export declare const STATE_MACHINE_DIAGRAM: string;
