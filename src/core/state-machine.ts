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
export type TaskStatus = 'backlog' | 'todo' | 'running' | 'ready_for_test' | 'done' | 'failed'

/** Every status the ledger knows, independent of any machine configuration. */
export const ALL_STATUSES: readonly TaskStatus[] = [
  'backlog', 'todo', 'running', 'ready_for_test', 'done', 'failed',
]

/** Brand an unknown string as a status; undefined when it is not one. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value)
}

/** Who may take a transition: a human drag/drop, the run settling, or the cron scheduler. */
export type StateTrigger = 'manual' | 'runner' | 'cron'

const TRIGGERS: readonly StateTrigger[] = ['manual', 'runner', 'cron']

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
export type StateAction = string | { kind: string; field?: string }

/** One transition between two states. */
export interface StateTransition {
  /** Status the card is in. */
  from: TaskStatus
  /** Status the card moves to. */
  to: TaskStatus
  /** Who may fire it; defaults to `manual`. */
  trigger?: StateTrigger
  /** When false the card's git state is left untouched; defaults to true. */
  git?: boolean
  /** Actions fired in order when the transition runs. */
  actions?: StateAction[]
}

/** One column of the board: a state of the machine. */
export interface StateNode {
  /** The task status this column shows. */
  status: TaskStatus
  /** Human-facing column title; absent falls back to the built-in locale label. */
  label?: string
  /** Column order on the board; absent keeps the previous/declaration order. */
  order?: number
  /** Whether cards may be dropped here at all; defaults to true. */
  drop?: boolean
}

/** The declarative machine. Everything the board needs to validate and act. */
export interface StateMachineConfig {
  /** Columns to show, in board order (unless `order` says otherwise). */
  states: StateNode[]
  /** Allowed state changes with their actions. */
  transitions: StateTransition[]
  /** Status a newly created task lands in; defaults to the neutral `backlog`. */
  initial?: TaskStatus
}

/** Actions the built-in Host understands; anything else is rejected by the normalizer. */
export const STATE_ACTION_KINDS = ['git.openBranch', 'git.mergeBranch', 'run', 'stamp'] as const
/** Action kind. */
export type StateActionKind = typeof STATE_ACTION_KINDS[number]
/** Task fields the `stamp` action may write. */
export const STAMP_FIELDS = ['doneAt'] as const

/** Terse builder for the default machine's manual moves (see {@link DEFAULT_STATE_MACHINE}). */
function manual(from: TaskStatus, to: TaskStatus, actions?: StateAction[]): StateTransition {
  return { from, to, trigger: 'manual', ...(actions === undefined ? {} : { actions }) }
}

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
export const DEFAULT_STATE_MACHINE: StateMachineConfig = {
  initial: 'backlog',
  states: [
    { status: 'backlog' },
    { status: 'todo' },
    { status: 'running', drop: false },
    { status: 'ready_for_test' },
    { status: 'done' },
    { status: 'failed' },
  ],
  transitions: [
    manual('backlog', 'todo', ['git.openBranch']),    manual('backlog', 'ready_for_test'),
    manual('backlog', 'done'),
    manual('backlog', 'failed'),
    manual('todo', 'backlog'),
    manual('todo', 'ready_for_test'),
    manual('todo', 'done'),
    manual('todo', 'failed'),
    manual('ready_for_test', 'backlog'),
    manual('ready_for_test', 'todo'),
    manual('ready_for_test', 'done', ['git.mergeBranch']),
    manual('ready_for_test', 'failed'),
    manual('done', 'backlog'),
    manual('done', 'todo'),
    manual('done', 'ready_for_test'),
    manual('done', 'failed'),
    manual('failed', 'backlog'),
    manual('failed', 'todo'),
    manual('failed', 'ready_for_test'),
    manual('failed', 'done'),
    // Dropping a card straight onto "In progress" starts it (the runner's own
    // entry). The Host fires this through the `run` action — the same action
    // the detail view's Run button uses — and opens the feature branch on the
    // way when the card never passed through `todo`.
    manual('backlog', 'running', ['git.openBranch', 'run']),
    manual('todo', 'running', ['run']),
    { from: 'running', to: 'ready_for_test', trigger: 'runner' },
    { from: 'running', to: 'failed', trigger: 'runner' },
    { from: 'running', to: 'todo', trigger: 'runner' },
  ],
}

/**
 * A machine resolved from a config: the interface both the Host ledger and the
 * browser use. Instances are cheap and immutable; build one per config change.
 */
export class StateMachine {
  /** The normalized configuration this machine was built from. */
  readonly config: StateMachineConfig

  constructor(config: StateMachineConfig) {
    this.config = config
  }

  /** Columns in board order. */
  get states(): readonly StateNode[] {
    return this.config.states
  }

  /** Status of the first column, i.e. where new cards land. */
  get initialStatus(): TaskStatus {
    return this.config.initial ?? this.config.states[0]?.status ?? 'backlog'
  }

  /** Whether `status` is a configured column. */
  hasState(status: TaskStatus): boolean {
    return this.config.states.some(state => state.status === status)
  }

  /** The column definition of a status; undefined when it is not a column. */
  state(status: TaskStatus): StateNode | undefined {
    return this.config.states.find(state => state.status === status)
  }

  /** Whether a card may be dropped on this column at all. */
  acceptsDrop(status: TaskStatus): boolean {
    const state = this.state(status)
    return state !== undefined && state.drop !== false
  }

  /** The transition for `from → to` and trigger, or undefined when it is not allowed. */
  transition(from: TaskStatus, to: TaskStatus, trigger: StateTrigger = 'manual'): StateTransition | undefined {
    if (from === to) return undefined
    return this.config.transitions.find(item =>
      item.from === from && item.to === to && (item.trigger ?? 'manual') === trigger)
  }

  /** Whether `from → to` may be fired by `trigger`. The one drag-validation entry point. */
  canTransition(from: TaskStatus, to: TaskStatus, trigger: StateTrigger = 'manual'): boolean {
    return this.transition(from, to, trigger) !== undefined
  }

  /** Every status reachable from `from` with `trigger`, in declaration order. */
  targets(from: TaskStatus, trigger: StateTrigger = 'manual'): TaskStatus[] {
    return this.config.transitions
      .filter(item => item.from === from && (item.trigger ?? 'manual') === trigger)
      .map(item => item.to)
  }

  /**
   * The actions fired by `from → to`, in configured order. Empty for an
   * unknown transition — refuse the move before asking for actions.
   */
  actionsFor(from: TaskStatus, to: TaskStatus, trigger: StateTrigger = 'manual'): StateAction[] {
    return this.transition(from, to, trigger)?.actions ?? []
  }

  /** Serialized machine, for the wire and for the diagram. */
  toJSON(): StateMachineConfig {
    return this.config
  }
}

/** A config value plus the reasons it was refused; `machine` is undefined when invalid. */
export interface NormalizedStateMachine {
  machine?: StateMachine
  /** Human-readable refusals; empty when the input was accepted. */
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one action entry; undefined when it is not an action this Host knows. */
function normalizeAction(value: unknown): StateAction | undefined {
  const raw = typeof value === 'string' ? { kind: value } : value
  if (!isRecord(raw)) return undefined
  const kind = raw.kind
  if (typeof kind !== 'string' || !(STATE_ACTION_KINDS as readonly string[]).includes(kind)) return undefined
  if (kind === 'stamp') {
    const field = raw.field
    if (typeof field !== 'string' || !(STAMP_FIELDS as readonly string[]).includes(field)) return undefined
    return { kind, field }
  }
  return kind
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
export function normalizeStateMachine(value: unknown): NormalizedStateMachine {
  if (!isRecord(value)) return { errors: ['stateMachine: expected an object'] }
  const errors: string[] = []
  const rawStates = value.states
  if (!Array.isArray(rawStates) || rawStates.length === 0) {
    return { errors: ['stateMachine.states: expected a non-empty array'] }
  }

  const states: StateNode[] = []
  const seen = new Set<TaskStatus>()
  rawStates.forEach((entry, index) => {
    if (!isRecord(entry) || !isTaskStatus(entry.status)) {
      errors.push(`stateMachine.states[${index}]: unknown status`)
      return
    }
    const status = entry.status
    if (seen.has(status)) {
      errors.push(`stateMachine.states[${index}]: duplicate status ${status}`)
      return
    }
    if (entry.drop !== undefined && typeof entry.drop !== 'boolean') {
      errors.push(`stateMachine.states[${index}].drop: expected a boolean`)
      return
    }
    if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.trim() === '')) {
      errors.push(`stateMachine.states[${index}].label: expected a non-empty string`)
      return
    }
    if (entry.order !== undefined && (typeof entry.order !== 'number' || !Number.isFinite(entry.order))) {
      errors.push(`stateMachine.states[${index}].order: expected a number`)
      return
    }
    seen.add(status)
    states.push({
      status,
      ...(typeof entry.label === 'string' ? { label: entry.label.trim() } : {}),
      ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
      ...(entry.drop === false ? { drop: false } : {}),
    })
  })

  // Stable sort by `order`: columns without one keep their declared position.
  const ordered = states
    .map((state, index) => ({ state, index, order: state.order ?? index }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(item => item.state)

  const rawTransitions = value.transitions
  if (!Array.isArray(rawTransitions)) return { errors: [...errors, 'stateMachine.transitions: expected an array'] }
  const transitions: StateTransition[] = []
  const pairs = new Set<string>()
  rawTransitions.forEach((entry, index) => {
    if (!isRecord(entry) || !isTaskStatus(entry.from) || !isTaskStatus(entry.to)) {
      errors.push(`stateMachine.transitions[${index}]: from/to must be known statuses`)
      return
    }
    const from = entry.from
    const to = entry.to
    if (from === to) {
      errors.push(`stateMachine.transitions[${index}]: ${from} → ${to} is not a transition`)
      return
    }
    if (!ordered.some(state => state.status === from)) errors.push(`stateMachine.transitions[${index}].from: ${from} is not a column`)
    if (!ordered.some(state => state.status === to)) errors.push(`stateMachine.transitions[${index}].to: ${to} is not a column`)
    const rawTrigger = entry.trigger ?? 'manual'
    if (typeof rawTrigger !== 'string' || !(TRIGGERS as readonly string[]).includes(rawTrigger)) {
      errors.push(`stateMachine.transitions[${index}].trigger: expected one of ${TRIGGERS.join(', ')}`)
      return
    }
    const trigger = rawTrigger as StateTrigger
    if (entry.git !== undefined && typeof entry.git !== 'boolean') {
      errors.push(`stateMachine.transitions[${index}].git: expected a boolean`)
      return
    }
    const key = `${from}->${to}:${trigger}`
    if (pairs.has(key)) {
      errors.push(`stateMachine.transitions[${index}]: duplicate ${from} → ${to} (${trigger})`)
      return
    }
    pairs.add(key)
    const rawActions = entry.actions ?? []
    if (!Array.isArray(rawActions)) {
      errors.push(`stateMachine.transitions[${index}].actions: expected an array`)
      return
    }
    const actions: StateAction[] = []
    for (const raw of rawActions) {
      const action = normalizeAction(raw)
      if (action === undefined) {
        errors.push(`stateMachine.transitions[${index}].actions: unknown action ${JSON.stringify(raw)}`)
        return
      }
      actions.push(action)
    }
    transitions.push({
      from,
      to,
      ...(trigger === 'manual' ? {} : { trigger }),
      ...(entry.git === undefined ? {} : { git: entry.git }),
      ...(actions.length === 0 ? {} : { actions }),
    })
  })

  let initial: TaskStatus | undefined
  if (value.initial !== undefined) {
    if (!isTaskStatus(value.initial)) errors.push('stateMachine.initial: unknown status')
    else if (!ordered.some(state => state.status === value.initial)) errors.push(`stateMachine.initial: ${value.initial} is not a column`)
    else initial = value.initial
  } else if (!ordered.some(state => state.status === 'backlog')) {
    // Without an explicit `initial` the first column wins; say so rather than
    // letting the board silently drop new cards into an unexpected column.
    errors.push('stateMachine.initial: required when "backlog" is not a column')
  }

  if (errors.length > 0) return { errors }
  const config: StateMachineConfig = {
    states: ordered,
    transitions,
    ...(initial === undefined ? {} : { initial }),
  }
  return { machine: new StateMachine(config), errors: [] }
}

/**
 * Resolve a config to a machine, falling back to {@link DEFAULT_STATE_MACHINE}
 * on any refusal. The Host and the browser both call this, so "invalid config =
 * shipped machine" is one decision, not two.
 * @param value - raw config; undefined/absent uses the default machine.
 */
export function resolveStateMachine(value: unknown): { machine: StateMachine; errors: string[] } {
  if (value === undefined || value === null) return { machine: new StateMachine(DEFAULT_STATE_MACHINE), errors: [] }
  const normalized = normalizeStateMachine(value)
  if (normalized.machine === undefined) {
    return { machine: new StateMachine(DEFAULT_STATE_MACHINE), errors: normalized.errors }
  }
  return { machine: normalized.machine, errors: [] }
}

/** Short label of one action, as the diagram prints it next to the arrow. */
export function actionLabel(action: StateAction): string {
  const kind = typeof action === 'string' ? action : action.kind
  const short = kind.replace(/^git\./, '')
  return typeof action === 'string' ? short : action.field === undefined ? short : `${short} ${action.field}`
}

/**
 * Render a machine as a Mermaid `stateDiagram-v2` — the board's state engine as
 * a picture. Deterministic: same machine, same text, so a checked-in diagram
 * can be diffed against the definition (see `scripts/render-state-machine.mjs`).
 *
 * Edges are grouped by trigger: `runner`/`cron` transitions of one source state
 * share a single annotated arrow, manual ones keep their own arrow so the
 * actions hanging off them stay readable.
 */
export function renderStateMachineMermaid(machine: StateMachine): string {
  const lines: string[] = ['stateDiagram-v2']
  if (machine.config.initial !== undefined) lines.push(`    [*] --> ${machine.config.initial}`)
  lines.push(`    state "columns: ${machine.states.map(state => state.status).join(' | ')}" as columns`)
  // Manual transitions keep one arrow each (their actions are the interesting
  // part); the runner's/cron's arrows of one source state share a line.
  const grouped = new Map<string, TaskStatus[]>()
  for (const transition of machine.config.transitions) {
    const trigger = transition.trigger ?? 'manual'
    if (trigger === 'manual') {
      const actions = (transition.actions ?? []).map(actionLabel).join(', ')
      lines.push(`    ${transition.from} --> ${transition.to}: manual${actions === '' ? '' : `: ${actions}`}`)
      continue
    }
    const key = `${trigger} ${transition.from}`
    grouped.set(key, [...(grouped.get(key) ?? []), transition.to])
  }
  for (const [key, targets] of grouped) {
    const [trigger, from] = key.split(' ')
    lines.push(`    ${from} --> ${targets.join(', ')}: ${trigger}`)
  }
  return lines.join('\n')
}

/** The board's state machine as Mermaid text, ready for the diagram document. */
export const STATE_MACHINE_DIAGRAM = renderStateMachineMermaid(new StateMachine(DEFAULT_STATE_MACHINE))
