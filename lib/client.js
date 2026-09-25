window.__ModuleLoader__.load({
	id: "dsh-next-task-board",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom_client = require("react-dom/client");
		//#region src/core/state-machine.ts
		/** Every status the ledger knows, independent of any machine configuration. */
		const ALL_STATUSES$1 = [
			"backlog",
			"todo",
			"running",
			"ready_for_test",
			"done",
			"failed"
		];
		/** Brand an unknown string as a status; undefined when it is not one. */
		function isTaskStatus(value) {
			return typeof value === "string" && ALL_STATUSES$1.includes(value);
		}
		const TRIGGERS = [
			"manual",
			"runner",
			"cron"
		];
		/** Actions the built-in Host understands; anything else is rejected by the normalizer. */
		const STATE_ACTION_KINDS = [
			"git.openBranch",
			"git.mergeBranch",
			"run",
			"stamp"
		];
		/** Task fields the `stamp` action may write. */
		const STAMP_FIELDS = ["doneAt"];
		/** Terse builder for the default machine's manual moves (see {@link DEFAULT_STATE_MACHINE}). */
		function manual(from, to, actions) {
			return {
				from,
				to,
				trigger: "manual",
				...actions === void 0 ? {} : { actions }
			};
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
		const DEFAULT_STATE_MACHINE = {
			initial: "backlog",
			states: [
				{ status: "backlog" },
				{ status: "todo" },
				{
					status: "running",
					drop: false
				},
				{ status: "ready_for_test" },
				{ status: "done" },
				{ status: "failed" }
			],
			transitions: [
				manual("backlog", "todo", ["git.openBranch"]),
				manual("backlog", "ready_for_test"),
				manual("backlog", "done"),
				manual("backlog", "failed"),
				manual("todo", "backlog"),
				manual("todo", "ready_for_test"),
				manual("todo", "done"),
				manual("todo", "failed"),
				manual("ready_for_test", "backlog"),
				manual("ready_for_test", "todo"),
				manual("ready_for_test", "done", ["git.mergeBranch"]),
				manual("ready_for_test", "failed"),
				manual("done", "backlog"),
				manual("done", "todo"),
				manual("done", "ready_for_test"),
				manual("done", "failed"),
				manual("failed", "backlog"),
				manual("failed", "todo"),
				manual("failed", "ready_for_test"),
				manual("failed", "done"),
				manual("backlog", "running", ["git.openBranch", "run"]),
				manual("todo", "running", ["run"]),
				{
					from: "running",
					to: "ready_for_test",
					trigger: "runner"
				},
				{
					from: "running",
					to: "failed",
					trigger: "runner"
				},
				{
					from: "running",
					to: "todo",
					trigger: "runner"
				}
			]
		};
		/**
		* A machine resolved from a config: the interface both the Host ledger and the
		* browser use. Instances are cheap and immutable; build one per config change.
		*/
		var StateMachine = class {
			/** The normalized configuration this machine was built from. */
			config;
			constructor(config) {
				this.config = config;
			}
			/** Columns in board order. */
			get states() {
				return this.config.states;
			}
			/** Status of the first column, i.e. where new cards land. */
			get initialStatus() {
				return this.config.initial ?? this.config.states[0]?.status ?? "backlog";
			}
			/** Whether `status` is a configured column. */
			hasState(status) {
				return this.config.states.some((state) => state.status === status);
			}
			/** The column definition of a status; undefined when it is not a column. */
			state(status) {
				return this.config.states.find((state) => state.status === status);
			}
			/** Whether a card may be dropped on this column at all. */
			acceptsDrop(status) {
				const state = this.state(status);
				return state !== void 0 && state.drop !== false;
			}
			/** The transition for `from → to` and trigger, or undefined when it is not allowed. */
			transition(from, to, trigger = "manual") {
				if (from === to) return void 0;
				return this.config.transitions.find((item) => item.from === from && item.to === to && (item.trigger ?? "manual") === trigger);
			}
			/** Whether `from → to` may be fired by `trigger`. The one drag-validation entry point. */
			canTransition(from, to, trigger = "manual") {
				return this.transition(from, to, trigger) !== void 0;
			}
			/** Every status reachable from `from` with `trigger`, in declaration order. */
			targets(from, trigger = "manual") {
				return this.config.transitions.filter((item) => item.from === from && (item.trigger ?? "manual") === trigger).map((item) => item.to);
			}
			/**
			* The actions fired by `from → to`, in configured order. Empty for an
			* unknown transition — refuse the move before asking for actions.
			*/
			actionsFor(from, to, trigger = "manual") {
				return this.transition(from, to, trigger)?.actions ?? [];
			}
			/** Serialized machine, for the wire and for the diagram. */
			toJSON() {
				return this.config;
			}
		};
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		/** Parse one action entry; undefined when it is not an action this Host knows. */
		function normalizeAction(value) {
			const raw = typeof value === "string" ? { kind: value } : value;
			if (!isRecord(raw)) return void 0;
			const kind = raw.kind;
			if (typeof kind !== "string" || !STATE_ACTION_KINDS.includes(kind)) return void 0;
			if (kind === "stamp") {
				const field = raw.field;
				if (typeof field !== "string" || !STAMP_FIELDS.includes(field)) return void 0;
				return {
					kind,
					field
				};
			}
			return kind;
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
		function normalizeStateMachine(value) {
			if (!isRecord(value)) return { errors: ["stateMachine: expected an object"] };
			const errors = [];
			const rawStates = value.states;
			if (!Array.isArray(rawStates) || rawStates.length === 0) return { errors: ["stateMachine.states: expected a non-empty array"] };
			const states = [];
			const seen = /* @__PURE__ */ new Set();
			rawStates.forEach((entry, index) => {
				if (!isRecord(entry) || !isTaskStatus(entry.status)) {
					errors.push(`stateMachine.states[${index}]: unknown status`);
					return;
				}
				const status = entry.status;
				if (seen.has(status)) {
					errors.push(`stateMachine.states[${index}]: duplicate status ${status}`);
					return;
				}
				if (entry.drop !== void 0 && typeof entry.drop !== "boolean") {
					errors.push(`stateMachine.states[${index}].drop: expected a boolean`);
					return;
				}
				if (entry.label !== void 0 && (typeof entry.label !== "string" || entry.label.trim() === "")) {
					errors.push(`stateMachine.states[${index}].label: expected a non-empty string`);
					return;
				}
				if (entry.order !== void 0 && (typeof entry.order !== "number" || !Number.isFinite(entry.order))) {
					errors.push(`stateMachine.states[${index}].order: expected a number`);
					return;
				}
				seen.add(status);
				states.push({
					status,
					...typeof entry.label === "string" ? { label: entry.label.trim() } : {},
					...typeof entry.order === "number" ? { order: entry.order } : {},
					...entry.drop === false ? { drop: false } : {}
				});
			});
			const ordered = states.map((state, index) => ({
				state,
				index,
				order: state.order ?? index
			})).sort((left, right) => left.order - right.order || left.index - right.index).map((item) => item.state);
			const rawTransitions = value.transitions;
			if (!Array.isArray(rawTransitions)) return { errors: [...errors, "stateMachine.transitions: expected an array"] };
			const transitions = [];
			const pairs = /* @__PURE__ */ new Set();
			rawTransitions.forEach((entry, index) => {
				if (!isRecord(entry) || !isTaskStatus(entry.from) || !isTaskStatus(entry.to)) {
					errors.push(`stateMachine.transitions[${index}]: from/to must be known statuses`);
					return;
				}
				const from = entry.from;
				const to = entry.to;
				if (from === to) {
					errors.push(`stateMachine.transitions[${index}]: ${from} → ${to} is not a transition`);
					return;
				}
				if (!ordered.some((state) => state.status === from)) errors.push(`stateMachine.transitions[${index}].from: ${from} is not a column`);
				if (!ordered.some((state) => state.status === to)) errors.push(`stateMachine.transitions[${index}].to: ${to} is not a column`);
				const rawTrigger = entry.trigger ?? "manual";
				if (typeof rawTrigger !== "string" || !TRIGGERS.includes(rawTrigger)) {
					errors.push(`stateMachine.transitions[${index}].trigger: expected one of ${TRIGGERS.join(", ")}`);
					return;
				}
				const trigger = rawTrigger;
				if (entry.git !== void 0 && typeof entry.git !== "boolean") {
					errors.push(`stateMachine.transitions[${index}].git: expected a boolean`);
					return;
				}
				const key = `${from}->${to}:${trigger}`;
				if (pairs.has(key)) {
					errors.push(`stateMachine.transitions[${index}]: duplicate ${from} → ${to} (${trigger})`);
					return;
				}
				pairs.add(key);
				const rawActions = entry.actions ?? [];
				if (!Array.isArray(rawActions)) {
					errors.push(`stateMachine.transitions[${index}].actions: expected an array`);
					return;
				}
				const actions = [];
				for (const raw of rawActions) {
					const action = normalizeAction(raw);
					if (action === void 0) {
						errors.push(`stateMachine.transitions[${index}].actions: unknown action ${JSON.stringify(raw)}`);
						return;
					}
					actions.push(action);
				}
				transitions.push({
					from,
					to,
					...trigger === "manual" ? {} : { trigger },
					...entry.git === void 0 ? {} : { git: entry.git },
					...actions.length === 0 ? {} : { actions }
				});
			});
			let initial;
			if (value.initial !== void 0) if (!isTaskStatus(value.initial)) errors.push("stateMachine.initial: unknown status");
			else if (!ordered.some((state) => state.status === value.initial)) errors.push(`stateMachine.initial: ${value.initial} is not a column`);
			else initial = value.initial;
			else if (!ordered.some((state) => state.status === "backlog")) errors.push("stateMachine.initial: required when \"backlog\" is not a column");
			if (errors.length > 0) return { errors };
			return {
				machine: new StateMachine({
					states: ordered,
					transitions,
					...initial === void 0 ? {} : { initial }
				}),
				errors: []
			};
		}
		/**
		* Resolve a config to a machine, falling back to {@link DEFAULT_STATE_MACHINE}
		* on any refusal. The Host and the browser both call this, so "invalid config =
		* shipped machine" is one decision, not two.
		* @param value - raw config; undefined/absent uses the default machine.
		*/
		function resolveStateMachine(value) {
			if (value === void 0 || value === null) return {
				machine: new StateMachine(DEFAULT_STATE_MACHINE),
				errors: []
			};
			const normalized = normalizeStateMachine(value);
			if (normalized.machine === void 0) return {
				machine: new StateMachine(DEFAULT_STATE_MACHINE),
				errors: normalized.errors
			};
			return {
				machine: normalized.machine,
				errors: []
			};
		}
		/** Short label of one action, as the diagram prints it next to the arrow. */
		function actionLabel(action) {
			const short = (typeof action === "string" ? action : action.kind).replace(/^git\./, "");
			return typeof action === "string" ? short : action.field === void 0 ? short : `${short} ${action.field}`;
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
		function renderStateMachineMermaid(machine) {
			const lines = ["stateDiagram-v2"];
			if (machine.config.initial !== void 0) lines.push(`    [*] --> ${machine.config.initial}`);
			lines.push(`    state "columns: ${machine.states.map((state) => state.status).join(" | ")}" as columns`);
			const grouped = /* @__PURE__ */ new Map();
			for (const transition of machine.config.transitions) {
				const trigger = transition.trigger ?? "manual";
				if (trigger === "manual") {
					const actions = (transition.actions ?? []).map(actionLabel).join(", ");
					lines.push(`    ${transition.from} --> ${transition.to}: manual${actions === "" ? "" : `: ${actions}`}`);
					continue;
				}
				const key = `${trigger} ${transition.from}`;
				grouped.set(key, [...grouped.get(key) ?? [], transition.to]);
			}
			for (const [key, targets] of grouped) {
				const [trigger, from] = key.split(" ");
				lines.push(`    ${from} --> ${targets.join(", ")}: ${trigger}`);
			}
			return lines.join("\n");
		}
		renderStateMachineMermaid(new StateMachine(DEFAULT_STATE_MACHINE));
		/**
		* Repair a persisted tag list: keep the well-formed entries, trim, drop
		* blanks and repeats, cap the count, and collapse a blank prompt line to
		* "display-only". Returns undefined when nothing usable remains, so the caller
		* clears the field instead of storing an empty array.
		*/
		function normalizeTags(value) {
			if (!Array.isArray(value)) return void 0;
			const tags = [];
			const seen = /* @__PURE__ */ new Set();
			for (const entry of value) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
				const row = entry;
				if (typeof row.name !== "string") continue;
				const name = row.name.trim();
				if (name === "" || name.length > 32 || seen.has(name)) continue;
				const raw = typeof row.promptPrefix === "string" ? row.promptPrefix.trim() : "";
				const promptPrefix = raw === "" ? void 0 : raw.slice(0, 200);
				seen.add(name);
				tags.push(promptPrefix === void 0 ? { name } : {
					name,
					promptPrefix
				});
				if (tags.length >= 8) break;
			}
			return tags.length === 0 ? void 0 : tags;
		}
		/**
		* Stable palette slot (0..5) for a tag name. The same label always lands on the
		* same tone, so a badge needs no stored colour and two tasks sharing a label
		* cannot disagree about it.
		*/
		function tagTone(name) {
			let hash = 0;
			for (const char of name) hash = hash * 31 + (char.codePointAt(0) ?? 0) >>> 0;
			return hash % 6;
		}
		/**
		* Union of the labels already carried by `tasks`, first occurrence wins (the
		* oldest task's hint is the one offered). Feeds the editor's name datalist and
		* the board's tag filter, so a label defined once can be reused everywhere.
		*/
		function collectKnownTags(tasks) {
			const known = [];
			const seen = /* @__PURE__ */ new Set();
			for (const task of tasks) for (const tag of task.tags ?? []) {
				if (seen.has(tag.name)) continue;
				seen.add(tag.name);
				known.push(tag);
			}
			return known;
		}
		/** Permission presets a task may pin on its execution session (the `/permission <id>` ids). */
		const TASK_PERMISSIONS = [
			"read-only",
			"workspace-write",
			"danger-full-access"
		];
		/** Whether an unknown value is a known permission preset id. */
		function isTaskPermission(value) {
			return typeof value === "string" && TASK_PERMISSIONS.includes(value);
		}
		DEFAULT_STATE_MACHINE.states.map((state) => ({
			status: state.status,
			label: state.label ?? state.status
		}));
		/**
		* Statuses a task may be archived from: every status the ledger knows but
		* `running`, whose execution the runner still owns until it settles. A
		* settled-only gate made the duplicate-and-archive flow a silent no-op for
		* scheduled tasks, which return to `todo` after every successful run
		* (issue #1447).
		*/
		const ARCHIVABLE_STATUSES = DEFAULT_STATE_MACHINE.states.map((state) => state.status).filter((status) => status !== "running");
		DEFAULT_STATE_MACHINE.states.map((state) => state.status).filter((status) => status !== "running");
		/** Normalize one optional execution-target string: trim; blank collapses to undefined. */
		function normalizeTargetId(value) {
			const trimmed = value?.trim();
			return trimmed === void 0 || trimmed === "" ? void 0 : trimmed;
		}
		/**
		* Normalize the stored parse source: trim, and collapse a blank string to
		* undefined so "the text is gone" has exactly one representation. Like the
		* other content strings it is not length-capped here; the parse endpoint caps
		* what it is willing to read ({@link TASK_PARSE_MAX_INPUT} in the Host), and a
		* stored source that outgrew the cap simply fails that parse visibly.
		*/
		function normalizeParseText(value) {
			return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
		}
		/**
		* Longest correction note the board accepts (characters). The note is injected
		* verbatim into a prompt and copied into the ledger, so an unbounded string
		* would bloat both; the cap is generous enough for a detailed test report.
		*/
		const REWORK_NOTE_MAX_LENGTH = 4e3;
		/**
		* Normalize one optional correction note: trim, cap at
		* {@link REWORK_NOTE_MAX_LENGTH}, and collapse a blank note to undefined so an
		* empty remark can never open a rework round or reach a session.
		*/
		function normalizeReworkNote(value) {
			if (typeof value !== "string") return void 0;
			const trimmed = value.trim();
			if (trimmed === "") return void 0;
			return trimmed.length <= 4e3 ? trimmed : trimmed.slice(0, REWORK_NOTE_MAX_LENGTH).trim();
		}
		/**
		* Build the persisted freeze snapshot from a sanitized input, stamping the
		* freeze instant (shared by the create and update use cases).
		*/
		function freezeOf(input, now) {
			return {
				goal: input.goal,
				progress: input.progress,
				next: input.next,
				frozenAt: now,
				...input.redacted === true ? { redacted: true } : {},
				...input.frozenBy === void 0 || input.frozenBy === "" ? {} : { frozenBy: input.frozenBy }
			};
		}
		/** Create a task from user input. */
		function createTask(input, now, id) {
			const tags = normalizeTags(input.tags);
			const parseText = normalizeParseText(input.parseText);
			return {
				id,
				title: input.title.trim(),
				description: input.description.trim(),
				prompt: input.prompt.trim(),
				...parseText === void 0 ? {} : { parseText },
				status: input.initialStatus ?? "backlog",
				createdAt: now,
				updatedAt: now,
				executions: [],
				workspaceId: normalizeTargetId(input.workspaceId),
				mode: normalizeTargetId(input.mode),
				permission: isTaskPermission(input.permission) ? input.permission : void 0,
				model: normalizeTargetId(input.model),
				reuseSession: input.reuseSession === true ? true : void 0,
				...input.freeze === void 0 ? {} : { freeze: freezeOf(input.freeze, now) },
				...input.handover === void 0 ? {} : { handover: {
					...input.handover,
					bundledAt: now
				} },
				...tags === void 0 ? {} : { tags }
			};
		}
		/**
		* Clone a task with an updated status and a fresh updatedAt. Entering `done`
		* stamps {@link TaskRecord.doneAt} (the FIFO key of the Done-column limit);
		* leaving `done` clears it, so a card that re-enters later counts as newest.
		* A same-status move keeps the stamp, so re-dropping a card on its own column
		* cannot reorder the Done queue.
		*/
		function withStatus(task, status, now) {
			if (status === task.status) return {
				...task,
				status,
				updatedAt: now
			};
			return {
				...task,
				status,
				updatedAt: now,
				doneAt: status === "done" ? now : void 0
			};
		}
		/**
		* Merge a schedule patch into a task's schedule rule (creating it when
		* absent), with a fresh updatedAt. Keys present in the patch overwrite the
		* current value — including explicit `undefined`, which clears a field (used
		* to disarm `nextRunAt`); absent keys keep their current value.
		*/
		function withSchedule(task, patch, now) {
			const current = task.schedule;
			const schedule = {
				enabled: current?.enabled ?? false,
				cron: current?.cron ?? "",
				nextRunAt: current?.nextRunAt,
				lastTriggeredAt: current?.lastTriggeredAt
			};
			if ("enabled" in patch) schedule.enabled = patch.enabled ?? false;
			if ("cron" in patch) schedule.cron = patch.cron ?? "";
			if ("nextRunAt" in patch) schedule.nextRunAt = patch.nextRunAt;
			if ("lastTriggeredAt" in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt;
			return {
				...task,
				updatedAt: now,
				schedule
			};
		}
		/**
		* Whether a task is being executed right now: its latest run is still open AND
		* has already attached its dsh session. A card that sits in a runner-owned
		* column with an open run but no session yet is only waiting for a free WIP
		* slot (queued) — the board marks "running now" and "waiting" differently, so
		* this predicate is the single answer to which is which.
		*/
		function isTaskExecuting(task) {
			const latest = task.executions[task.executions.length - 1];
			return latest !== void 0 && latest.endedAt === void 0 && latest.sessionId !== void 0;
		}
		/**
		* When the task's current run was opened (ms epoch): the arrival key of the
		* runner-owned column's FIFO order. Falls back to the last mutation for a card
		* that carries no execution record at all.
		*/
		function runArrivalAt(task) {
			return task.executions[task.executions.length - 1]?.startedAt ?? task.updatedAt;
		}
		/**
		* Order a runner-owned (WIP) column: the card being executed now comes first —
		* the user must see what is running without hunting for it — then the queued
		* cards in arrival order, so a card dragged in later sits below the ones that
		* were already waiting and the newest arrival lands at the bottom.
		*/
		function compareWipOrder(left, right) {
			const rank = (isTaskExecuting(right) ? 1 : 0) - (isTaskExecuting(left) ? 1 : 0);
			return rank !== 0 ? rank : runArrivalAt(left) - runArrivalAt(right);
		}
		//#endregion
		//#region src/core/use-cases/task-archive.ts
		/**
		* Archive one task: only a `running` task stays on the board (its runner
		* still owns its lifecycle until the execution settles); every other status
		* can be archived. Archiving disarms a schedule; already-archived tasks are
		* a no-op.
		*/
		function applyArchiveTask(tasks, id, now) {
			let applied = false;
			return {
				tasks: tasks.map((task) => {
					if (task.id !== id || task.archivedAt !== void 0) return task;
					if (!ARCHIVABLE_STATUSES.includes(task.status)) return task;
					applied = true;
					const schedule = task.schedule === void 0 ? void 0 : {
						...task.schedule,
						enabled: false,
						nextRunAt: void 0
					};
					return {
						...task,
						...schedule === void 0 ? {} : { schedule },
						archivedAt: now,
						updatedAt: now
					};
				}),
				archived: applied
			};
		}
		/** Restore one task back onto the main board (clears the archive marker). */
		function applyRestoreTask(tasks, id, now) {
			let applied = false;
			return {
				tasks: tasks.map((task) => {
					if (task.id !== id || task.archivedAt === void 0) return task;
					applied = true;
					const { archivedAt: _archived, ...rest } = task;
					return {
						...rest,
						updatedAt: now
					};
				}),
				archived: applied
			};
		}
		//#endregion
		//#region src/core/schedule.ts
		/** Inclusive ranges per field, in cron order. */
		const FIELD_RANGES = [
			[0, 59],
			[0, 23],
			[1, 31],
			[1, 12],
			[0, 7]
		];
		/**
		* Parse a 5-field cron expression.
		* @returns the match sets, or null when the expression is invalid.
		*/
		function parseCron(expr) {
			const fields = expr.trim().split(/\s+/);
			if (fields.length !== 5) return null;
			const sets = [];
			for (let index = 0; index < 5; index++) {
				const [min, max] = FIELD_RANGES[index];
				const set = /* @__PURE__ */ new Set();
				if (!parseField(fields[index], min, max, set)) return null;
				sets.push(set);
			}
			const weekdays = /* @__PURE__ */ new Set();
			for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day);
			return {
				minutes: sets[0],
				hours: sets[1],
				days: sets[2],
				months: sets[3],
				weekdays,
				dayWildcard: fields[2] === "*",
				weekdayWildcard: fields[4] === "*"
			};
		}
		/** Whether the expression parses. */
		function isValidCron(expr) {
			return parseCron(expr) !== null;
		}
		/**
		* Compute the next matching instant after `fromMs` (ms epoch), in local time,
		* at minute granularity, strictly greater than `fromMs`. Returns the ms epoch
		* of the matching minute's start, or undefined when the calendar constraint
		* can never match (for example `0 0 30 2 *`). The five-year horizon includes
		* a full leap cycle, so a valid February 29 schedule remains reachable from
		* every non-leap year.
		*
		* Walks candidate year/month/day/hour/minute values straight from the parsed
		* field sets instead of scanning every minute: a sparse expression such as
		* `0 0 29 2 *` used to iterate ~1.5M wall-clock minutes before reaching the
		* next leap day. Wall-clock field construction + the final `matches` re-check
		* preserve the old minute scan's DST semantics exactly (nonexistent spring
		* minutes normalize forward and the repeated fall-back hour is never visited).
		*/
		function nextRunAtMs(expr, fromMs) {
			const schedule = parseCron(expr);
			if (schedule === null) return void 0;
			if (!hasPossibleCalendarDay(schedule)) return void 0;
			const from = new Date(fromMs);
			const limitMs = fromMs + 5 * 366 * 24 * 60 * 60 * 1e3;
			const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b);
			const sortedHours = [...schedule.hours].sort((a, b) => a - b);
			const sortedMonths = [...schedule.months].sort((a, b) => a - b);
			let year = from.getFullYear();
			let month = from.getMonth() + 1;
			let day = from.getDate();
			let hour = from.getHours();
			let minute = from.getMinutes() + 1;
			while (new Date(year, month - 1, 1, 0, 0, 0, 0).getTime() <= limitMs) {
				for (const candidateMonth of sortedMonths) {
					if (candidateMonth < month) continue;
					const daysInMonth = new Date(year, candidateMonth, 0).getDate();
					const dayStart = candidateMonth === month ? day : 1;
					for (let candidateDay = dayStart; candidateDay <= daysInMonth; candidateDay += 1) {
						if (!dayCandidate(schedule, new Date(year, candidateMonth - 1, candidateDay, 0, 0, 0, 0))) continue;
						const hourStart = candidateMonth === month && candidateDay === day ? hour : 0;
						for (const candidateHour of sortedHours) {
							if (candidateHour < hourStart) continue;
							const minuteStart = candidateMonth === month && candidateDay === day && candidateHour === hour ? minute : 0;
							for (const candidateMinute of sortedMinutes) {
								if (candidateMinute < minuteStart) continue;
								const candidate = new Date(year, candidateMonth - 1, candidateDay, candidateHour, candidateMinute, 0, 0);
								const time = candidate.getTime();
								if (time <= fromMs) continue;
								if (time > limitMs) return void 0;
								if (matches(schedule, candidate)) return time;
							}
						}
					}
				}
				year += 1;
				month = 1;
				day = 1;
				hour = 0;
				minute = 0;
			}
		}
		/** Day/weekday OR gate shared by {@link matches} and the candidate scan. */
		function dayCandidate(schedule, date) {
			const dayMatches = schedule.days.has(date.getDate());
			const weekdayMatches = schedule.weekdays.has(date.getDay());
			if (schedule.dayWildcard) return weekdayMatches;
			if (schedule.weekdayWildcard) return dayMatches;
			return dayMatches || weekdayMatches;
		}
		/** Reject impossible month/day pairs without spending the multi-year scan. */
		function hasPossibleCalendarDay(schedule) {
			if (schedule.dayWildcard || !schedule.weekdayWildcard) return true;
			const maximumDay = /* @__PURE__ */ new Map([
				[1, 31],
				[2, 29],
				[3, 31],
				[4, 30],
				[5, 31],
				[6, 30],
				[7, 31],
				[8, 31],
				[9, 30],
				[10, 31],
				[11, 30],
				[12, 31]
			]);
			for (const month of schedule.months) {
				const maximum = maximumDay.get(month) ?? 0;
				if ([...schedule.days].some((day) => day <= maximum)) return true;
			}
			return false;
		}
		/** Parse one comma-list field into the match set. */
		function parseField(field, min, max, out) {
			if (field === "*") {
				for (let value = min; value <= max; value++) out.add(value);
				return true;
			}
			for (const part of field.split(",")) {
				if (part === "") return false;
				const [range, stepRaw] = part.split("/");
				let low;
				let high;
				if (range === "*") {
					low = min;
					high = max;
				} else if (range.includes("-")) {
					const [a, b] = range.split("-");
					if (a === "" || b === "" || !isDigits(a) || !isDigits(b)) return false;
					low = Number(a);
					high = Number(b);
				} else if (isDigits(range)) {
					low = Number(range);
					high = stepRaw === void 0 ? low : max;
				} else return false;
				if (low < min || high > max || low > high) return false;
				const step = stepRaw === void 0 ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN;
				if (!Number.isInteger(step) || step < 1) return false;
				for (let value = low; value <= high; value += step) out.add(value);
			}
			return true;
		}
		/** Day/weekday OR semantics: a restricted day field alone gates, and vice versa. */
		function matches(schedule, date) {
			if (!schedule.minutes.has(date.getMinutes())) return false;
			if (!schedule.hours.has(date.getHours())) return false;
			if (!schedule.months.has(date.getMonth() + 1)) return false;
			return dayCandidate(schedule, date);
		}
		function isDigits(value) {
			return /^\d+$/.test(value);
		}
		//#endregion
		//#region src/core/use-cases/task-create.ts
		/**
		* Create-task use case: mint a new task from user input, rejecting a blank
		* title. Pure ledger transition (no persistence or notify — the controller
		* orchestrates those), so it is unit-testable without any runtime face.
		*/
		/**
		* Apply a create against the current ledger. Returns the new task and the
		* appended ledger, or the unchanged ledger when the title is blank.
		* @param tasks - current ledger.
		* @param input - raw user input (title/description/prompt + optional schedule).
		* @param now - clock instant (ms epoch).
		* @param id - minted task id.
		* @param initialStatus - the configured machine's initial column; absent keeps `backlog`.
		*/
		function applyCreateTask(tasks, input, now, id, initialStatus) {
			if (input.title.trim() === "") return {
				task: void 0,
				tasks
			};
			let task = createTask(initialStatus === void 0 ? input : {
				...input,
				initialStatus
			}, now, id);
			const requested = input.schedule;
			if (requested?.enabled === true && requested.cron.trim() !== "" && isValidCron(requested.cron)) {
				const cron = requested.cron.trim();
				task = withSchedule(task, {
					enabled: true,
					cron,
					nextRunAt: nextRunAtMs(cron, now)
				}, now);
			}
			return {
				task,
				tasks: [...tasks, task]
			};
		}
		//#endregion
		//#region src/core/use-cases/task-delete.ts
		/**
		* Apply a delete across the ledger. The selection (a task id) is cleared when
		* it matches the removed task, so the UI never lingers on a vanished detail.
		* @param tasks - current ledger.
		* @param selectedTaskId - the currently selected task id (may be undefined).
		* @param id - the task to remove.
		*/
		function applyDeleteTask(tasks, selectedTaskId, id) {
			return {
				tasks: tasks.filter((task) => task.id !== id),
				selectionCleared: selectedTaskId === id
			};
		}
		//#endregion
		//#region src/core/use-cases/task-schedule.ts
		/**
		* Schedule use case: arm/disarm a task's cron rule and roll a rule forward.
		* Pure ledger transitions (no persistence or notify — the controller
		* orchestrates those). Validation and next-run computation live here, sharing
		* the core cron parser (schedule.ts) and the withSchedule transition.
		*/
		/**
		* Set an on-board task's schedule rule. A blank or invalid cron, or an
		* archived task, is rejected (state untouched); an enabled rule computes the
		* next run instant immediately, a disabled one carries no next-run instant.
		* @param tasks - current ledger.
		* @param id - the task to schedule.
		* @param patch - rule fields to change (absent fields keep their current value).
		* @param now - clock instant (ms epoch).
		*/
		function applySetSchedule(tasks, id, patch, now) {
			const task = tasks.find((candidate) => candidate.id === id);
			if (task === void 0 || task.archivedAt !== void 0) return {
				tasks,
				applied: false
			};
			const current = task.schedule;
			const cron = (patch.cron ?? current?.cron ?? "").trim();
			if (cron === "" || !isValidCron(cron)) return {
				tasks,
				applied: false
			};
			const enabled = patch.enabled ?? current?.enabled ?? false;
			const nextRunAt = enabled ? nextRunAtMs(cron, now) : void 0;
			if (enabled && nextRunAt === void 0) return {
				tasks,
				applied: false
			};
			return {
				tasks: tasks.map((candidate) => candidate.id === id ? withSchedule(candidate, {
					enabled,
					cron,
					nextRunAt
				}, now) : candidate),
				applied: true
			};
		}
		/**
		* Roll a task's schedule rule forward (scheduler callback): persist the next
		* due instant and the trigger instant. No-op for tasks without a rule (deleted
		* mid-tick, for example).
		* @param tasks - current ledger.
		* @param id - the task to roll forward.
		* @param nextRunAt - next due instant (may be undefined to clear).
		* @param lastTriggeredAt - the trigger instant of this run.
		* @param now - clock instant (ms epoch).
		*/
		function applyScheduleNextRun(tasks, id, nextRunAt, lastTriggeredAt, now) {
			return tasks.map((task) => task.id === id && task.archivedAt === void 0 && task.schedule !== void 0 ? withSchedule(task, {
				nextRunAt,
				lastTriggeredAt
			}, now) : task);
		}
		//#endregion
		//#region src/core/use-cases/task-update.ts
		/**
		* Update-task use case: apply an editable-field patch (title/description/
		* prompt/the parse source plus the execution targets
		* workspaceId/mode/permission) with a fresh updatedAt. Pure ledger transition
		* (no persistence or notify — the controller orchestrates those).
		*
		* An explicit `undefined` in the patch clears the field (the task falls
		* back to the runtime default); an unknown permission string is ignored so
		* stale UI can never persist a value the execution service rejects.
		*/
		/** The fields that edit the task's content (what the user reads and what the
		* next execution sends). They stay editable while the card is still waiting in
		* a pre-execution column; once it left those columns the recorded content is
		* the record of what happened, so it becomes read-only.
		*/
		const TASK_CONTENT_FIELDS = [
			"title",
			"description",
			"prompt"
		];
		/**
		* Whether a task's content may still be edited: the task must be on-board (not
		* archived) and must still sit in one of the pre-execution columns `backlog` or
		* `todo`. Fail-closed everywhere else: a running task holds the content its
		* session reads, and once a card moved on to `ready_for_test`/`done`/`failed`
		* its content is the record of what ran.
		*
		* Earlier attempts do NOT lock the card: a task whose run failed (or was
		* cancelled) and was dragged back to `backlog`/`todo` is preparation again and
		* gets the edit form back — including the "Parse with AI" source text.
		*/
		function canEditTaskContent(task) {
			return task.archivedAt === void 0 && (task.status === "backlog" || task.status === "todo");
		}
		/** Keep an unknown permission string from entering the ledger. */
		function normalizePermission(current, value) {
			if (value === void 0) return void 0;
			return isTaskPermission(value) ? value : current;
		}
		/**
		* Apply an update across the ledger. Tasks that do not match the id are left
		* untouched; the matched task receives the patch plus a fresh updatedAt.
		* @param tasks - current ledger.
		* @param id - the task to update.
		* @param patch - editable-field changes.
		* @param now - clock instant (ms epoch).
		*/
		function applyUpdateTask(tasks, id, patch, now) {
			return tasks.map((task) => {
				if (task.id !== id) return task;
				const { freeze: freezePatch, handover: handoverPatch, tags: tagsPatch, parseText: parseTextPatch, ...rest } = patch;
				const workspaceId = "workspaceId" in patch ? normalizeTargetId(patch.workspaceId) : void 0;
				const mode = "mode" in patch ? normalizeTargetId(patch.mode) : void 0;
				const permission = "permission" in patch ? normalizePermission(task.permission, patch.permission) : void 0;
				const model = "model" in patch ? normalizeTargetId(patch.model) : void 0;
				const next = {
					...task,
					...rest,
					updatedAt: now
				};
				for (const field of TASK_CONTENT_FIELDS) {
					if (!(field in patch)) continue;
					const value = patch[field];
					next[field] = value === void 0 ? task[field] : value.trim();
				}
				if ("parseText" in patch) next.parseText = normalizeParseText(parseTextPatch);
				next.freeze = freezePatch == null ? void 0 : freezeOf(freezePatch, now);
				next.handover = handoverPatch == null ? void 0 : {
					...handoverPatch,
					bundledAt: now
				};
				if ("tags" in patch) next.tags = tagsPatch == null ? void 0 : normalizeTags(tagsPatch);
				if ("permission" in patch && patch.permission !== void 0 && patch.permission !== task.permission || "handover" in patch) next.permissionConfirmedAt = void 0;
				if ("reuseSession" in patch) next.reuseSession = patch.reuseSession === true ? true : void 0;
				if (workspaceId !== void 0 || "workspaceId" in patch) next.workspaceId = workspaceId;
				if (mode !== void 0 || "mode" in patch) next.mode = mode;
				if (permission !== void 0 || "permission" in patch) next.permission = permission;
				if (model !== void 0 || "model" in patch) next.model = model;
				return next;
			});
		}
		//#endregion
		//#region src/core/controller.ts
		function currentOf(sessions) {
			return sessions?.list.getSnapshot().current;
		}
		/** The selected task (resolved from the ledger), or undefined. */
		function selectedTaskOf(snapshot) {
			if (snapshot.selectedTaskId === void 0) return void 0;
			return snapshot.tasks.find((task) => task.id === snapshot.selectedTaskId);
		}
		function randomUuid() {
			const randomUUID = globalThis.crypto?.randomUUID;
			if (randomUUID !== void 0) return randomUUID.call(globalThis.crypto);
			const bytes = globalThis.crypto?.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
			if (bytes === void 0) return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			bytes[6] = bytes[6] & 15 | 64;
			bytes[8] = bytes[8] & 63 | 128;
			const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		/**
		* Board controller (see module doc). All mutations bump the snapshot and
		* persist through the store; UI and DOM mounts subscribe and re-render.
		*/
		var BoardController = class {
			deps;
			tasks = [];
			boardOpen = false;
			archiveView = false;
			selectedTaskId;
			executionOptions = {
				workspaces: [],
				presets: [],
				models: []
			};
			workspaceCreator;
			listeners = /* @__PURE__ */ new Set();
			disposers = [];
			now;
			uuid;
			pendingTaskIds = /* @__PURE__ */ new Set();
			taskQueues = /* @__PURE__ */ new Map();
			transportError;
			sessionOpenError;
			hostState;
			remoteSubscribed = false;
			remoteInitialization;
			/** @param deps - store and the sessions navigation face. */
			constructor(deps) {
				this.deps = deps;
				this.now = deps.now ?? (() => Date.now());
				this.uuid = deps.uuid ?? randomUuid;
			}
			/** Load the persisted ledger and start the navigation/status subscriptions. */
			start() {
				this.tasks = this.deps.store.load();
				if (this.deps.transport !== void 0) this.initializeRemote();
				const unsubscribeExternal = this.deps.transport === void 0 ? this.deps.store.subscribeExternal?.(() => {
					this.tasks = this.deps.store.load();
					this.notify();
				}) : void 0;
				if (unsubscribeExternal !== void 0) this.disposers.push(unsubscribeExternal);
				this.disposers.push(this.deps.sessions.list.subscribe(() => {
					this.onSessionsChanged();
				}));
				this.notify();
			}
			/** Stop all subscriptions and drop retained state (idempotent). */
			dispose() {
				for (const dispose of this.disposers.splice(0)) dispose();
				this.listeners.clear();
			}
			getSnapshot() {
				return {
					tasks: this.tasks,
					boardOpen: this.boardOpen,
					archiveView: this.archiveView,
					selectedTaskId: this.selectedTaskId,
					executionOptions: this.executionOptions,
					pendingTaskIds: [...this.pendingTaskIds],
					...this.workspaceCreator === void 0 ? {} : { canCreateWorkspace: true },
					...typeof this.deps.transport?.parseDraft === "function" ? { canParseTask: true } : {},
					...this.transportError === void 0 ? {} : { transportError: this.transportError },
					...this.sessionOpenError === void 0 ? {} : { sessionOpenError: this.sessionOpenError },
					...this.hostState === void 0 ? {} : { host: this.hostState }
				};
			}
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			}
			/** Whether production mutations are confirmed by the Host transport. */
			isHostBacked() {
				return this.deps.transport !== void 0;
			}
			/** Retry initial migration/state synchronization after an explicit Host error. */
			async retryHostSync() {
				return await this.initializeRemote();
			}
			openBoard() {
				if (this.boardOpen) return;
				this.boardOpen = true;
				this.notify();
			}
			closeBoard() {
				this.boardOpen = false;
				this.notify();
			}
			toggleBoard() {
				if (this.boardOpen) this.closeBoard();
				else this.openBoard();
			}
			/**
			* Switch between the kanban columns and the archive view. Leaving the
			* archive view with an archived task still selected closes the selection —
			* the detail overlay must not linger over a task that is off-board.
			*/
			toggleArchiveView() {
				this.archiveView = !this.archiveView;
				if (!this.archiveView && this.selectedTaskId !== void 0) {
					if (this.tasks.find((task) => task.id === this.selectedTaskId)?.archivedAt !== void 0) this.selectedTaskId = void 0;
				}
				this.notify();
			}
			openTask(id) {
				if (this.tasks.some((task) => task.id === id)) {
					this.selectedTaskId = id;
					this.notify();
				}
			}
			closeTask() {
				if (this.selectedTaskId === void 0) return;
				this.selectedTaskId = void 0;
				this.notify();
			}
			createTask(input) {
				const id = this.uuid();
				const { task, tasks } = applyCreateTask(this.tasks, input, this.now(), id);
				if (task === void 0) return void 0;
				this.tasks = [...tasks];
				this.persistAndNotify();
				return task;
			}
			/** Create through the Host and expose the task only after confirmation. */
			async createTaskConfirmed(input) {
				if (this.deps.transport === void 0) return this.createTask(input);
				const id = this.uuid();
				if (applyCreateTask(this.tasks, input, this.now(), id).task === void 0) return void 0;
				return await this.commitRemote({
					kind: "create",
					id,
					input
				}, id) ? this.tasks.find((task) => task.id === id) : void 0;
			}
			/**
			* Apply an editable-field patch (task content + execution targets).
			* Host-backed: the Host ledger owns the fail-closed checks (the content of
			* an executed task is read-only) and confirms the mutation, so the resolved
			* value reflects whether the Host accepted it; the legacy in-memory path
			* applies and persists synchronously.
			* @returns true when the patch was accepted by the authority.
			*/
			async updateTask(id, patch) {
				if (this.deps.transport !== void 0) return await this.commitRemote({
					kind: "update",
					taskId: id,
					patch
				}, id);
				this.tasks = [...applyUpdateTask(this.tasks, id, patch, this.now())];
				this.persistAndNotify();
				return true;
			}
			/**
			* Replace (a part of) the picker option sets the UI feeds (workspace list
			* and agent-preset roster come from the runtime, not the ledger).
			*/
			setExecutionOptions(patch) {
				this.executionOptions = {
					...this.executionOptions,
					...patch
				};
				this.notify();
			}
			/** Wire (or clear) the runtime's project registration face (issue #1536). */
			setWorkspaceCreator(creator) {
				this.workspaceCreator = creator;
				this.notify();
			}
			/**
			* Register an existing host directory as a DSH project, exactly as the GUI's
			* own "add project" does; the runtime's failure message surfaces unchanged.
			*/
			async createWorkspace(path) {
				if (this.workspaceCreator === void 0) throw new Error("workspace creation is unavailable");
				return await this.workspaceCreator(path);
			}
			/** Whether this deployment can parse pasted text into task fields (issue #1540). */
			canParseTask() {
				return typeof this.deps.transport?.parseDraft === "function";
			}
			/**
			* Parse pasted text into task fields through the Host. The transport already
			* phrases every failure for the user, so its message surfaces unchanged.
			*/
			async parseTaskDraft(request, signal) {
				const transport = this.deps.transport;
				const parse = transport?.parseDraft;
				if (transport === void 0 || parse === void 0) throw new Error("task parsing is unavailable");
				return await parse.call(transport, request, signal);
			}
			moveTask(id, status) {
				if (this.deps.transport !== void 0) {
					this.commitRemote({
						kind: "move",
						taskId: id,
						status
					}, id);
					return;
				}
				this.tasks = this.tasks.map((task) => task.id === id ? withStatus(task, status, this.now()) : task);
				this.persistAndNotify();
			}
			/**
			* Move a group of cards to one status as a single ledger action (group drag).
			* The Host validates the whole batch before writing any card, so the move is
			* all-or-nothing and the cards keep their order among themselves.
			* @param ids - the dragged cards; duplicates are ignored.
			* @param status - the target column.
			* @returns whether the Host accepted the batch (always true on the legacy
			* in-memory path); the board clears its selection on success only.
			*/
			async moveTasks(ids, status) {
				const unique = [...new Set(ids)];
				if (unique.length === 0) return true;
				if (unique.length === 1) {
					this.moveTask(unique[0], status);
					return true;
				}
				if (this.deps.transport !== void 0) return await this.commitRemote({
					kind: "move-many",
					taskIds: unique,
					status
				});
				const moving = new Set(unique);
				this.tasks = this.tasks.map((task) => moving.has(task.id) ? withStatus(task, status, this.now()) : task);
				this.persistAndNotify();
				return true;
			}
			deleteTask(id) {
				if (this.deps.transport !== void 0) {
					this.commitRemote({
						kind: "delete",
						taskId: id
					}, id);
					return;
				}
				const { tasks, selectionCleared } = applyDeleteTask(this.tasks, this.selectedTaskId, id);
				this.tasks = [...tasks];
				if (selectionCleared) this.selectedTaskId = void 0;
				this.persistAndNotify();
			}
			/**
			* Archive a task from any status but `running`, whose lifecycle the runner
			* keeps exclusive ownership of until it settles.
			* @returns true when applied.
			*/
			archiveTask(id) {
				const { tasks, archived } = applyArchiveTask(this.tasks, id, this.now());
				if (!archived) return false;
				if (this.deps.transport !== void 0) {
					this.commitRemote({
						kind: "archive",
						taskId: id
					}, id);
					return true;
				}
				this.tasks = [...tasks];
				this.persistAndNotify();
				return true;
			}
			/** Restore an archived task back onto the board (same status column). */
			restoreTask(id) {
				const { tasks, archived } = applyRestoreTask(this.tasks, id, this.now());
				if (!archived) return false;
				if (this.deps.transport !== void 0) {
					this.commitRemote({
						kind: "restore",
						taskId: id
					}, id).then((restored) => {
						if (restored && this.selectedTaskId === id) this.closeTask();
					});
					return true;
				}
				this.tasks = [...tasks];
				if (this.selectedTaskId === id) this.selectedTaskId = void 0;
				this.persistAndNotify();
				return true;
			}
			/**
			* Update a task's schedule rule. A blank or invalid cron expression is
			* rejected (returns false, state untouched). When the rule ends up enabled
			* the next run instant is computed immediately; a disabled rule carries no
			* next-run instant. Delegates the domain transition to the schedule use case.
			* @param id - the task to schedule.
			* @param patch - fields to change (absent fields keep their current value).
			* @returns true when applied, false when rejected (invalid cron / unknown task).
			*/
			setSchedule(id, patch) {
				const { tasks, applied } = applySetSchedule(this.tasks, id, patch, this.now());
				if (!applied) return false;
				if (this.deps.transport !== void 0) {
					this.commitRemote({
						kind: "set-schedule",
						taskId: id,
						patch
					}, id);
					return true;
				}
				this.tasks = [...tasks];
				this.persistAndNotify();
				return true;
			}
			/**
			* Legacy pure-controller seam retained for migration-focused tests. The
			* production browser never rolls schedules; the Host ledger owns them.
			*/
			applyScheduleNextRun(id, nextRunAt, lastTriggeredAt) {
				const next = applyScheduleNextRun(this.tasks, id, nextRunAt, lastTriggeredAt, this.now());
				this.tasks = [...next];
				this.persistAndNotify();
			}
			/**
			* Reload the legacy v1 store without notifying subscribers. Production v2
			* reads Host snapshots instead; this remains only for isolated legacy tests.
			*/
			reloadFromStore() {
				this.tasks = this.deps.store.load();
			}
			/**
			* Jump to an execution's session transcript — a live (running) session and
			* an inactive (settled) one alike. Selecting the session changes `current`,
			* which closes the board (the conversation view takes over).
			*
			* The runtime's `open` refuses any id the local session roster has not
			* pulled (`sessions.select: unknown session …`) — the normal state of an
			* older execution in a fresh tab or right after a host restart. The jump
			* therefore refreshes the host-authoritative roster once and retries before
			* it reports a failure, so an inactive session's link is never a dead
			* control just because the list was stale.
			* @param sessionId - the execution session to open.
			* @returns true when the session was selected synchronously.
			*/
			openSession(sessionId) {
				if (this.selectSession(sessionId)) return true;
				this.refreshAndSelectSession(sessionId);
				return false;
			}
			/** Clear a failed session-jump notice. */
			dismissSessionOpenError() {
				if (this.sessionOpenError === void 0) return;
				this.sessionOpenError = void 0;
				this.notify();
			}
			/** Select and close the board; false when the runtime refuses the id. */
			selectSession(sessionId) {
				try {
					this.deps.sessions.open(sessionId);
				} catch {
					return false;
				}
				this.sessionOpenError = void 0;
				this.closeBoard();
				return true;
			}
			/** Second chance for an unlisted session: refresh the roster, then retry. */
			async refreshAndSelectSession(sessionId) {
				const refresh = this.deps.sessions.refresh;
				if (refresh !== void 0) try {
					await refresh();
				} catch {}
				if (this.selectSession(sessionId)) return;
				this.sessionOpenError = `the runtime does not know ${sessionId} (id not in the session list after a refresh)`;
				this.notify();
			}
			/**
			* Request a Host execution for a task: the Host ledger owns the running
			* transition, the execution record, and the settlement. A second call
			* while the task is already running is ignored; without a Host transport
			* the run is refused (returns false).
			*/
			async runTask(id) {
				const task = this.tasks.find((candidate) => candidate.id === id);
				if (task === void 0 || task.archivedAt !== void 0 || task.status === "running") return false;
				if (this.deps.transport === void 0) return false;
				return await this.commitRemote({
					kind: "run",
					taskId: id
				}, id, currentOf(this.deps.sessions));
			}
			/**
			* Confirm a card's above-default permission binding through the Host
			* (resolves the pending-confirmation transaction; no-op otherwise).
			*/
			async confirmPermission(id) {
				if (this.tasks.find((candidate) => candidate.id === id) === void 0) return false;
				if (this.deps.transport === void 0) {
					this.tasks = this.tasks.map((candidate) => candidate.id === id ? {
						...candidate,
						permissionConfirmedAt: this.now(),
						updatedAt: this.now()
					} : candidate);
					this.persistAndNotify();
					return true;
				}
				return await this.commitRemote({
					kind: "confirm-permission",
					taskId: id
				}, id);
			}
			/** Re-run a settled task through the Host (the Host replans and executes). */
			async rerunTask(id) {
				const task = this.tasks.find((candidate) => candidate.id === id);
				if (task === void 0 || task.archivedAt !== void 0) return;
				if (this.deps.transport === void 0) return;
				await this.commitRemote({
					kind: "rerun",
					taskId: id
				}, id, currentOf(this.deps.sessions));
			}
			/**
			* Send a card back for correction: the Host moves it to `todo` (validated
			* against the state machine) and stores the reviewer's note on the card. The
			* note is not a prompt edit — the next run delivers it as its own turn in the
			* card's previous conversation. Without a Host transport the rework is
			* refused (returns false), because only the Host may write the ledger.
			*/
			async reworkTask(id, note) {
				const task = this.tasks.find((candidate) => candidate.id === id);
				if (task === void 0 || task.archivedAt !== void 0) return false;
				if (this.deps.transport === void 0) return false;
				return await this.commitRemote({
					kind: "rework",
					taskId: id,
					note
				}, id, currentOf(this.deps.sessions));
			}
			/**
			* Session-list notifications fire for all kinds of incidental churn
			* (background navigation, the Host runner creating and selecting a fresh
			* execution session, settlement, other plugins), so closing on `current`
			* changes would evict the board without the user asking. The board closes
			* only on explicit user navigation: a sidebar session/workspace row click
			* (board-mount onClickSidebarRow) or the board's own actions
			* (openSession / close). Keeping the hook preserves the subscription
			* contract for future listeners.
			*/
			onSessionsChanged() {}
			persistAndNotify() {
				if (this.deps.transport === void 0) this.deps.store.save(this.tasks);
				this.notify();
			}
			async commitRemote(action, taskId, initiator) {
				if (this.deps.transport === void 0) return true;
				if (taskId === void 0) return await this.performRemote(action, initiator);
				const operation = (this.taskQueues.get(taskId) ?? Promise.resolve()).catch(() => {}).then(async () => await this.performRemote(action, initiator));
				const tail = operation.then(() => {}, () => {});
				this.taskQueues.set(taskId, tail);
				this.pendingTaskIds.add(taskId);
				this.notify();
				try {
					return await operation;
				} finally {
					if (this.taskQueues.get(taskId) === tail) {
						this.taskQueues.delete(taskId);
						this.pendingTaskIds.delete(taskId);
						this.notify();
					}
				}
			}
			async performRemote(action, initiator) {
				const transport = this.deps.transport;
				if (transport === void 0) return true;
				this.transportError = void 0;
				this.notify();
				try {
					return this.acceptRemote(await transport.action(action, initiator)) || await this.refreshRemote();
				} catch (error) {
					await this.refreshRemote(messageOf(error));
					return false;
				}
			}
			async initializeRemote() {
				if (this.remoteInitialization !== void 0) return await this.remoteInitialization;
				const initialization = this.doInitializeRemote();
				this.remoteInitialization = initialization;
				try {
					return await initialization;
				} finally {
					if (this.remoteInitialization === initialization) this.remoteInitialization = void 0;
				}
			}
			async doInitializeRemote() {
				const transport = this.deps.transport;
				if (transport === void 0) return true;
				try {
					this.acceptRemote(await transport.bootstrap(this.tasks));
					if (!this.remoteSubscribed) {
						this.remoteSubscribed = true;
						this.disposers.push(transport.subscribe((event) => {
							this.onRemoteEvent(event);
						}));
					}
					return true;
				} catch (error) {
					this.transportError = messageOf(error);
					this.notify();
					return false;
				}
			}
			/**
			* SSE frames carry revision/scheduler/power. When the revision matches the
			* one already applied, apply the frame's scheduler/power in place and skip
			* the full /state fetch; otherwise the 5 s heartbeat would re-clone and
			* re-serialize the whole ledger per tab even while nothing changes.
			*/
			onRemoteEvent(event) {
				if (event !== void 0 && this.hostState !== void 0 && event.revision === this.hostState.revision && typeof event.scheduler === "object" && event.scheduler !== null && typeof event.power === "object" && event.power !== null) {
					this.hostState = {
						...this.hostState,
						revision: event.revision,
						scheduler: event.scheduler,
						power: event.power
					};
					this.notify();
					return;
				}
				this.refreshRemote();
			}
			async refreshRemote(preserveError) {
				const transport = this.deps.transport;
				if (transport === void 0) return true;
				try {
					this.acceptRemote(await transport.state());
					if (preserveError !== void 0) {
						this.transportError = preserveError;
						this.notify();
					}
					return true;
				} catch (error) {
					this.transportError = preserveError ?? messageOf(error);
					this.notify();
					return false;
				}
			}
			acceptRemote(snapshot) {
				if (this.hostState?.scheduler.ledgerId === snapshot.scheduler.ledgerId && this.hostState !== void 0 && snapshot.revision < this.hostState.revision) return false;
				this.tasks = [...snapshot.tasks];
				this.hostState = {
					...this.hostState,
					revision: snapshot.revision,
					scheduler: snapshot.scheduler,
					power: snapshot.power,
					...snapshot.stateMachine === void 0 ? {} : { stateMachine: snapshot.stateMachine }
				};
				this.transportError = void 0;
				if (this.selectedTaskId !== void 0 && !this.tasks.some((task) => task.id === this.selectedTaskId)) this.selectedTaskId = void 0;
				if (!this.archiveView && this.selectedTaskId !== void 0 && this.tasks.find((task) => task.id === this.selectedTaskId)?.archivedAt !== void 0) this.selectedTaskId = void 0;
				this.notify();
				return true;
			}
			notify() {
				for (const fn of [...this.listeners]) fn();
			}
		};
		/** Marker replacing every sensitive match. */
		const REDACTED_MARKER = "[REDACTED]";
		const BEGIN = "<<<FREEZE";
		const END = ">>>FREEZE";
		const SECTION_KEYS = /* @__PURE__ */ new Map([
			["目标:", "goal"],
			["进度:", "progress"],
			["下一步:", "next"]
		]);
		const SECTION_ORDER = [
			"goal",
			"progress",
			"next"
		];
		const SECTION_NAMES = {
			goal: "目标",
			progress: "进度",
			next: "下一步"
		};
		/**
		* Sensitive patterns, each matched globally over every field body:
		* PEM private key blocks (whole block collapses to one marker), Bearer
		* credentials, OpenAI sk-, GitHub ghp_, GitLab glpat-, Slack xox* tokens,
		* and AWS access key ids.
		*/
		const SENSITIVE_PATTERNS = [
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
			/Bearer\s+[A-Za-z0-9._~+\/=:-]{8,}/gi,
			/sk-[A-Za-z0-9_-]{8,}/g,
			/ghp_[A-Za-z0-9]{20,}/g,
			/glpat-[A-Za-z0-9_-]{15,}/g,
			/xox[bpars]-[A-Za-z0-9-]{10,}/g,
			/AKIA[0-9A-Z]{16}/g
		];
		function fail(code, message) {
			return {
				ok: false,
				error: {
					code,
					message
				}
			};
		}
		function utf8Bytes(text) {
			return new TextEncoder().encode(text).length;
		}
		/** Redact sensitive patterns to the marker; reports whether any hit occurred. */
		function redactSensitive(text) {
			let out = text;
			let redacted = false;
			for (const pattern of SENSITIVE_PATTERNS) {
				if (pattern.test(out)) {
					redacted = true;
					out = out.replace(pattern, REDACTED_MARKER);
				}
				pattern.lastIndex = 0;
			}
			return {
				text: out,
				redacted
			};
		}
		/**
		* True when any line of the text starts with "/" (a DSH command line).
		* Leading horizontal whitespace before the slash counts too: a frozen
		* body line like `  /kill` is still a command, not prose.
		*/
		function hasSlashCommandLines(text) {
			return text.split(/\r?\n/).some((line) => /^[ \t]+\//.test(line) || line.startsWith("/"));
		}
		/**
		* Sanitize a structured freeze snapshot (the create/update action payload):
		* shape check, slash-command taint rejection, sensitive redaction, and the
		* per-field byte cap - the same gate parseFreezeRequest applies to
		* free-text freeze requests, exposed for the action data plane (issue #4).
		* @param value - the freeze object carried by an action or read back from disk.
		* @param extraKeys - keys allowed alongside goal/progress/next (e.g. the
		*   protocol redacted flag, the ledger frozenAt stamp) and preserved verbatim
		*   when present; their validation stays with the caller.
		*/
		function sanitizeFreezeSnapshot(value, extraKeys = []) {
			const bad = (code, message) => ({
				ok: false,
				error: {
					code,
					message
				}
			});
			if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("invalid-freeze", "冻结快照必须是 goal/progress/next 字符串对象");
			const record = value;
			const allowed = [
				"goal",
				"progress",
				"next",
				...extraKeys
			];
			if (!Object.keys(record).every((key) => allowed.includes(key))) return bad("invalid-freeze", "冻结快照包含未知字段");
			for (const key of SECTION_ORDER) if (typeof record[key] !== "string") return bad("invalid-freeze", "冻结快照字段 " + SECTION_NAMES[key] + " 必须是字符串");
			for (const key of SECTION_ORDER) if (hasSlashCommandLines(record[key])) return bad("dsh-command-line", "冻结文本的" + SECTION_NAMES[key] + "包含以 / 开头的命令行，整体拒绝");
			let redacted = false;
			const snapshot = {
				goal: "",
				progress: "",
				next: ""
			};
			for (const key of SECTION_ORDER) {
				const result = redactSensitive(record[key]);
				snapshot[key] = result.text;
				redacted = redacted || result.redacted;
			}
			for (const key of SECTION_ORDER) if (utf8Bytes(snapshot[key]) > 8192) return bad("field-too-large", "冻结快照字段 " + SECTION_NAMES[key] + " 超过 8 KiB 上限");
			const extras = {};
			for (const key of extraKeys) if (key in record) extras[key] = record[key];
			return {
				ok: true,
				snapshot: {
					goal: snapshot.goal,
					progress: snapshot.progress,
					next: snapshot.next
				},
				redacted,
				extras
			};
		}
		/**
		* Parse the freeze-request format: a <<<FREEZE ... >>>FREEZE block whose body
		* is 目标: / 进度: / 下一步: section headers, each followed by body lines.
		* The gate applies before returning: slash-command taint rejects the whole
		* request, sensitive patterns are redacted to markers, and each field is
		* capped at FREEZE_FIELD_BYTE_LIMIT UTF-8 bytes.
		*/
		function parseFreezeRequest(input) {
			const beginIndex = input.indexOf(BEGIN);
			if (beginIndex === -1) return fail("missing-block", "未找到冻结请求块（需要 <<<FREEZE ... >>>FREEZE）");
			const bodyStart = beginIndex + 9;
			const endIndex = input.indexOf(END, bodyStart);
			if (endIndex === -1) return fail("unterminated-block", "冻结请求块未闭合（缺少 >>>FREEZE）");
			const block = input.slice(bodyStart, endIndex);
			const raw = /* @__PURE__ */ new Map();
			let current;
			for (const line of block.split(/\r?\n/)) {
				const key = SECTION_KEYS.get(line);
				if (key !== void 0) {
					if (raw.has(key)) return fail("duplicate-section", `重复的段落标题：${SECTION_NAMES[key]}`);
					raw.set(key, []);
					current = key;
				} else if (current !== void 0) raw.get(current).push(line);
			}
			const snapshot = {
				goal: "",
				progress: "",
				next: ""
			};
			for (const key of SECTION_ORDER) {
				if (!raw.has(key)) return fail("missing-section", `冻结请求缺少段落：${SECTION_NAMES[key]}`);
				const lines = raw.get(key);
				while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
				snapshot[key] = lines.join("\n");
			}
			for (const key of SECTION_ORDER) if (hasSlashCommandLines(snapshot[key])) return fail("dsh-command-line", `冻结文本的${SECTION_NAMES[key]}包含以 / 开头的命令行，整体拒绝`);
			let redacted = false;
			for (const key of SECTION_ORDER) {
				const result = redactSensitive(snapshot[key]);
				snapshot[key] = result.text;
				redacted = redacted || result.redacted;
			}
			for (const key of SECTION_ORDER) if (utf8Bytes(snapshot[key]) > 8192) return fail("field-too-large", `冻结快照字段 ${SECTION_NAMES[key]} 超过 8 KiB 上限`);
			return {
				ok: true,
				snapshot: {
					goal: snapshot.goal,
					progress: snapshot.progress,
					next: snapshot.next
				},
				warnings: redacted ? ["redacted"] : []
			};
		}
		/** The board's notion of the deployment session-default permission (fail-safe default). */
		const DEFAULT_SESSION_PERMISSION = "read-only";
		/** Permission elevation rank (higher = more authority). */
		const PERMISSION_RANK = /* @__PURE__ */ new Map([
			["read-only", 0],
			["workspace-write", 1],
			["danger-full-access", 2]
		]);
		function byteLength(value) {
			return new TextEncoder().encode(value).length;
		}
		/**
		* Gate a handover bundle from the wire or disk: exact keys, string targets
		* under the byte cap, a known permission, and a bounded string reference
		* list. Returns the sanitized bundle, or undefined when rejected.
		*/
		function sanitizeHandover(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
			const bundle = value;
			if (!Object.keys(bundle).every((key) => [
				"workspaceId",
				"mode",
				"permission",
				"references"
			].includes(key))) return void 0;
			if (!Array.isArray(bundle.references)) return void 0;
			if (bundle.references.length > 32) return void 0;
			let total = 0;
			for (const reference of bundle.references) {
				if (typeof reference !== "string" || reference === "") return void 0;
				const size = byteLength(reference);
				if (size > 512) return void 0;
				total += size;
				if (total > 8192) return void 0;
			}
			for (const key of ["workspaceId", "mode"]) {
				const target = bundle[key];
				if (target !== void 0 && (typeof target !== "string" || byteLength(target) > 256)) return void 0;
			}
			if (bundle.permission !== void 0 && !isTaskPermission(bundle.permission)) return void 0;
			const workspaceId = bundle.workspaceId;
			const mode = bundle.mode;
			return {
				...typeof workspaceId === "string" ? { workspaceId } : {},
				...typeof mode === "string" ? { mode } : {},
				...bundle.permission === void 0 ? {} : { permission: bundle.permission },
				references: [...bundle.references]
			};
		}
		/** The permission an execution session would actually run under. */
		function effectivePermission(task) {
			return task.handover?.permission ?? task.permission;
		}
		/** Whether a binding's permission is elevated above the session default. */
		function exceedsSessionDefault(permission, sessionDefault) {
			if (permission === void 0) return false;
			return (PERMISSION_RANK.get(permission) ?? -1) > (PERMISSION_RANK.get(sessionDefault) ?? -1);
		}
		/**
		* The confirmation-gate predicate: an elevated permission without a human
		* confirmation stamp. Manual run/rerun and cron must refuse such a card.
		*/
		function requiresPermissionConfirmation(task, sessionDefault = DEFAULT_SESSION_PERMISSION) {
			return exceedsSessionDefault(effectivePermission(task), sessionDefault) && task.permissionConfirmedAt === void 0;
		}
		//#endregion
		//#region src/core/store.ts
		/**
		* Legacy v1 browser persistence and the store seam used by pure client tests.
		*
		* Production v2 state is Host-authoritative. This backend is retained only to
		* read `dsh.taskBoard.v1` for one-time import; the old value is never removed,
		* so it remains a read-only rollback copy after migration.
		*
		* The seam keeps the backend swappable (e.g. an IndexedDB or a host-file
		* channel later); tests run against the in-memory backend and a jsdom
		* localStorage backend.
		*/
		/** Storage key for the task ledger document. */
		const DEFAULT_STORAGE_KEY = "dsh.taskBoard.v1";
		/**
		* Structural row check with the status left unvalidated (see {@link parseLedger}).
		* The `schedule` field is deliberately NOT checked here: a malformed schedule
		* never drops the task row — {@link normalizeSchedule} repairs or drops the
		* schedule alone.
		*/
		function isTaskRecordShape(value) {
			if (typeof value !== "object" || value === null) return false;
			const record = value;
			if (typeof record.id !== "string" || record.id === "") return false;
			if (typeof record.title !== "string") return false;
			if (typeof record.description !== "string") return false;
			if (typeof record.prompt !== "string") return false;
			if (record.parseText !== void 0 && typeof record.parseText !== "string") return false;
			if (typeof record.createdAt !== "number") return false;
			if (typeof record.updatedAt !== "number") return false;
			if (record.workspaceId !== void 0 && typeof record.workspaceId !== "string") return false;
			if (record.mode !== void 0 && typeof record.mode !== "string") return false;
			if (record.permission !== void 0 && typeof record.permission !== "string") return false;
			if (record.reuseSession !== void 0 && typeof record.reuseSession !== "boolean") return false;
			if (record.reworkNote !== void 0 && typeof record.reworkNote !== "string") return false;
			if (record.git !== void 0 && (typeof record.git !== "object" || record.git === null)) return false;
			if (!Array.isArray(record.executions)) return false;
			for (const execution of record.executions) {
				if (typeof execution !== "object" || execution === null) return false;
				const entry = execution;
				if (typeof entry.id !== "string") return false;
				if (entry.sessionId !== void 0 && typeof entry.sessionId !== "string") return false;
				if (typeof entry.startedAt !== "number") return false;
				if (entry.endedAt !== void 0 && typeof entry.endedAt !== "number") return false;
				if (entry.result !== void 0 && entry.result !== "succeeded" && entry.result !== "failed" && entry.result !== "cancelled") return false;
				if (entry.error !== void 0 && typeof entry.error !== "string") return false;
				if (entry.initiatedBy !== void 0 && typeof entry.initiatedBy !== "string") return false;
				if (entry.frozenBy !== void 0 && typeof entry.frozenBy !== "string") return false;
				if (entry.frozenAt !== void 0 && typeof entry.frozenAt !== "number") return false;
				if (entry.reworkNote !== void 0 && typeof entry.reworkNote !== "string") return false;
			}
			return true;
		}
		/** Normalize an unknown persisted status back into the closed status union. */
		function normalizeStatus(status) {
			return isTaskStatus(status) ? status : "todo";
		}
		/**
		* Repair a persisted schedule rule: drop rules without a usable cron string,
		* coerce booleans/numbers, and leave `nextRunAt`/`lastTriggeredAt` undefined
		* when missing (a fresh recompute or the next tick fixes them).
		*/
		function normalizeSchedule(schedule) {
			if (typeof schedule !== "object" || schedule === null) return void 0;
			const rule = schedule;
			if (typeof rule.cron !== "string") return void 0;
			if (rule.cron.trim() === "" || !isValidCron(rule.cron)) return void 0;
			return {
				enabled: rule.enabled === true,
				cron: rule.cron,
				nextRunAt: typeof rule.nextRunAt === "number" ? rule.nextRunAt : void 0,
				lastTriggeredAt: typeof rule.lastTriggeredAt === "number" ? rule.lastTriggeredAt : void 0
			};
		}
		/**
		* Repair a persisted freeze snapshot: shape + gate re-check (slash taint,
		* redaction idempotence, byte cap); a malformed or tainted snapshot is
		* dropped (undefined) rather than dropping the whole task row, mirroring
		* the schedule repair policy.
		*/
		function normalizeFreeze(value) {
			const result = sanitizeFreezeSnapshot(value, [
				"frozenAt",
				"redacted",
				"frozenBy"
			]);
			if (!result.ok) return void 0;
			const frozenAt = result.extras.frozenAt;
			if (typeof frozenAt !== "number" || !Number.isFinite(frozenAt)) return void 0;
			if (result.extras.redacted !== void 0 && result.extras.redacted !== true) return void 0;
			const frozenBy = result.extras.frozenBy;
			if (frozenBy !== void 0 && (typeof frozenBy !== "string" || frozenBy === "")) return void 0;
			return {
				goal: result.snapshot.goal,
				progress: result.snapshot.progress,
				next: result.snapshot.next,
				frozenAt,
				...result.redacted || result.extras.redacted === true ? { redacted: true } : {},
				...frozenBy === void 0 ? {} : { frozenBy }
			};
		}
		/**
		* Repair a persisted handover bundle: shape re-check through the same gate
		* as the wire path; a malformed bundle is dropped rather than dropping the
		* task row (mirroring the schedule/freeze repair policy).
		*/
		function normalizeHandover(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const { bundledAt, ...rest } = value;
			const bundle = sanitizeHandover(rest);
			if (bundle === void 0) return void 0;
			if (typeof bundledAt !== "number" || !Number.isFinite(bundledAt)) return void 0;
			return {
				...bundle,
				bundledAt
			};
		}
		/**
		* Repair a persisted git workflow state: a card without a usable branch/base/
		* worktree triple drops the field (mirroring the schedule/handover repair
		* policy), so a half-written state never sends a merge to the wrong place.
		*/
		function normalizeGit(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const row = value;
			const branch = typeof row.branch === "string" ? row.branch.trim() : "";
			const base = typeof row.base === "string" ? row.base.trim() : "";
			const repoPath = typeof row.repoPath === "string" ? row.repoPath.trim() : "";
			if (branch === "" || base === "" || repoPath === "") return void 0;
			const mergedAt = typeof row.mergedAt === "number" && Number.isFinite(row.mergedAt) ? row.mergedAt : void 0;
			return {
				branch,
				base,
				repoPath,
				...mergedAt === void 0 ? {} : { mergedAt }
			};
		}
		/** Parse + validate a persisted ledger document; invalid rows are dropped. */ function parseLedger(raw) {
			if (raw === null) return [];
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				console.error("[dsh-task-board] persisted task ledger is not valid JSON; starting empty", error);
				return [];
			}
			if (!Array.isArray(parsed)) {
				console.error("[dsh-task-board] persisted task ledger is not an array; starting empty");
				return [];
			}
			const tasks = [];
			for (const row of parsed) {
				if (!isTaskRecordShape(row)) {
					console.warn("[dsh-task-board] dropping invalid task row from persisted ledger", row);
					continue;
				}
				const task = {
					...row,
					status: normalizeStatus(row.status)
				};
				task.schedule = normalizeSchedule(row.schedule);
				task.workspaceId = normalizeTargetId(row.workspaceId);
				task.mode = normalizeTargetId(row.mode);
				task.archivedAt = typeof row.archivedAt === "number" && Number.isFinite(row.archivedAt) ? row.archivedAt : void 0;
				task.doneAt = task.status === "done" ? typeof row.doneAt === "number" && Number.isFinite(row.doneAt) ? row.doneAt : row.updatedAt : void 0;
				task.permission = isTaskPermission(row.permission) ? row.permission : void 0;
				task.reuseSession = row.reuseSession === true ? true : void 0;
				task.freeze = normalizeFreeze(row.freeze);
				task.handover = normalizeHandover(row.handover);
				task.git = normalizeGit(row.git);
				task.tags = normalizeTags(row.tags);
				task.parseText = normalizeParseText(row.parseText);
				task.permissionConfirmedAt = typeof row.permissionConfirmedAt === "number" && Number.isFinite(row.permissionConfirmedAt) ? row.permissionConfirmedAt : void 0;
				task.reworkNote = normalizeReworkNote(row.reworkNote);
				task.executions = row.executions.map((execution) => {
					const reworkNote = normalizeReworkNote(execution.reworkNote);
					return reworkNote === execution.reworkNote ? execution : {
						...execution,
						reworkNote
					};
				});
				tasks.push(task);
			}
			return tasks;
		}
		/** localStorage-backed store (the browser backend). */
		var LocalStorageTaskStore = class {
			key;
			storage;
			events;
			/**
			* @param key - storage key for the ledger document.
			* @param storage - storage backend (defaults to the global localStorage; tests inject fakes).
			* @param events - storage-event target for cross-tab notifications (defaults
			*   to the browser global; undefined in non-browser runtimes, where the
			*   subscription becomes a no-op).
			*/
			constructor(key = DEFAULT_STORAGE_KEY, storage = globalThis.localStorage, events = typeof globalThis.addEventListener === "function" ? globalThis : void 0) {
				this.key = key;
				this.storage = storage;
				this.events = events;
			}
			load() {
				if (this.storage === void 0) return [];
				try {
					return parseLedger(this.storage.getItem(this.key));
				} catch (error) {
					console.error("[dsh-task-board] task ledger read failed; starting empty", error);
					return [];
				}
			}
			save(tasks) {
				if (this.storage === void 0) return;
				try {
					this.storage.setItem(this.key, JSON.stringify(tasks));
				} catch (error) {
					console.error("[dsh-task-board] task ledger write failed (persistence skipped)", error);
				}
			}
			clear() {
				if (this.storage === void 0) return;
				try {
					this.storage.removeItem(this.key);
				} catch (error) {
					console.error("[dsh-task-board] task ledger clear failed", error);
				}
			}
			/**
			* Cross-tab change subscription (see {@link TaskStore.subscribeExternal}).
			* The browser fires the storage event in every OTHER tab of the same origin
			* when one tab writes; a null key means the whole storage was cleared. Both
			* cases reload the ledger here; unrelated keys are ignored.
			*/
			subscribeExternal(listener) {
				if (this.events === void 0) return () => {};
				const onStorage = (event) => {
					if (event.key !== null && event.key !== this.key) return;
					listener();
				};
				this.events.addEventListener("storage", onStorage);
				return () => {
					this.events?.removeEventListener("storage", onStorage);
				};
			}
		};
		//#endregion
		//#region src/client/apply-guard.ts
		/** Claims the plugin apply slot. Returns true when this call won the slot. */
		function claimTaskboardApply() {
			if (globalThis.__dshTaskboardApplied === true) return false;
			globalThis.__dshTaskboardApplied = true;
			return true;
		}
		/**
		* Releases the claim. Called from the client fiber cleanup so that a
		* hot-reloaded bundle (the loader unloads the old plugin fiber and invokes
		* the rebuilt one in the same page) can claim again instead of being
		* silently dropped.
		*/
		function releaseTaskboardApply() {
			globalThis.__dshTaskboardApplied = void 0;
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Task-board copy: zh-first dictionaries with an English fallback, selected
		* by the document language. Kept dependency-free (no dsh locale service) so
		* the DOM-injected entry row and the standalone board tree share one tiny
		* lookup.
		*/
		/** zh dictionary (key-set source of truth). */
		const zh = {
			"entry.label": "任务看板",
			"board.title": "任务看板",
			"board.close": "返回会话",
			"board.new": "新建任务",
			"board.search": "筛选任务…",
			"board.empty": "这个状态还没有任务",
			"board.filterAll": "全部",
			"board.archive": "归档",
			"board.archiveView": "归档 ({count})",
			"board.backToBoard": "返回看板",
			"archive.empty": "没有已归档的任务",
			"board.status": "状态",
			"board.status.backlog": "待规划",
			"board.status.todo": "待办",
			"board.status.running": "进行中",
			"board.status.ready_for_test": "待测试",
			"board.status.done": "已完成",
			"board.status.failed": "已失败",
			"board.runs": "次执行",
			"board.pending": "正在提交",
			"board.updated": "更新于",
			"board.created": "创建于",
			"board.hostError": "Host 操作失败：{error}",
			"board.hostError.notMounted": "任务看板的后台接口没有挂载：宿主可能没有加载该插件，也可能后台数据正被另一个 DSH 实例占用。重启 DSH 服务后再试",
			"board.hostError.unauthorized": "登录状态已失效，请刷新页面后重试",
			"board.hostError.locked": "任务看板的后台数据被占用：{detail}",
			"board.hostError.timeout": "后台 {seconds} 秒内没有响应，请稍后重试",
			"board.hostError.unreachable": "连接不上本机 DSH 服务，请确认它仍在运行",
			"board.hostError.unexpected": "后台返回了无法识别的响应（HTTP {status}）",
			"board.sessionOpenError": "会话无法打开：{error}",
			"board.dismiss": "关闭",
			"board.project": "项目",
			"board.projectAll": "全部项目",
			"board.projectNew": "新建项目…",
			"board.projectNewPath": "项目目录（宿主上的绝对路径）",
			"board.projectNewPathPlaceholder": "例如 C:\\work\\my-project 或 /home/me/project",
			"board.projectCreate": "创建项目",
			"board.projectCreateFailed": "创建项目失败：{error}",
			"new.aiParse": "AI 解析",
			"new.aiParseHint": "把从别处复制的一段话粘进来，让模型整理成标题、描述和执行 Prompt；解析结果只填进下面的表单，你可以先改再创建。",
			"new.aiParsePlaceholder": "粘贴要变成任务的内容…",
			"new.aiParseModel": "解析用模型",
			"new.aiParseRun": "解析并填入",
			"new.aiParseCancel": "取消解析",
			"new.aiParseEmpty": "先粘贴一段内容再解析",
			"new.aiParseNoModel": "这个部署还没有可用的模型，请先在 DSH 里配置模型提供商，或换一个模型再试",
			"new.aiParseUnavailable": "后台没有解析接口可用，重启 DSH 服务后再试",
			"new.aiParseTimeout": "模型 {seconds} 秒内没有返回结果，请重试或换一个更快的模型",
			"new.aiParseFailed": "解析失败：{error}",
			"board.retryHost": "重试连接 Host",
			"board.hostMeta": "Host 时区 {timeZone} · revision {revision}",
			"new.title": "标题",
			"new.titlePlaceholder": "一句话描述要做什么",
			"new.description": "描述",
			"new.descriptionPlaceholder": "补充背景、范围与验收（可选）",
			"new.prompt": "执行 Prompt",
			"new.promptPlaceholder": "发给 agent 的完整指令（留空则使用标题）",
			"new.submit": "创建",
			"new.cancel": "取消",
			"new.required": "标题不能为空",
			"new.freeze": "冻结快照（可选）",
			"new.freezePlaceholder": "粘贴会话输出的 <<<FREEZE … >>>FREEZE 冻结块，解析为目标/进度/下一步（可选）",
			"detail.freeze": "冻结快照",
			"detail.freeze.goal": "目标",
			"detail.freeze.progress": "进度",
			"detail.freeze.next": "下一步",
			"detail.freeze.frozenAt": "冻结于 {time}",
			"detail.freeze.frozenBy": "来源会话 {session}",
			"detail.freeze.redacted": "冻结文本命中敏感模式，已自动替换为 [REDACTED]；接手前请人工复核。",
			"card.frozen": "冻结",
			"card.running": "正在运行",
			"card.queued": "排队等待",
			"card.openSession": "打开会话",
			"new.handover": "交接包引用（可选）",
			"new.handoverPlaceholder": "每行一个文档/脚本引用；填写后，上面选择的钉住三元组（工作区/模式/权限）会作为交接包附加到卡片",
			"detail.handover": "交接包",
			"detail.handover.bundledAt": "打包于 {time}",
			"detail.handover.references": "引用",
			"new.tags": "标签（可选）",
			"new.tagsHint": "标签用于卡片徽章与顶栏筛选；填了「执行提示」的行会在每次执行前注入 Prompt，留空则只作展示。",
			"new.tagName": "标签名",
			"new.tagNamePlaceholder": "例如：工作",
			"new.tagPrompt": "执行提示（可选）",
			"new.tagPromptPlaceholder": "例如：产物归档到 02-工作/",
			"new.tagAdd": "添加标签",
			"new.tagRemove": "移除标签 {name}",
			"board.tagFilter": "按标签筛选",
			"board.tagFilterClear": "清除标签筛选",
			"board.selectedCount": "已选 {count} 个任务",
			"board.selectionClear": "取消选择",
			"board.dragCount": "移动 {count} 个任务",
			"board.tagEmpty": "没有同时带这些标签的任务",
			"detail.permissionPending": "权限待确认：本卡有效权限（{permission}）高于会话默认，手动执行与定时调度都会被拒绝，需人工确认后才能运行。",
			"detail.permissionConfirm": "确认权限绑定",
			"detail.permissionConfirmed": "已确认权限绑定 · {time}",
			"detail.title": "任务详情",
			"detail.edit": "编辑",
			"detail.editTags": "编辑标签",
			"detail.duplicate": "复制为新任务",
			"detail.duplicateAndEdit": "修改并新建副本",
			"detail.close": "关闭",
			"edit.title": "编辑任务",
			"edit.save": "保存",
			"edit.aiParseHint": "这是建卡时\"AI 解析\"框里的原文；改一改再点\"解析并填入\"，标题、描述和执行 Prompt 会被重新覆盖。原文已不在时，这里先用标题、描述和 Prompt 拼出一段作为起点。",
			"new.duplicateTitle": "新建任务（副本）",
			"new.archiveOriginal": "创建后归档原任务",
			"detail.prompt": "执行 Prompt",
			"detail.rework.label": "返工说明",
			"detail.rework.hint": "复核未通过时写下要修正的地方：卡片回到待办，下次执行时这段说明会作为新的一条消息追加到本卡上一次的会话里（原 Prompt 不会被改写）。",
			"detail.rework.placeholder": "例如：登录后没有跳转，报 401；请检查 token 刷新……",
			"detail.rework.send": "退回待办并记录说明",
			"detail.rework.pending": "待处理的返工说明",
			"detail.rework.pendingHint": "这段说明会在本卡下次执行时进入会话，随后从卡片上消失（执行记录里保留）。",
			"detail.execution.reworkNote": "返工说明：{note}",
			"detail.description": "描述",
			"detail.execution": "执行记录",
			"detail.noExecution": "尚未执行",
			"detail.run": "执行",
			"detail.rerun": "重新执行",
			"detail.delete": "删除",
			"detail.archive": "归档",
			"detail.restore": "恢复",
			"detail.archivedAt": "已归档 · {time}",
			"detail.viewSession": "查看会话",
			"detail.noSession": "暂无会话",
			"detail.executionStarted": "已启动",
			"detail.execution.initiator": "发起会话 {session}",
			"detail.executionEnded": "已结束",
			"detail.result.succeeded": "成功",
			"detail.result.failed": "失败",
			"detail.result.cancelled": "已取消",
			"detail.result.running": "进行中",
			"delete.title": "删除任务",
			"delete.confirm": "确定删除「{name}」吗？删除后不可恢复。",
			"delete.ok": "删除",
			"delete.cancel": "取消",
			"status.move.backlog": "移到待规划",
			"status.move.todo": "移到待办",
			"status.move.ready_for_test": "移到待测试",
			"status.move.done": "移到已完成（合并分支）",
			"exec.error.noWorkspace": "没有可用工作区，无法执行任务",
			"exec.error.promptRejected": "Prompt 被拒绝",
			"run.failed": "执行失败：{error}",
			"time.justNow": "刚刚",
			"detail.schedule": "定时运行",
			"detail.schedule.enable": "启用定时执行",
			"detail.schedule.cron": "Cron 表达式",
			"detail.schedule.presets": "预设",
			"detail.schedule.preset.daily9": "每天 09:00",
			"detail.schedule.preset.hourly": "每小时",
			"detail.schedule.preset.tenMin": "每 10 分钟",
			"detail.schedule.preset.weeklyMon9": "每周一 09:00",
			"detail.schedule.nextRun": "下次运行",
			"detail.schedule.lastTriggered": "上次触发",
			"detail.schedule.invalid": "Cron 表达式无效",
			"detail.schedule.notScheduled": "尚未排程",
			"detail.schedule.dueSoon": "即将运行",
			"card.scheduled": "定时",
			"new.workspace": "工作区",
			"new.mode": "模式",
			"new.permission": "权限",
			"new.model": "模型",
			"exec.workspace.recent": "最近使用（默认）",
			"exec.mode.default": "部署默认",
			"exec.mode.defaultSuffix": "（默认）",
			"exec.mode.brokenSuffix": "（不可用）",
			"exec.mode.removed": "（已移除）",
			"exec.permission.default": "会话默认",
			"exec.permission.read-only": "只读",
			"exec.permission.workspace-write": "工作区可写",
			"exec.permission.danger-full-access": "完全访问",
			"exec.model.default": "宿主默认（agent-default-model）",
			"exec.model.unknown": "（未知模型/回退默认）",
			"exec.reuseSession": "在同一对话继续",
			"exec.reuseSessionHint": "开启后，本任务的后续执行在上一次会话里继续（该会话空闲且仍存在时），不再每次新建对话；每次复用时都会重新应用上面钉住的权限与模型。",
			"detail.executionSettings": "执行设置",
			"exec.hint": "执行时生效：工作区决定执行会话落在哪个工作区；模式决定会话的 agent 预设；权限经 /permission 命令应用到会话。留空则使用运行时默认。",
			"settings.title": "任务看板",
			"settings.description": "控制 Host 任务看板、agent 播报与运行期间的系统空闲睡眠保护。",
			"settings.enabled": "启用任务看板",
			"settings.enabledHint": "关闭后隐藏侧边栏入口与看板视图。",
			"settings.announceToAgent": "向 agent 播报任务看板",
			"settings.announceToAgentHint": "开启：每条 agent 系统提示都会包含本看板的说明；关闭：不播报，agent 仅在用户主动提及时了解看板。",
			"settings.preventIdleSleep": "阻止系统空闲睡眠",
			"settings.preventIdleSleepHint": "默认关闭。开启后，只要存在运行中的 DSH 会话、已启用的定时任务或会话状态尚未确认，Host 就阻止整机因空闲睡眠；屏幕仍可自动关闭。",
			"settings.maxConcurrentRuns": "每个工作区的最大并发运行数（WIP）",
			"settings.maxConcurrentRunsHint": "默认 1：同一工作区一次只运行一个任务，其余按先来后到排队，名额空出后自动启动下一个；不同工作区互不影响、可并行。",
			"settings.maxDoneTasks": "已完成列上限（N）",
			"settings.maxDoneTasksHint": "默认 9：卡片移入已完成且超出上限时，自动把最早进入已完成的卡片（FIFO）归档到归档视图，只归档到刚好满足上限为止；调低上限或 Host 启动时同样立即归档超出部分。归档只移出看板、不删除，随时可恢复；该上限只作用于已完成列。",
			"settings.stateMachine": "状态机（JSON）",
			"settings.stateMachineHint": "看板的列就是任务状态。这里声明列（states）、允许的状态转移（transitions）以及转移时触发的动作（actions：git.openBranch 开 feature 分支、git.mergeBranch 合并回基线分支、run 启动执行、stamp 写时间戳）。拖放只允许已声明的转移；留空使用内置状态机（待规划 → 待办 → 进行中 → 待测试 → 已完成/已失败）。配置无效时整份拒绝，继续沿用当前状态机，并在卡片上显示原因。语法示例：{\"states\":[{\"status\":\"backlog\"},{\"status\":\"todo\"},{\"status\":\"running\",\"drop\":false},{\"status\":\"ready_for_test\"},{\"status\":\"done\"}],\"transitions\":[{\"from\":\"backlog\",\"to\":\"todo\",\"actions\":[\"git.openBranch\"]},{\"from\":\"ready_for_test\",\"to\":\"done\",\"actions\":[\"git.mergeBranch\"]}],\"initial\":\"backlog\"}",
			"settings.powerStatus": "平台：{platform}；保护状态：{phase}；运行会话：{running}；已启用计划：{schedules}",
			"settings.powerBoundary": "这可能增加电池消耗。合盖、手动睡眠、休眠、关机、低电量或企业策略不在保证范围内，也不会唤醒已经睡眠的机器。",
			"settings.powerUnknown": "未知",
			"settings.powerError": "最近一次电源保护错误：{error}",
			"settings.inherit": "继承",
			"settings.on": "开",
			"settings.off": "关",
			"settings.overridden": "已覆盖",
			"settings.reset": "恢复默认",
			"settings.notExposed": "当前 DSH 版本未向设置页暴露本插件的配置命名空间，表单不可用。可编辑 ~/.dsh/settings.yaml 直接配置，或将本命名空间加入 Host 设置白名单后重启。",
			"settings.readOnly": "当前部署的设置只读。",
			"settings.expand": "展开设置",
			"settings.collapse": "收起设置",
			"settings.save": "保存",
			"settings.saving": "保存中…",
			"settings.discard": "放弃",
			"settings.unsaved": "未保存",
			"settings.saveFailed": "部署未接受这些值，已保留供你修改。",
			"settings.invalidNumber": "请输入数字，留空则使用默认值。"
		};
		/** en dictionary, complete against the zh key set. */
		const en = {
			"entry.label": "Task Board",
			"board.title": "Task Board",
			"board.close": "Back to chat",
			"board.new": "New Task",
			"board.search": "Filter tasks…",
			"board.empty": "No tasks in this column",
			"board.filterAll": "All",
			"board.archive": "Archive",
			"board.archiveView": "Archived ({count})",
			"board.backToBoard": "Back to board",
			"archive.empty": "No archived tasks",
			"board.status": "Status",
			"board.status.backlog": "Backlog",
			"board.status.todo": "To Do",
			"board.status.running": "In Progress",
			"board.status.ready_for_test": "Ready for test",
			"board.status.done": "Done",
			"board.status.failed": "Failed",
			"board.runs": "runs",
			"board.pending": "Submitting",
			"board.updated": "Updated",
			"board.created": "Created",
			"board.hostError": "Host action failed: {error}",
			"board.hostError.notMounted": "The task board Host API is not mounted: the Host may not have loaded the plugin, or another DSH instance holds the ledger. Restart the DSH service and try again",
			"board.hostError.unauthorized": "This session is no longer signed in; reload the page and try again",
			"board.hostError.locked": "The task board ledger is locked: {detail}",
			"board.hostError.timeout": "The Host did not answer within {seconds}s; try again shortly",
			"board.hostError.unreachable": "Cannot reach the local DSH service; make sure it is still running",
			"board.hostError.unexpected": "The Host returned an unrecognized response (HTTP {status})",
			"board.sessionOpenError": "The session could not be opened: {error}",
			"board.dismiss": "Dismiss",
			"board.project": "Project",
			"board.projectAll": "All projects",
			"board.projectNew": "New project…",
			"board.projectNewPath": "Project directory (absolute path on the Host)",
			"board.projectNewPathPlaceholder": "e.g. C:\\work\\my-project or /home/me/project",
			"board.projectCreate": "Create project",
			"board.projectCreateFailed": "Could not create the project: {error}",
			"new.aiParse": "Parse with AI",
			"new.aiParseHint": "Paste text copied from somewhere else and let a model turn it into a title, description, and run prompt; the result only fills the form below, so you can edit it before creating the task.",
			"new.aiParsePlaceholder": "Paste the content to turn into a task…",
			"new.aiParseModel": "Model used for parsing",
			"new.aiParseRun": "Parse and fill",
			"new.aiParseCancel": "Cancel parsing",
			"new.aiParseEmpty": "Paste something to parse first",
			"new.aiParseNoModel": "This deployment has no model available; configure a model provider in DSH or pick another model",
			"new.aiParseUnavailable": "The Host has no parse endpoint; restart the DSH service and try again",
			"new.aiParseTimeout": "The model did not answer within {seconds}s; try again or pick a faster model",
			"new.aiParseFailed": "Parsing failed: {error}",
			"board.retryHost": "Retry Host connection",
			"board.hostMeta": "Host time zone {timeZone} · revision {revision}",
			"new.title": "Title",
			"new.titlePlaceholder": "What should be done, in one line",
			"new.description": "Description",
			"new.descriptionPlaceholder": "Background, scope, acceptance criteria (optional)",
			"new.prompt": "Run Prompt",
			"new.promptPlaceholder": "The full instruction sent to the agent (title is used when blank)",
			"new.submit": "Create",
			"new.cancel": "Cancel",
			"new.required": "Title is required",
			"new.freeze": "Frozen snapshot (optional)",
			"new.freezePlaceholder": "Paste a <<<FREEZE ... >>>FREEZE block from a session; it parses into goal/progress/next (optional)",
			"detail.freeze": "Frozen snapshot",
			"detail.freeze.goal": "Goal",
			"detail.freeze.progress": "Progress",
			"detail.freeze.next": "Next",
			"detail.freeze.frozenAt": "Frozen at {time}",
			"detail.freeze.frozenBy": "Source session {session}",
			"detail.freeze.redacted": "Sensitive patterns were detected in the frozen text and replaced with [REDACTED]; review manually before resuming.",
			"card.frozen": "frozen",
			"card.running": "Running now",
			"card.queued": "Queued",
			"card.openSession": "Open session",
			"new.handover": "Handover references (optional)",
			"new.handoverPlaceholder": "One doc/script reference per line; when filled, the pinned triplet picked above (workspace/mode/permission) is attached to the card as a handover bundle",
			"detail.handover": "Handover bundle",
			"detail.handover.bundledAt": "Bundled at {time}",
			"detail.handover.references": "References",
			"new.tags": "Tags (optional)",
			"new.tagsHint": "Tags drive the card badges and the board filter; a row with an execution hint is injected ahead of the prompt on every run, an empty one is display-only.",
			"new.tagName": "Tag name",
			"new.tagNamePlaceholder": "e.g. Work",
			"new.tagPrompt": "Execution hint (optional)",
			"new.tagPromptPlaceholder": "e.g. Archive artefacts under 02-work/",
			"new.tagAdd": "Add tag",
			"new.tagRemove": "Remove tag {name}",
			"board.tagFilter": "Filter by tag",
			"board.tagFilterClear": "Clear tag filter",
			"board.selectedCount": "{count} selected",
			"board.selectionClear": "Clear selection",
			"board.dragCount": "Moving {count} tasks",
			"board.tagEmpty": "No task carries all of these tags",
			"detail.permissionPending": "Permission pending confirmation: this card's effective permission ({permission}) is above the session default; manual runs and cron are refused until a human confirms.",
			"detail.permissionConfirm": "Confirm permission binding",
			"detail.permissionConfirmed": "Permission confirmed · {time}",
			"detail.title": "Task Detail",
			"detail.edit": "Edit",
			"detail.editTags": "Edit tags",
			"detail.duplicate": "Duplicate Task",
			"detail.duplicateAndEdit": "Edit as New Copy",
			"detail.close": "Close",
			"edit.title": "Edit Task",
			"edit.save": "Save",
			"edit.aiParseHint": "The text the card's \"Parse with AI\" box was filled with; edit it and hit \"Parse and fill\" to overwrite title, description, and run prompt again. When it is gone, it starts from the title, description, and prompt.",
			"new.duplicateTitle": "New Task (Copy)",
			"new.archiveOriginal": "Archive original task upon creation",
			"detail.prompt": "Run Prompt",
			"detail.rework.label": "Correction note",
			"detail.rework.hint": "When the review did not pass, write down what has to be fixed: the card goes back to To Do, and the next run appends this note to the card's previous conversation as a new message (the original prompt is never rewritten).",
			"detail.rework.placeholder": "e.g. after login there is no redirect and the request returns 401; check the token refresh…",
			"detail.rework.send": "Send back to To Do with note",
			"detail.rework.pending": "Pending correction note",
			"detail.rework.pendingHint": "This note enters the conversation on the card's next run and then leaves the card (the execution record keeps it).",
			"detail.execution.reworkNote": "Correction note: {note}",
			"detail.description": "Description",
			"detail.execution": "Execution History",
			"detail.noExecution": "Not executed yet",
			"detail.run": "Run",
			"detail.rerun": "Run Again",
			"detail.delete": "Delete",
			"detail.archive": "Archive",
			"detail.restore": "Restore",
			"detail.archivedAt": "Archived · {time}",
			"detail.viewSession": "View Session",
			"detail.noSession": "No session",
			"detail.executionStarted": "Started",
			"detail.execution.initiator": "Initiated by session {session}",
			"detail.executionEnded": "Ended",
			"detail.result.succeeded": "Succeeded",
			"detail.result.failed": "Failed",
			"detail.result.cancelled": "Cancelled",
			"detail.result.running": "Running",
			"delete.title": "Delete Task",
			"delete.confirm": "Delete \"{name}\"? This cannot be undone.",
			"delete.ok": "Delete",
			"delete.cancel": "Cancel",
			"status.move.backlog": "Move to Backlog",
			"status.move.todo": "Move to To Do",
			"status.move.ready_for_test": "Move to Ready for test",
			"status.move.done": "Move to Done (merge branch)",
			"exec.error.noWorkspace": "No workspace is available to run the task",
			"exec.error.promptRejected": "Prompt rejected",
			"run.failed": "Run failed: {error}",
			"time.justNow": "just now",
			"detail.schedule": "Scheduled Runs",
			"detail.schedule.enable": "Enable scheduled runs",
			"detail.schedule.cron": "Cron expression",
			"detail.schedule.presets": "Presets",
			"detail.schedule.preset.daily9": "Every day 09:00",
			"detail.schedule.preset.hourly": "Every hour",
			"detail.schedule.preset.tenMin": "Every 10 minutes",
			"detail.schedule.preset.weeklyMon9": "Every Monday 09:00",
			"detail.schedule.nextRun": "Next run",
			"detail.schedule.lastTriggered": "Last triggered",
			"detail.schedule.invalid": "Invalid cron expression",
			"detail.schedule.notScheduled": "Not scheduled yet",
			"detail.schedule.dueSoon": "Due soon",
			"card.scheduled": "scheduled",
			"new.workspace": "Workspace",
			"new.mode": "Mode",
			"new.permission": "Permission",
			"new.model": "Model",
			"exec.workspace.recent": "Most recent (default)",
			"exec.mode.default": "Deployment default",
			"exec.mode.defaultSuffix": " (default)",
			"exec.mode.brokenSuffix": " (unavailable)",
			"exec.mode.removed": " (removed)",
			"exec.permission.default": "Session default",
			"exec.permission.read-only": "Read-only",
			"exec.permission.workspace-write": "Workspace Write",
			"exec.permission.danger-full-access": "Full Access",
			"exec.model.default": "Host default (agent-default-model)",
			"exec.model.unknown": " (unknown / fallback to default)",
			"exec.reuseSession": "Continue in the same conversation",
			"exec.reuseSessionHint": "When on, later runs continue in the previous session (when that session is idle and still exists) instead of starting a new conversation each time; the pinned permission and model above are re-applied on every reuse.",
			"detail.executionSettings": "Execution Settings",
			"exec.hint": "Applied when the task runs: the workspace decides where the execution session lands; the mode composes the session's agent preset; the permission is applied through the /permission command. Blank = runtime default.",
			"settings.title": "Task Board",
			"settings.description": "Configure the Host task board, agent announcement, and idle-system-sleep protection while work is pending.",
			"settings.enabled": "Enable the task board",
			"settings.enabledHint": "When off, the sidebar entry and board view are hidden.",
			"settings.announceToAgent": "Announce the task board to agents",
			"settings.announceToAgentHint": "On: every agent system prompt includes a note about this board. Off: no announcement; agents learn about the board only when you mention it.",
			"settings.preventIdleSleep": "Prevent idle system sleep",
			"settings.preventIdleSleepHint": "Off by default. When enabled, the Host prevents idle system sleep while any DSH session runs, any schedule is enabled, or session state is not yet known. The display may still turn off.",
			"settings.maxConcurrentRuns": "Maximum concurrent runs per workspace (WIP)",
			"settings.maxConcurrentRunsHint": "Default 1: one workspace runs one task at a time; further runs of that workspace wait in arrival order and start as soon as a running task settles and frees a slot. Other workspaces are unaffected and run in parallel.",
			"settings.maxDoneTasks": "Done column limit (N)",
			"settings.maxDoneTasksHint": "Default 9: when a card is moved into Done and the column would exceed the limit, the cards that have been in Done longest (FIFO) are archived — just enough to satisfy the limit; lowering the limit or starting the Host also trims the surplus right away. Archiving only takes them off the board (never deletes), and they can be restored from the archive view; the limit applies to the Done column only.",
			"settings.stateMachine": "State machine (JSON)",
			"settings.stateMachineHint": "The board's columns are the task states. This declares the columns (states), the allowed state transitions (transitions), and the actions a transition fires (actions: git.openBranch opens the feature branch, git.mergeBranch merges it back, run starts an execution, stamp writes a timestamp). A drag & drop is only allowed for a declared transition; leave empty for the built-in machine (Backlog → To Do → In progress → Ready for test → Done/Failed). An invalid config is refused as a whole — the machine in force stays and the card shows why. Example: {\"states\":[{\"status\":\"backlog\"},{\"status\":\"todo\"},{\"status\":\"running\",\"drop\":false},{\"status\":\"ready_for_test\"},{\"status\":\"done\"}],\"transitions\":[{\"from\":\"backlog\",\"to\":\"todo\",\"actions\":[\"git.openBranch\"]},{\"from\":\"ready_for_test\",\"to\":\"done\",\"actions\":[\"git.mergeBranch\"]}],\"initial\":\"backlog\"}",
			"settings.powerStatus": "Platform: {platform}; protection: {phase}; running sessions: {running}; enabled schedules: {schedules}",
			"settings.powerBoundary": "This may use more battery. Lid close, manual sleep, hibernation, shutdown, low-battery actions, and enterprise policy are outside the guarantee; an already sleeping computer is not woken.",
			"settings.powerUnknown": "unknown",
			"settings.powerError": "Latest power-protection error: {error}",
			"settings.inherit": "Inherit",
			"settings.on": "On",
			"settings.off": "Off",
			"settings.overridden": "Overridden",
			"settings.reset": "Reset to default",
			"settings.notExposed": "This DSH version does not expose this plugin's settings namespace to the configuration page, so the form is unavailable. Edit ~/.dsh/settings.yaml directly, or add the namespace to the Host settings allowlist and restart.",
			"settings.readOnly": "This deployment stores settings read-only.",
			"settings.expand": "Show settings",
			"settings.collapse": "Hide settings",
			"settings.save": "Save",
			"settings.saving": "Saving…",
			"settings.discard": "Discard",
			"settings.unsaved": "Unsaved",
			"settings.saveFailed": "The deployment did not accept these values; they were left for you to correct.",
			"settings.invalidNumber": "Enter a number, or leave blank to use the default."
		};
		/** Active dictionary, picked by the document language at call time. */
		function dictionary() {
			return (typeof document !== "undefined" ? document.documentElement.lang : "zh").toLowerCase().startsWith("en") ? en : zh;
		}
		/**
		* SDK translate seat wired by the browser apply() once ctx.locale is bound
		* (setRuntimeTranslate). When present it reads the ACTIVE locale at call
		* time, so plain-DOM surfaces (sidebar row, toggles) follow a runtime
		* language switch; the document-language pick above stays only as the
		* unwired fallback (locale service absent, module-scope early callers).
		*/
		let runtimeT;
		/** Wire the SDK translate seat; pass undefined to restore the document-language pick. */
		function setRuntimeTranslate(t) {
			runtimeT = t;
		}
		/** Translate a key with optional {name} template params. */
		function t(key, params) {
			if (runtimeT !== void 0) return runtimeT(key, params);
			let text = dictionary()[key];
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value);
			return text;
		}
		//#endregion
		//#region \0dsh-css:src/client/board.module.css.mjs
		const css$1 = "[data-pane=conversation],[class*=centerCol]{position:relative}[data-dsh-taskboard-view]{z-index:60;background:var(--dsw-alias-bg-base);display:none;position:absolute;inset:0;container:Sr3ygG_task-board-view/inline-size}html[data-dsh-taskboard-active]:not([data-dsh-ssh-active]) [data-dsh-taskboard-view]{display:block}html[data-dsh-taskboard-active]:not([data-dsh-ssh-active]) [data-pane=conversation]>:not([data-dsh-taskboard-view]),html[data-dsh-taskboard-active]:not([data-dsh-ssh-active]) [class*=centerCol]>:not([data-dsh-taskboard-view]){display:none!important}.Sr3ygG_entry{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 10px;font-size:13px;display:flex}.Sr3ygG_entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Sr3ygG_entry[data-active]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}.Sr3ygG_entryIcon{flex:none;justify-content:center;align-items:center;width:24px;height:24px;display:inline-flex}.Sr3ygG_entryIcon svg{width:18px;height:18px;display:block}.Sr3ygG_entryLabel{text-overflow:ellipsis;overflow:hidden}[data-dsh-frame][data-sidebar-collapsed] .Sr3ygG_entry,[data-sidebar-collapsed] .Sr3ygG_entry{border-radius:50%;justify-content:center;width:36px;height:36px;margin:0 auto 12px;padding:0}[data-dsh-frame][data-sidebar-collapsed] .Sr3ygG_entryLabel,[data-sidebar-collapsed] .Sr3ygG_entryLabel{display:none}.Sr3ygG_board{box-sizing:border-box;background:var(--dsw-alias-bg-base);min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;gap:12px;padding:14px 16px 16px;display:flex}.Sr3ygG_boardHeader{flex:none;align-items:center;gap:10px;display:flex}.Sr3ygG_boardTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;margin:0;font-size:16px;font-weight:700}.Sr3ygG_backButton{align-items:center;gap:4px;display:inline-flex}.Sr3ygG_search{min-width:120px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;flex:0 260px;padding:6px 10px;font-size:13px}.Sr3ygG_search::placeholder{color:var(--dsw-alias-label-tertiary)}.Sr3ygG_columns{overscroll-behavior-inline:contain;scrollbar-color:var(--dsw-alias-border-l3) var(--dsw-alias-interactive-bg-hover);scrollbar-width:thin;flex:1;grid-auto-columns:minmax(220px,1fr);grid-auto-flow:column;gap:12px;min-height:0;padding-bottom:6px;display:grid;overflow:auto hidden}.Sr3ygG_columns::-webkit-scrollbar{height:10px}.Sr3ygG_columns::-webkit-scrollbar-track{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px}.Sr3ygG_columns::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);background-clip:content-box;border:2px solid #0000;border-radius:999px}.Sr3ygG_columns::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l4);background-clip:content-box}.Sr3ygG_column{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex-direction:column;min-height:0;display:flex;overflow:hidden}.Sr3ygG_columnHeader{flex:none;align-items:center;gap:6px;padding:10px 12px;display:flex}.Sr3ygG_columnTitle{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;margin:0;font-size:13px;font-weight:700;overflow:hidden}.Sr3ygG_columnCount{min-width:0;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;flex:none;padding:1px 8px;font-size:12px}.Sr3ygG_statusDot{border-radius:50%;flex:none;width:8px;height:8px}.Sr3ygG_statusDot[data-status=backlog]{background:var(--dsw-alias-label-tertiary)}.Sr3ygG_statusDot[data-status=todo]{background:var(--dsw-alias-state-business-primary)}.Sr3ygG_statusDot[data-status=running]{background:var(--dsw-alias-state-warn-primary)}.Sr3ygG_statusDot[data-status=ready_for_test]{background:var(--dsw-alias-state-warn-secondary)}.Sr3ygG_statusDot[data-status=done]{background:var(--dsw-alias-state-success-primary)}.Sr3ygG_statusDot[data-status=failed]{background:var(--dsw-alias-state-error-primary)}.Sr3ygG_cards{flex-direction:column;flex:1;gap:8px;min-height:0;padding:2px 8px 10px;display:flex;overflow-y:auto}.Sr3ygG_columnEmpty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:24px 8px;font-size:12px}.Sr3ygG_cardBox{flex-direction:column;display:flex;position:relative}.Sr3ygG_card{box-sizing:border-box;text-align:left;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;width:100%;color:var(--dsw-alias-label-primary);border-radius:10px;flex-direction:column;gap:6px;padding:10px 12px;font-family:inherit;transition:box-shadow .12s,border-color .12s,transform .12s;display:flex}.Sr3ygG_card[data-has-session]{padding-right:30px}.Sr3ygG_card:hover{box-shadow:var(--dsw-shadow-lv2);border-color:var(--dsw-alias-border-l3);transform:translateY(-1px)}.Sr3ygG_card[data-status=running]{border-color:var(--dsw-alias-state-warn-primary)}.Sr3ygG_card[data-executing=true]{border:2px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);box-shadow:0 0 0 2px var(--dsw-alias-state-warn-primary);padding:9px 11px;animation:1.6s ease-in-out infinite Sr3ygG_dshTbRunningPulse}.Sr3ygG_card[data-executing=true][data-has-session]{padding-right:29px}@keyframes Sr3ygG_dshTbRunningPulse{0%,to{box-shadow:0 0 0 2px var(--dsw-alias-state-warn-primary)}50%{box-shadow:0 0 0 5px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, transparent)}}.Sr3ygG_card[data-selected=true]{border-color:var(--dsw-alias-button-info-fill);background:color-mix(in srgb, var(--dsw-alias-button-info-fill) 12%, var(--dsw-alias-bg-base));box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-button-info-fill) 38%, transparent)}.Sr3ygG_card[data-dragging=true]{opacity:.55}.Sr3ygG_dragBadge{z-index:40;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);box-shadow:var(--dsw-shadow-lv3);pointer-events:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:600;position:fixed;top:16px;left:50%;transform:translate(-50%)}.Sr3ygG_selectionBar{border:1px solid var(--dsw-alias-button-info-fill);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);white-space:nowrap;border-radius:999px;align-items:center;gap:8px;padding:4px 10px;font-size:12px;display:inline-flex}.Sr3ygG_cardTitle{-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:13px;font-weight:600;line-height:1.35;display:-webkit-box;overflow:hidden}.Sr3ygG_cardExcerpt{color:var(--dsw-alias-label-secondary);-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:12px;line-height:1.4;display:-webkit-box;overflow:hidden}.Sr3ygG_cardMeta{color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;font-size:11px;display:flex}.Sr3ygG_cardTime{text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}.Sr3ygG_cardSchedule{white-space:nowrap;min-width:0;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;flex:none;padding:2px 6px;font-size:12px;line-height:1}.Sr3ygG_cardRun{flex:none}.Sr3ygG_cardRun[data-result=failed]{color:var(--dsw-alias-state-error-primary)}.Sr3ygG_cardRun[data-result=succeeded]{color:var(--dsw-alias-state-success-primary)}.Sr3ygG_cardSession{color:var(--dsw-alias-state-business-primary);justify-content:center;align-items:center;padding:1px;font-size:16px;line-height:1;text-decoration:none;display:inline-flex;position:absolute;bottom:8px;right:8px}.Sr3ygG_cardSession:hover{color:var(--dsw-alias-label-primary)}.Sr3ygG_cardRunningLabel{color:var(--dsw-alias-state-warn-primary);font-size:11px}.Sr3ygG_cardExecutingBadge{border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:999px;align-self:flex-start;padding:1px 8px;font-size:11px;font-weight:600;line-height:16px}.Sr3ygG_cardSpinner{border:2px solid var(--dsw-alias-state-warn-primary);border-top-color:#0000;border-radius:50%;flex:none;width:10px;height:10px;animation:.8s linear infinite Sr3ygG_dshTbSpin}@keyframes Sr3ygG_dshTbSpin{to{transform:rotate(360deg)}}.Sr3ygG_primaryButton{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-info-fill);cursor:pointer;white-space:nowrap;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600}.Sr3ygG_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}.Sr3ygG_primaryButton:disabled{opacity:.5;cursor:default}.Sr3ygG_ghostButton{color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;white-space:nowrap;background:0 0;border-radius:8px;padding:5px 12px;font-size:12px}.Sr3ygG_ghostButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.Sr3ygG_ghostButton:disabled{opacity:.45;cursor:default}.Sr3ygG_dangerButton{color:#fff;background:var(--dsw-alias-state-error-primary);cursor:pointer;white-space:nowrap;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600}.Sr3ygG_dangerButton:hover:not(:disabled){filter:brightness(1.08)}.Sr3ygG_dangerButton:active:not(:disabled){filter:brightness(.94)}.Sr3ygG_dangerButton:disabled{opacity:.5;cursor:default}.Sr3ygG_iconButton{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;padding:0;font-size:13px;display:inline-flex}.Sr3ygG_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Sr3ygG_linkButton{color:var(--dsw-alias-state-business-primary);cursor:pointer;white-space:nowrap;background:0 0;border:none;padding:0;font-size:12px}.Sr3ygG_linkButton:hover{text-decoration:underline}.Sr3ygG_modalBackdrop{z-index:1300;background:var(--dsw-alias-bg-mask-1);justify-content:center;align-items:center;display:flex;position:fixed;inset:0}.Sr3ygG_modal{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);width:min(520px,100vw - 48px);max-height:calc(100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);border-radius:14px;flex-direction:column;gap:12px;padding:18px;display:flex;overflow-y:auto}.Sr3ygG_modalTitle{margin:0;font-size:15px;font-weight:700}.Sr3ygG_confirmMessage{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:13px;line-height:1.5}.Sr3ygG_modalFooter{justify-content:flex-end;gap:10px;margin-top:4px;display:flex}.Sr3ygG_field{flex-direction:column;gap:5px;display:flex}.Sr3ygG_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}.Sr3ygG_input{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);resize:vertical;border-radius:8px;outline:none;padding:7px 10px;font-family:inherit;font-size:13px}.Sr3ygG_input:focus{border-color:var(--dsw-alias-state-business-primary)}.Sr3ygG_select{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;max-width:100%;padding:7px 10px;font-family:inherit;font-size:13px}.Sr3ygG_input::placeholder{color:var(--dsw-alias-label-tertiary)}.Sr3ygG_formError{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px}.Sr3ygG_detail{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);width:min(640px,100vw - 48px);max-height:calc(100vh - 80px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);border-radius:14px;flex-direction:column;display:flex;overflow:hidden}.Sr3ygG_detailHeader{border-bottom:1px solid var(--dsw-alias-separator-primary);flex:none;align-items:center;gap:10px;padding:14px 18px;display:flex}.Sr3ygG_detailTitle{overflow-wrap:anywhere;flex:1;margin:0;font-size:15px;font-weight:700}.Sr3ygG_statusBadge{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:2px 10px;font-size:12px}.Sr3ygG_statusBadge[data-status=running]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}.Sr3ygG_statusBadge[data-status=ready_for_test]{color:var(--dsw-alias-state-warn-secondary);border-color:var(--dsw-alias-state-warn-secondary)}.Sr3ygG_statusBadge[data-status=done]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.Sr3ygG_statusBadge[data-status=failed]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.Sr3ygG_detailBody{flex-direction:column;flex:1;gap:16px;padding:14px 18px;display:flex;overflow-y:auto}.Sr3ygG_detailSection{flex-direction:column;gap:6px;display:flex}.Sr3ygG_detailSection h4{color:var(--dsw-alias-label-tertiary);text-transform:none;margin:0;font-size:12px;font-weight:700}.Sr3ygG_detailText{color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:13px;line-height:1.55}.Sr3ygG_scheduleToggle{color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none;align-items:center;gap:8px;font-size:13px;display:flex}.Sr3ygG_scheduleToggle input{accent-color:var(--dsw-alias-state-business-primary)}.Sr3ygG_scheduleRow{align-items:center;gap:8px;display:flex}.Sr3ygG_scheduleInput{min-width:0;font-family:var(--dsw-font-markdown-code-block-small);flex:1;font-size:12.5px}.Sr3ygG_scheduleInputInvalid,.Sr3ygG_scheduleInputInvalid:focus{border-color:var(--dsw-alias-state-error-primary)}.Sr3ygG_schedulePreset{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;flex:none;padding:7px 8px;font-size:12.5px}.Sr3ygG_scheduleMeta{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:0;font-size:12px}.Sr3ygG_promptBlock{font-size:12.5px;line-height:1.5;font-family:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;max-height:240px;margin:0;padding:10px 12px;overflow-y:auto}.Sr3ygG_executionList{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}.Sr3ygG_executionRow{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 10px;display:flex}.Sr3ygG_executionBadge{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:600}.Sr3ygG_executionBadge[data-result=succeeded]{color:var(--dsw-alias-state-success-primary);background:0 0}.Sr3ygG_executionBadge[data-result=failed]{color:var(--dsw-alias-state-error-primary);background:0 0}.Sr3ygG_executionBadge[data-result=cancelled]{color:var(--dsw-alias-label-tertiary);background:0 0}.Sr3ygG_executionTimes{color:var(--dsw-alias-label-secondary);font-size:12px}.Sr3ygG_executionError{width:100%;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;font-size:12px}.Sr3ygG_moveRow{flex-wrap:wrap;gap:8px;display:flex}.Sr3ygG_detailFooter{border-top:1px solid var(--dsw-alias-separator-primary);flex:none;align-items:center;gap:10px;padding:12px 18px;display:flex}.Sr3ygG_detailMeta{color:var(--dsw-alias-label-tertiary);margin-left:auto;font-size:11px}@container Sr3ygG_task-board-view (width<=768px){.Sr3ygG_board{gap:10px;padding:10px}.Sr3ygG_boardHeader{flex-wrap:wrap;align-items:center;gap:8px}.Sr3ygG_backButton{flex:none;order:1}.Sr3ygG_boardTitle{flex:auto;order:2}.Sr3ygG_boardHeader>.Sr3ygG_detailMeta{flex:1 0 100%;order:3;margin-left:0}.Sr3ygG_search{flex:1 0 100%;order:4;min-width:0}.Sr3ygG_boardHeader>button:not(.Sr3ygG_backButton){flex:1 1 0;order:5;min-width:0}.Sr3ygG_columns{scroll-snap-type:inline mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;grid-auto-columns:86cqw;gap:10px;padding-inline:2px 14cqw;scroll-padding-inline:2px}.Sr3ygG_columns::-webkit-scrollbar{display:none}.Sr3ygG_column{scroll-snap-align:start;scroll-snap-stop:always}}@container Sr3ygG_task-board-view (width<=720px){.Sr3ygG_boardHeader>.Sr3ygG_detailMeta{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}}@container Sr3ygG_task-board-view (width<=600px){.Sr3ygG_board{padding-inline:8px}}@media (width<=768px){[data-dsh-taskboard-view]{height:100dvh}.Sr3ygG_entry,.Sr3ygG_card,.Sr3ygG_primaryButton,.Sr3ygG_ghostButton,.Sr3ygG_dangerButton,.Sr3ygG_iconButton,.Sr3ygG_linkButton,.Sr3ygG_search,.Sr3ygG_input,.Sr3ygG_select,.Sr3ygG_schedulePreset,.Sr3ygG_scheduleToggle{min-height:44px}.Sr3ygG_search,.Sr3ygG_input,.Sr3ygG_select,.Sr3ygG_schedulePreset{box-sizing:border-box;font-size:16px}.Sr3ygG_modalBackdrop{justify-content:stretch;align-items:stretch;width:100vw;height:100dvh}.Sr3ygG_modal,.Sr3ygG_detail{box-sizing:border-box;border:0;border-radius:0;width:100vw;height:100dvh;max-height:none}.Sr3ygG_modal{padding-top:max(16px, env(safe-area-inset-top));padding-right:max(16px, env(safe-area-inset-right));padding-bottom:max(16px, env(safe-area-inset-bottom));padding-left:max(16px, env(safe-area-inset-left))}.Sr3ygG_modalFooter{z-index:1;background:var(--dsw-alias-bg-base);flex-wrap:wrap;padding-top:8px;position:sticky;bottom:0}.Sr3ygG_modalFooter>button{flex:120px}.Sr3ygG_detailHeader{padding-top:max(12px, env(safe-area-inset-top));padding-right:max(14px, env(safe-area-inset-right));padding-left:max(14px, env(safe-area-inset-left));flex-wrap:wrap}.Sr3ygG_detailTitle{min-width:0}.Sr3ygG_detailBody{overscroll-behavior-y:contain;padding-right:max(14px, env(safe-area-inset-right));padding-left:max(14px, env(safe-area-inset-left))}.Sr3ygG_detailFooter{padding-right:max(14px, env(safe-area-inset-right));padding-bottom:max(12px, env(safe-area-inset-bottom));padding-left:max(14px, env(safe-area-inset-left));flex-wrap:wrap}.Sr3ygG_detailFooter>button{flex:96px}.Sr3ygG_detailFooter>.Sr3ygG_detailMeta{text-align:end;flex:1 0 100%;margin-left:0}.Sr3ygG_scheduleRow{flex-direction:column;align-items:stretch}.Sr3ygG_schedulePreset{width:100%}}.Sr3ygG_entry:focus-visible,.Sr3ygG_card:focus-visible,.Sr3ygG_cardSession:focus-visible,.Sr3ygG_primaryButton:focus-visible,.Sr3ygG_ghostButton:focus-visible,.Sr3ygG_dangerButton:focus-visible,.Sr3ygG_iconButton:focus-visible,.Sr3ygG_linkButton:focus-visible,.Sr3ygG_search:focus-visible,.Sr3ygG_input:focus-visible,.Sr3ygG_select:focus-visible,.Sr3ygG_schedulePreset:focus-visible,.Sr3ygG_scheduleToggle input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.Sr3ygG_entry,.Sr3ygG_primaryButton,.Sr3ygG_ghostButton,.Sr3ygG_dangerButton,.Sr3ygG_iconButton,.Sr3ygG_linkButton,.Sr3ygG_search,.Sr3ygG_input,.Sr3ygG_select,.Sr3ygG_schedulePreset,.Sr3ygG_scheduleToggle input{transition:background-color .12s,color .12s,border-color .12s,outline-color .12s,box-shadow .12s,transform .12s}.Sr3ygG_card:active{box-shadow:var(--dsw-shadow-lv1);transform:translateY(0)}.Sr3ygG_entry:active,.Sr3ygG_primaryButton:active:not(:disabled),.Sr3ygG_ghostButton:active:not(:disabled),.Sr3ygG_dangerButton:active:not(:disabled),.Sr3ygG_iconButton:active:not(:disabled),.Sr3ygG_linkButton:active:not(:disabled){transform:translateY(1px)}.Sr3ygG_entry[data-active]:hover{background:var(--dsw-specific-sidebar-nav-item-active)}.Sr3ygG_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Sr3ygG_linkButton:hover:not(:disabled){text-decoration:underline}.Sr3ygG_iconButton:disabled,.Sr3ygG_linkButton:disabled{opacity:.45;cursor:default}.Sr3ygG_search:focus,.Sr3ygG_select:focus,.Sr3ygG_schedulePreset:focus{border-color:var(--dsw-alias-state-business-primary)}.Sr3ygG_scheduleToggle input{margin:0}@media (prefers-reduced-motion:reduce){.Sr3ygG_entry,.Sr3ygG_card,.Sr3ygG_primaryButton,.Sr3ygG_ghostButton,.Sr3ygG_dangerButton,.Sr3ygG_iconButton,.Sr3ygG_linkButton,.Sr3ygG_search,.Sr3ygG_input,.Sr3ygG_select,.Sr3ygG_schedulePreset,.Sr3ygG_scheduleToggle input{transition:none}.Sr3ygG_cardSpinner,.Sr3ygG_card[data-executing=true]{animation:none}}.Sr3ygG_cardTags{flex-wrap:wrap;gap:4px;display:flex}.Sr3ygG_cardTag{border:1px solid var(--dsh-task-tag-border);background:var(--dsh-task-tag-fill);max-width:100%;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;border-radius:999px;padding:0 7px;font-size:10px;line-height:16px;overflow:hidden}.Sr3ygG_tagFilter{flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px;display:flex}.Sr3ygG_tagFilterLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}.Sr3ygG_tagChip{border:1px solid var(--dsh-task-tag-border);color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:999px;padding:1px 9px;font-family:inherit;font-size:11px;line-height:18px}.Sr3ygG_tagChip[data-active=true]{background:var(--dsh-task-tag-fill);color:var(--dsw-alias-label-primary)}.Sr3ygG_cardTag[data-tag-tone=\"0\"],.Sr3ygG_tagChip[data-tag-tone=\"0\"]{--dsh-task-tag-fill:#4e93e82e;--dsh-task-tag-border:#4e93e866}.Sr3ygG_cardTag[data-tag-tone=\"1\"],.Sr3ygG_tagChip[data-tag-tone=\"1\"]{--dsh-task-tag-fill:#2ea36a2e;--dsh-task-tag-border:#2ea36a66}.Sr3ygG_cardTag[data-tag-tone=\"2\"],.Sr3ygG_tagChip[data-tag-tone=\"2\"]{--dsh-task-tag-fill:#d08a2a2e;--dsh-task-tag-border:#d08a2a66}.Sr3ygG_cardTag[data-tag-tone=\"3\"],.Sr3ygG_tagChip[data-tag-tone=\"3\"]{--dsh-task-tag-fill:#b456c82e;--dsh-task-tag-border:#b456c866}.Sr3ygG_cardTag[data-tag-tone=\"4\"],.Sr3ygG_tagChip[data-tag-tone=\"4\"]{--dsh-task-tag-fill:#cf5f7a2e;--dsh-task-tag-border:#cf5f7a66}.Sr3ygG_cardTag[data-tag-tone=\"5\"],.Sr3ygG_tagChip[data-tag-tone=\"5\"]{--dsh-task-tag-fill:#4a9fb52e;--dsh-task-tag-border:#4a9fb566}.Sr3ygG_fieldHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}.Sr3ygG_tagRow{align-items:center;gap:6px;display:flex}.Sr3ygG_tagRow .Sr3ygG_input{flex:1 1 0;min-width:0}.Sr3ygG_tagRow .Sr3ygG_ghostButton{flex:none}.Sr3ygG_tagAddButton{align-self:flex-start}.Sr3ygG_projectFilter{flex:none;align-items:center;gap:6px;display:flex}.Sr3ygG_projectFilterLabel{color:var(--dsw-alias-label-secondary);white-space:nowrap;font-size:12px}.Sr3ygG_projectDialog{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;flex:none;gap:8px;margin-bottom:8px;padding:10px 12px;display:flex}.Sr3ygG_projectDialogActions{justify-content:flex-end;gap:8px;display:flex}.Sr3ygG_aiParse{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:6px;padding:10px 12px;display:flex}.Sr3ygG_aiParseRow{align-items:center;gap:8px;display:flex}.Sr3ygG_aiParseRow .Sr3ygG_select{flex:1 1 0;min-width:0}.Sr3ygG_aiParseRow .Sr3ygG_ghostButton,.Sr3ygG_aiParseRow .Sr3ygG_primaryButton{flex:none}";
		const tagId$1 = "dsh-next-task-board/src/client/board.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-next-task-board";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var board_module_css_default = {
			"aiParse": "Sr3ygG_aiParse",
			"aiParseRow": "Sr3ygG_aiParseRow",
			"backButton": "Sr3ygG_backButton",
			"board": "Sr3ygG_board",
			"boardHeader": "Sr3ygG_boardHeader",
			"boardTitle": "Sr3ygG_boardTitle",
			"card": "Sr3ygG_card",
			"cardBox": "Sr3ygG_cardBox",
			"cardExcerpt": "Sr3ygG_cardExcerpt",
			"cardExecutingBadge": "Sr3ygG_cardExecutingBadge",
			"cardMeta": "Sr3ygG_cardMeta",
			"cardRun": "Sr3ygG_cardRun",
			"cardRunningLabel": "Sr3ygG_cardRunningLabel",
			"cardSchedule": "Sr3ygG_cardSchedule",
			"cardSession": "Sr3ygG_cardSession",
			"cardSpinner": "Sr3ygG_cardSpinner",
			"cardTag": "Sr3ygG_cardTag",
			"cardTags": "Sr3ygG_cardTags",
			"cardTime": "Sr3ygG_cardTime",
			"cardTitle": "Sr3ygG_cardTitle",
			"cards": "Sr3ygG_cards",
			"column": "Sr3ygG_column",
			"columnCount": "Sr3ygG_columnCount",
			"columnEmpty": "Sr3ygG_columnEmpty",
			"columnHeader": "Sr3ygG_columnHeader",
			"columnTitle": "Sr3ygG_columnTitle",
			"columns": "Sr3ygG_columns",
			"confirmMessage": "Sr3ygG_confirmMessage",
			"dangerButton": "Sr3ygG_dangerButton",
			"detail": "Sr3ygG_detail",
			"detailBody": "Sr3ygG_detailBody",
			"detailFooter": "Sr3ygG_detailFooter",
			"detailHeader": "Sr3ygG_detailHeader",
			"detailMeta": "Sr3ygG_detailMeta",
			"detailSection": "Sr3ygG_detailSection",
			"detailText": "Sr3ygG_detailText",
			"detailTitle": "Sr3ygG_detailTitle",
			"dragBadge": "Sr3ygG_dragBadge",
			"dshTbRunningPulse": "Sr3ygG_dshTbRunningPulse",
			"dshTbSpin": "Sr3ygG_dshTbSpin",
			"entry": "Sr3ygG_entry",
			"entryIcon": "Sr3ygG_entryIcon",
			"entryLabel": "Sr3ygG_entryLabel",
			"executionBadge": "Sr3ygG_executionBadge",
			"executionError": "Sr3ygG_executionError",
			"executionList": "Sr3ygG_executionList",
			"executionRow": "Sr3ygG_executionRow",
			"executionTimes": "Sr3ygG_executionTimes",
			"field": "Sr3ygG_field",
			"fieldHint": "Sr3ygG_fieldHint",
			"fieldLabel": "Sr3ygG_fieldLabel",
			"formError": "Sr3ygG_formError",
			"ghostButton": "Sr3ygG_ghostButton",
			"iconButton": "Sr3ygG_iconButton",
			"input": "Sr3ygG_input",
			"linkButton": "Sr3ygG_linkButton",
			"modal": "Sr3ygG_modal",
			"modalBackdrop": "Sr3ygG_modalBackdrop",
			"modalFooter": "Sr3ygG_modalFooter",
			"modalTitle": "Sr3ygG_modalTitle",
			"moveRow": "Sr3ygG_moveRow",
			"primaryButton": "Sr3ygG_primaryButton",
			"projectDialog": "Sr3ygG_projectDialog",
			"projectDialogActions": "Sr3ygG_projectDialogActions",
			"projectFilter": "Sr3ygG_projectFilter",
			"projectFilterLabel": "Sr3ygG_projectFilterLabel",
			"promptBlock": "Sr3ygG_promptBlock",
			"scheduleInput": "Sr3ygG_scheduleInput",
			"scheduleInputInvalid": "Sr3ygG_scheduleInputInvalid",
			"scheduleMeta": "Sr3ygG_scheduleMeta",
			"schedulePreset": "Sr3ygG_schedulePreset",
			"scheduleRow": "Sr3ygG_scheduleRow",
			"scheduleToggle": "Sr3ygG_scheduleToggle",
			"search": "Sr3ygG_search",
			"select": "Sr3ygG_select",
			"selectionBar": "Sr3ygG_selectionBar",
			"statusBadge": "Sr3ygG_statusBadge",
			"statusDot": "Sr3ygG_statusDot",
			"tagAddButton": "Sr3ygG_tagAddButton",
			"tagChip": "Sr3ygG_tagChip",
			"tagFilter": "Sr3ygG_tagFilter",
			"tagFilterLabel": "Sr3ygG_tagFilterLabel",
			"tagRow": "Sr3ygG_tagRow",
			"task-board-view": "Sr3ygG_task-board-view"
		};
		//#endregion
		//#region src/client/schedule-presets.ts
		/** Common scheduled-run presets (cron → locale label). */
		const SCHEDULE_PRESETS = [
			{
				cron: "0 9 * * *",
				label: "detail.schedule.preset.daily9"
			},
			{
				cron: "0 * * * *",
				label: "detail.schedule.preset.hourly"
			},
			{
				cron: "*/10 * * * *",
				label: "detail.schedule.preset.tenMin"
			},
			{
				cron: "0 9 * * 1",
				label: "detail.schedule.preset.weeklyMon9"
			}
		];
		//#endregion
		//#region src/client/board/TaskForm.tsx
		/**
		* Shared task-modal pieces: the overlay shell (backdrop, form, title, error,
		* footer), the title/description/prompt field trio used by both the
		* NewTaskModal and the EditTaskModal, and the "Parse with AI" box both forms
		* offer (same state machine, different opening text). State stays in the
		* owning modal; these are controlled components.
		*/
		/** DOM id shared by the tag-name inputs and their datalist (one board at a time). */
		const TAG_NAME_LIST_ID = "dsh-task-board-tag-names";
		/** Modal overlay: closes on backdrop press, submits through the form. */
		function ModalShell({ ariaLabel, title, error, pending, submitLabel, onSubmit, onClose, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: board_module_css_default.modalBackdrop,
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: board_module_css_default.modal,
					role: "dialog",
					"aria-label": ariaLabel,
					onSubmit: (event) => {
						event.preventDefault();
						onSubmit();
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: board_module_css_default.modalTitle,
							children: title
						}),
						children,
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: board_module_css_default.formError,
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
							className: board_module_css_default.modalFooter,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_css_default.ghostButton,
								onClick: onClose,
								children: t("new.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: board_module_css_default.primaryButton,
								disabled: pending,
								children: submitLabel
							})]
						})
					]
				})
			});
		}
		/**
		* Opening text of an existing task's "Parse with AI" box: the source text the
		* card was created with, or — when that text is gone (cards from before the
		* box was stored, or a cleared box) — the card's own title, description, and
		* prompt as one editable block. The user can then rewrite that block and run
		* "Parse and fill" again.
		*/
		function parseSourceText(task) {
			const stored = task.parseText?.trim();
			if (stored !== void 0 && stored !== "") return stored;
			return [
				task.title,
				task.description,
				task.prompt
			].map((part) => part.trim()).filter((part) => part !== "").join("\n\n");
		}
		/**
		* State and actions behind one "Parse with AI" box. The owner supplies the
		* opening text and decides what a successful draft does (the create form fills
		* its three fields; the edit form overwrites the task's).
		*/
		function useAiParse(controller, initialText, onDraft) {
			const [text, setText] = (0, react.useState)(initialText);
			const [models, setModels] = (0, react.useState)(controller.getSnapshot().executionOptions.models ?? []);
			const [model, setModel] = (0, react.useState)("");
			const [pending, setPending] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const abort = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => controller.subscribe(() => setModels(controller.getSnapshot().executionOptions.models ?? [])), [controller]);
			(0, react.useEffect)(() => {
				if (model === "" && models.length > 0) setModel(models[0].id);
			}, [model, models]);
			const run = async () => {
				const value = text.trim();
				if (value === "") {
					setError(t("new.aiParseEmpty"));
					return;
				}
				const request = new AbortController();
				abort.current = request;
				setPending(true);
				setError(void 0);
				try {
					onDraft(await controller.parseTaskDraft({
						text: value,
						...model === "" ? {} : { model }
					}, request.signal));
				} catch (failure) {
					if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					abort.current = void 0;
					setPending(false);
				}
			};
			return {
				text,
				setText,
				models,
				model,
				setModel,
				pending,
				error,
				setError,
				run,
				cancel: () => {
					abort.current?.abort();
				}
			};
		}
		/**
		* The "Parse with AI" box: a source textarea, the route picker, and the
		* run/cancel button. `hintKey` lets the edit form explain that the text is the
		* card's stored source rather than a fresh paste.
		*/
		function AiParseSection({ parse, hintKey = "new.aiParseHint" }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: board_module_css_default.aiParse,
				"data-dsh-part": "ai-parse",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.fieldLabel,
						children: t("new.aiParse")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_css_default.fieldHint,
						children: t(hintKey)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: board_module_css_default.input,
						rows: 3,
						value: parse.text,
						placeholder: t("new.aiParsePlaceholder"),
						spellCheck: false,
						onChange: (event) => {
							parse.setText(event.target.value);
							parse.setError(void 0);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.aiParseRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							className: board_module_css_default.select,
							value: parse.model,
							"aria-label": t("new.aiParseModel"),
							onChange: (event) => {
								parse.setModel(event.target.value);
							},
							children: parse.models.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: option.id,
								children: option.name ?? option.id
							}, option.id))
						}), parse.pending ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: board_module_css_default.ghostButton,
							onClick: () => {
								parse.cancel();
							},
							children: t("new.aiParseCancel")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: board_module_css_default.primaryButton,
							disabled: parse.text.trim() === "",
							onClick: () => {
								parse.run();
							},
							children: t("new.aiParseRun")
						})]
					}),
					parse.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_css_default.formError,
						children: parse.error
					})
				]
			});
		}
		/** Title + description + prompt fields shared by the new and edit task forms. */
		function TaskContentFields({ title, description, prompt, onTitleChange, onDescriptionChange, onPromptChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: board_module_css_default.field,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.fieldLabel,
						children: t("new.title")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: board_module_css_default.input,
						value: title,
						autoFocus: true,
						placeholder: t("new.titlePlaceholder"),
						onChange: (event) => onTitleChange(event.target.value)
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: board_module_css_default.field,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.fieldLabel,
						children: t("new.description")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: board_module_css_default.input,
						rows: 3,
						value: description,
						placeholder: t("new.descriptionPlaceholder"),
						onChange: (event) => onDescriptionChange(event.target.value)
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: board_module_css_default.field,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.fieldLabel,
						children: t("new.prompt")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: board_module_css_default.input,
						rows: 4,
						value: prompt,
						placeholder: t("new.promptPlaceholder"),
						onChange: (event) => onPromptChange(event.target.value)
					})]
				})
			] });
		}
		/**
		* Task labels (issue #1521): one row per label holding the badge name and an
		* optional execution hint. The name inputs offer the labels already used on the
		* board through a datalist, and picking one adopts its hint when the row has
		* none — so a business line is defined once and reused by every later task.
		*/
		function TaskTagFields({ tags, knownTags, onChange }) {
			const update = (index, patch) => {
				onChange(tags.map((tag, position) => position === index ? {
					...tag,
					...patch
				} : tag));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: board_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.fieldLabel,
						children: t("new.tags")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.fieldHint,
						children: t("new.tagsHint")
					}),
					tags.map((tag, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.tagRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: board_module_css_default.input,
								list: TAG_NAME_LIST_ID,
								value: tag.name,
								maxLength: 32,
								placeholder: t("new.tagNamePlaceholder"),
								"aria-label": t("new.tagName"),
								onChange: (event) => {
									const name = event.target.value;
									const known = knownTags.find((candidate) => candidate.name === name);
									const adoptsHint = known?.promptPrefix !== void 0 && (tag.promptPrefix ?? "").trim() === "";
									update(index, adoptsHint ? {
										name,
										promptPrefix: known.promptPrefix
									} : { name });
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: board_module_css_default.input,
								value: tag.promptPrefix ?? "",
								maxLength: 200,
								placeholder: t("new.tagPromptPlaceholder"),
								"aria-label": t("new.tagPrompt"),
								onChange: (event) => {
									update(index, { promptPrefix: event.target.value });
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_css_default.ghostButton,
								"aria-label": t("new.tagRemove", { name: tag.name }),
								onClick: () => {
									onChange(tags.filter((_, position) => position !== index));
								},
								children: "×"
							})
						]
					}, index)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
						id: TAG_NAME_LIST_ID,
						children: knownTags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: tag.name }, tag.name))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: board_module_css_default.ghostButton + " " + board_module_css_default.tagAddButton,
						disabled: tags.length >= 8,
						onClick: () => {
							onChange([...tags, { name: "" }]);
						},
						children: ["+ ", t("new.tagAdd")]
					})
				]
			});
		}
		/**
		* Clean a tag list via normalizeTags: trim, drop blanks and duplicates, cap
		* lengths and count, so the wire always carries a valid tag list.
		*/
		function cleanTags(tags) {
			return normalizeTags(tags) ?? [];
		}
		//#endregion
		//#region src/client/board/NewTaskModal.tsx
		/**
		* New-task modal: title + description + the prompt that execution will send.
		* Creates through the Host and closes only after the Host confirms it.
		*/
		/** New-task form overlay. */
		function NewTaskModal({ controller, onClose, initialTask, defaultWorkspaceId, onDuplicateSuccess }) {
			const isDuplicate = initialTask !== void 0;
			const [title, setTitle] = (0, react.useState)(initialTask?.title ?? "");
			const [description, setDescription] = (0, react.useState)(initialTask?.description ?? "");
			const [prompt, setPrompt] = (0, react.useState)(initialTask?.prompt ?? "");
			const [workspaceId, setWorkspaceId] = (0, react.useState)(initialTask?.workspaceId ?? defaultWorkspaceId ?? "");
			const [mode, setMode] = (0, react.useState)(initialTask?.mode ?? "");
			const [permission, setPermission] = (0, react.useState)(initialTask?.permission ?? "");
			const [model, setModel] = (0, react.useState)(initialTask?.model ?? "");
			const [reuseSession, setReuseSession] = (0, react.useState)(initialTask?.reuseSession ?? false);
			const [scheduleEnabled, setScheduleEnabled] = (0, react.useState)(initialTask?.schedule?.enabled ?? false);
			const [scheduleCron, setScheduleCron] = (0, react.useState)(initialTask?.schedule?.cron ?? "");
			const [scheduleError, setScheduleError] = (0, react.useState)(void 0);
			const [freezeText, setFreezeText] = (0, react.useState)("");
			const [freezeError, setFreezeError] = (0, react.useState)(void 0);
			const [handoverText, setHandoverText] = (0, react.useState)(initialTask?.handover?.references !== void 0 ? initialTask.handover.references.join("\n") : "");
			const [tags, setTags] = (0, react.useState)(initialTask?.tags ?? []);
			const [archiveOriginal, setArchiveOriginal] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(void 0);
			const [pending, setPending] = (0, react.useState)(false);
			const [options, setOptions] = (0, react.useState)(controller.getSnapshot().executionOptions);
			const [canParse] = (0, react.useState)(controller.getSnapshot().canParseTask === true);
			const parse = useAiParse(controller, initialTask?.parseText ?? "", (draft) => {
				setTitle(draft.title);
				setDescription(draft.description);
				setPrompt(draft.prompt);
			});
			(0, react.useEffect)(() => controller.subscribe(() => setOptions(controller.getSnapshot().executionOptions)), [controller]);
			const submit = async () => {
				if (scheduleEnabled) {
					const cron = scheduleCron.trim();
					if (cron === "" || !isValidCron(cron)) {
						setScheduleError(t("detail.schedule.invalid"));
						return;
					}
				}
				let freeze = void 0;
				if (freezeText.trim() !== "") {
					const parsed = parseFreezeRequest(freezeText);
					if (!parsed.ok) {
						setFreezeError(parsed.error.message);
						return;
					}
					freeze = {
						...parsed.snapshot,
						...parsed.warnings.includes("redacted") ? { redacted: true } : {}
					};
				}
				const references = handoverText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
				const handover = references.length === 0 ? void 0 : {
					references,
					workspaceId: workspaceId === "" ? void 0 : workspaceId,
					mode: mode === "" ? void 0 : mode,
					permission: permission === "" ? void 0 : permission
				};
				const tagList = cleanTags(tags);
				setPending(true);
				if (await controller.createTaskConfirmed({
					title,
					description,
					prompt,
					...canParse && parse.text.trim() !== "" ? { parseText: parse.text } : {},
					freeze,
					handover,
					workspaceId: workspaceId === "" ? void 0 : workspaceId,
					mode: mode === "" ? void 0 : mode,
					permission: permission === "" ? void 0 : permission,
					model: model === "" ? void 0 : model,
					...reuseSession ? { reuseSession: true } : {},
					...tagList.length > 0 ? { tags: tagList } : {},
					schedule: scheduleEnabled ? {
						enabled: true,
						cron: scheduleCron.trim()
					} : void 0
				}) === void 0) {
					setPending(false);
					setError(controller.getSnapshot().transportError ?? t("new.required"));
					return;
				}
				if (isDuplicate && archiveOriginal && initialTask !== void 0) if (onDuplicateSuccess !== void 0) await onDuplicateSuccess(initialTask.id);
				else await controller.archiveTask(initialTask.id);
				onClose();
			};
			/** Next-run preview for a valid armed cron (creation-time only). */
			const scheduleNextRun = scheduleEnabled && scheduleCron.trim() !== "" && isValidCron(scheduleCron) ? nextRunAtMs(scheduleCron, Date.now()) : void 0;
			const modalTitle = isDuplicate ? t("new.duplicateTitle") : t("board.new");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(ModalShell, {
				ariaLabel: modalTitle,
				title: modalTitle,
				error,
				pending,
				submitLabel: t("new.submit"),
				onSubmit: () => {
					submit();
				},
				onClose,
				children: [
					canParse && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AiParseSection, { parse }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskContentFields, {
						title,
						description,
						prompt,
						onTitleChange: (value) => {
							setTitle(value);
							setError(void 0);
						},
						onDescriptionChange: setDescription,
						onPromptChange: setPrompt
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskTagFields, {
						tags,
						knownTags: collectKnownTags(controller.getSnapshot().tasks),
						onChange: setTags
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.freeze")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: board_module_css_default.input,
							rows: 4,
							value: freezeText,
							placeholder: t("new.freezePlaceholder"),
							spellCheck: false,
							onChange: (event) => {
								setFreezeText(event.target.value);
								setFreezeError(void 0);
							}
						})]
					}),
					freezeError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_css_default.formError,
						children: freezeError
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.handover")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: board_module_css_default.input,
							rows: 3,
							value: handoverText,
							placeholder: t("new.handoverPlaceholder"),
							spellCheck: false,
							onChange: (event) => {
								setHandoverText(event.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.workspace")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: workspaceId,
							onChange: (event) => {
								setWorkspaceId(event.target.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("exec.workspace.recent")
							}), options.workspaces.map((workspace) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: workspace.workspaceId,
								children: workspace.title
							}, workspace.workspaceId))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.mode")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: mode,
							onChange: (event) => {
								setMode(event.target.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("exec.mode.default")
							}), options.presets.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: preset.id,
								disabled: preset.broken !== void 0,
								children: [
									preset.name ?? preset.id,
									preset.isDefault ? t("exec.mode.defaultSuffix") : "",
									preset.broken !== void 0 ? t("exec.mode.brokenSuffix") : ""
								]
							}, preset.id))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.permission")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: permission,
							onChange: (event) => {
								setPermission(event.target.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("exec.permission.default")
							}), TASK_PERMISSIONS.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: id,
								children: t(`exec.permission.${id}`)
							}, id))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.model")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: model,
							onChange: (event) => {
								setModel(event.target.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("exec.model.default")
							}), options.models?.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: item.id,
								children: item.name ?? item.id
							}, item.id))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.scheduleToggle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: reuseSession,
							onChange: (event) => {
								setReuseSession(event.target.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("exec.reuseSession") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_css_default.detailText,
						children: t("exec.reuseSessionHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: board_module_css_default.detailSection,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.schedule") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_css_default.scheduleToggle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: scheduleEnabled,
									onChange: (event) => {
										setScheduleEnabled(event.target.checked);
										if (!event.target.checked) setScheduleError(void 0);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("detail.schedule.enable") })]
							}),
							scheduleEnabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: board_module_css_default.scheduleRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: `${board_module_css_default.input} ${board_module_css_default.scheduleInput}${scheduleError !== void 0 ? ` ${board_module_css_default.scheduleInputInvalid}` : ""}`,
										value: scheduleCron,
										placeholder: "0 9 * * *",
										spellCheck: false,
										"aria-label": t("detail.schedule.cron"),
										onChange: (event) => {
											setScheduleCron(event.target.value);
											setScheduleError(void 0);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: board_module_css_default.schedulePreset,
										value: "",
										"aria-label": t("detail.schedule.presets"),
										onChange: (event) => {
											if (event.target.value === "") return;
											setScheduleCron(event.target.value);
											setScheduleError(void 0);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: "",
											children: [t("detail.schedule.presets"), "…"]
										}), SCHEDULE_PRESETS.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: preset.cron,
											children: t(preset.label)
										}, preset.cron))]
									})]
								}),
								scheduleError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: board_module_css_default.formError,
									children: scheduleError
								}),
								scheduleError === void 0 && scheduleNextRun !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: board_module_css_default.scheduleMeta,
									children: [
										t("detail.schedule.nextRun"),
										" ",
										new Date(scheduleNextRun).toLocaleString()
									]
								})
							] })
						]
					}),
					isDuplicate && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.checkboxLabel,
						style: { marginTop: "12px" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: archiveOriginal,
							onChange: (event) => {
								setArchiveOriginal(event.target.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("new.archiveOriginal") })]
					})
				]
			});
		}
		//#endregion
		//#region src/client/session-link.ts
		/**
		* Session deep link: the card's session jump is an anchor, so its target must
		* be expressible as a URL. The Web shell has no router of its own, so the
		* board claims the `#session=<id>` hash — a plain left-click is handled in
		* place (the anchor's onClick), while middle-click / Ctrl-click / a copied URL
		* boots a fresh page that opens the session from the hash. One format, shared
		* by the anchor that writes it and the boot listener that reads it.
		*/
		/** Hash target of one session: `#session=<id>`. */
		function sessionLinkHref(sessionId) {
			return `#${new URLSearchParams({ session: sessionId }).toString()}`;
		}
		/**
		* Session id carried by a `location.hash`, or undefined when it is not a
		* session link (no hash, another fragment, or a blank id).
		*/
		function sessionLinkTarget(hash) {
			if (!hash.startsWith("#")) return void 0;
			const sessionId = new URLSearchParams(hash.slice(1)).get("session");
			return sessionId === null || sessionId === "" ? void 0 : sessionId;
		}
		//#endregion
		//#region src/client/board/TaskCard.tsx
		/**
		* Task card: the board's column item. A plain click marks the card (the
		* board owns the Ctrl/Shift/Space rules), a double click opens the task
		* detail — it never executes anything directly (detail holds the Run button).
		* A card whose latest execution carries a session also renders a direct
		* session link, for a running (active) and a settled (inactive) execution
		* alike.
		*
		* The link is a sibling of the card button, not a child: a button may not hold
		* interactive content, and a nested anchor would not be keyboard-reachable.
		* Clicking it jumps straight into the session instead of selecting the card.
		*
		* Memoized: the card re-renders only when its own task record changes, so a
		* status/filter update on one card (or scrolling) never re-renders every
		* card on the board. The per-card onClick is built with a stable task reference
		* by the board, so the memo boundary is effective.
		*/
		/** Compact relative/absolute time label. */
		function formatHostTimestamp(ms, timeZone) {
			try {
				return new Intl.DateTimeFormat(void 0, {
					dateStyle: "medium",
					timeStyle: "medium",
					...timeZone === void 0 ? {} : { timeZone }
				}).format(new Date(ms));
			} catch {
				return new Date(ms).toISOString();
			}
		}
		function formatTime(ms, timeZone) {
			const date = new Date(ms);
			const minutes = Math.floor((Date.now() - ms) / 6e4);
			if (minutes < 1) return t("time.justNow");
			if (minutes < 60) return `${minutes}m`;
			if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
			if (timeZone !== void 0) return formatHostTimestamp(ms, timeZone);
			return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		}
		/**
		* Whether a card may be dragged at all: archived cards are read-only, a card
		* the runner owns (`running`, or pending on the Host) must not be moved while
		* its execution settles. The board reuses this to decide which cards a group
		* drag may carry, so the payload and the `draggable` attribute never disagree.
		*/
		function isCardDraggable(task, pending) {
			return task.archivedAt === void 0 && task.status !== "running" && !pending;
		}
		function TaskCardInner({ task, pending, timeZone, selected, dragging, onClick, onKeyDown, onDoubleClick, onDragStart, onDragEnd, onOpenSession }) {
			const latest = task.executions[task.executions.length - 1];
			const runs = task.executions.length;
			const archived = task.archivedAt !== void 0;
			const executing = !archived && isTaskExecuting(task);
			const queued = !archived && !executing && !pending && latest !== void 0 && latest.endedAt === void 0;
			const isDraggable = isCardDraggable(task, pending);
			const sessionId = latest?.sessionId;
			const sessionLabel = t("card.openSession");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: board_module_css_default.cardBox,
				"data-dsh-part": "card-box",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: board_module_css_default.card,
					"data-status": archived ? "archived" : task.status,
					"data-dsh-part": "card",
					"data-pending": pending || void 0,
					"data-executing": executing || void 0,
					"data-has-session": sessionId !== void 0 || void 0,
					"data-selected": selected || void 0,
					"data-dragging": dragging || void 0,
					"aria-pressed": archived ? void 0 : selected,
					draggable: isDraggable,
					onDragStart: isDraggable ? onDragStart : void 0,
					onDragEnd: isDraggable ? onDragEnd : void 0,
					onClick,
					onKeyDown,
					onDoubleClick,
					title: task.description !== "" ? task.description : task.title,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.cardTitle,
							children: task.title
						}),
						task.tags !== void 0 && task.tags.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.cardTags,
							children: task.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_css_default.cardTag,
								"data-tag-tone": tagTone(tag.name),
								"data-dsh-part": "tag-badge",
								"data-tag-hint": tag.promptPrefix === void 0 ? void 0 : tag.promptPrefix,
								title: tag.promptPrefix === void 0 ? tag.name : tag.promptPrefix,
								children: tag.name
							}, tag.name))
						}),
						task.description !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.cardExcerpt,
							children: task.description
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: board_module_css_default.cardMeta,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: board_module_css_default.cardTime,
									children: [
										t("board.updated"),
										" ",
										formatTime(task.updatedAt)
									]
								}),
								task.freeze !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_css_default.cardSchedule,
									title: task.freeze.goal,
									children: t("card.frozen")
								}),
								!archived && task.schedule?.enabled === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_css_default.cardSchedule,
									title: task.schedule.nextRunAt !== void 0 ? `${t("card.scheduled")} · ${formatHostTimestamp(task.schedule.nextRunAt, timeZone)}` : t("card.scheduled"),
									children: t("card.scheduled")
								}),
								latest !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: board_module_css_default.cardRun,
									"data-result": archived ? void 0 : latest.result,
									children: [
										runs,
										" ",
										t("board.runs")
									]
								}),
								!archived && (executing || pending) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_css_default.cardSpinner,
									"aria-hidden": "true"
								})
							]
						}),
						!archived && pending && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: board_module_css_default.cardRunningLabel,
							children: [t("board.pending"), "…"]
						}),
						executing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.cardExecutingBadge,
							children: t("card.running")
						}),
						queued && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.cardRunningLabel,
							children: t("card.queued")
						})
					]
				}), sessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
					className: board_module_css_default.cardSession,
					"data-dsh-part": "card-session",
					href: sessionLinkHref(sessionId),
					title: `${sessionLabel} · ${sessionId}`,
					"aria-label": sessionLabel,
					onClick: (event) => {
						event.stopPropagation();
						if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
						event.preventDefault();
						onOpenSession(sessionId);
					},
					onDoubleClick: (event) => {
						event.stopPropagation();
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						children: "⌁"
					})
				})]
			});
		}
		/** Memoized card: re-renders only when the card's own task record changes. */
		const TaskCard = (0, react.memo)(TaskCardInner);
		//#endregion
		//#region src/client/board/ConfirmDialog.tsx
		/**
		* Generic confirm dialog used by destructive actions (task delete).
		*/
		/** Small confirm overlay. */
		function ConfirmDialog({ title, message, confirmLabel, danger, onCancel, onConfirm }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: board_module_css_default.modalBackdrop,
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onCancel();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: board_module_css_default.modal,
					role: "alertdialog",
					"aria-label": title,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: board_module_css_default.modalTitle,
							children: title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: board_module_css_default.confirmMessage,
							children: message
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
							className: board_module_css_default.modalFooter,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_css_default.ghostButton,
								onClick: onCancel,
								children: t("delete.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: danger ? board_module_css_default.dangerButton : board_module_css_default.primaryButton,
								onClick: onConfirm,
								children: confirmLabel
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/board/EditTaskModal.tsx
		/**
		* Edit-task modal: title + description + the prompt the next execution will
		* send, pre-filled from the task, plus the task's "Parse with AI" source text
		* so the user can rewrite it and fill the fields again. Shown only for tasks
		* that still sit in a pre-execution column (the detail view gates on
		* canEditTaskContent); the Host still re-checks at submit, so a task that
		* started running while the modal was open fails closed and the error surfaces
		* here.
		*/
		/** Edit-task form overlay. */
		function EditTaskModal({ controller, task, onClose }) {
			const [title, setTitle] = (0, react.useState)(task.title);
			const [description, setDescription] = (0, react.useState)(task.description);
			const [prompt, setPrompt] = (0, react.useState)(task.prompt);
			const [tags, setTags] = (0, react.useState)(task.tags ?? []);
			const [error, setError] = (0, react.useState)(void 0);
			const [pending, setPending] = (0, react.useState)(false);
			const [canParse] = (0, react.useState)(controller.getSnapshot().canParseTask === true);
			const [openingText] = (0, react.useState)(() => parseSourceText(task));
			const parse = useAiParse(controller, openingText, (draft) => {
				setTitle(draft.title);
				setDescription(draft.description);
				setPrompt(draft.prompt);
			});
			const submit = async () => {
				if (title.trim() === "") {
					setError(t("new.required"));
					return;
				}
				setPending(true);
				const tagList = cleanTags(tags);
				const patch = {
					title,
					description,
					prompt,
					...canParse && parse.text !== openingText ? { parseText: parse.text } : {},
					...tagList.length > 0 ? { tags: tagList } : task.tags === void 0 ? {} : { tags: null }
				};
				if (await controller.updateTask(task.id, patch)) {
					onClose();
					return;
				}
				setPending(false);
				setError(controller.getSnapshot().transportError ?? t("new.required"));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(ModalShell, {
				ariaLabel: t("edit.title"),
				title: t("edit.title"),
				error,
				pending,
				submitLabel: t("edit.save"),
				onSubmit: () => {
					submit();
				},
				onClose,
				children: [
					canParse && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AiParseSection, {
						parse,
						hintKey: "edit.aiParseHint"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskContentFields, {
						title,
						description,
						prompt,
						onTitleChange: (value) => {
							setTitle(value);
							setError(void 0);
						},
						onDescriptionChange: setDescription,
						onPromptChange: setPrompt
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskTagFields, {
						tags,
						knownTags: collectKnownTags(controller.getSnapshot().tasks),
						onChange: setTags
					})
				]
			});
		}
		/** Edit-tags modal: edit labels only, shown for tasks after first execution. */
		function EditTagsModal({ controller, task, onClose }) {
			const [tags, setTags] = (0, react.useState)(task.tags ?? []);
			const [error, setError] = (0, react.useState)(void 0);
			const [pending, setPending] = (0, react.useState)(false);
			const submit = async () => {
				setPending(true);
				const tagList = cleanTags(tags);
				const patch = { tags: tagList.length > 0 ? tagList : null };
				if (await controller.updateTask(task.id, patch)) {
					onClose();
					return;
				}
				setPending(false);
				setError(controller.getSnapshot().transportError ?? t("new.required"));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModalShell, {
				ariaLabel: t("detail.editTags"),
				title: t("detail.editTags"),
				error,
				pending,
				submitLabel: t("edit.save"),
				onSubmit: () => {
					submit();
				},
				onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskTagFields, {
					tags,
					knownTags: collectKnownTags(controller.getSnapshot().tasks),
					onChange: setTags
				})
			});
		}
		//#endregion
		//#region src/client/board/status-key.ts
		/** Task status → locale key (board column titles and the detail badge). */
		const STATUS_KEY = {
			backlog: "board.status.backlog",
			todo: "board.status.todo",
			running: "board.status.running",
			ready_for_test: "board.status.ready_for_test",
			done: "board.status.done",
			failed: "board.status.failed"
		};
		//#endregion
		//#region src/client/board/TaskDetail.tsx
		/**
		* Task detail: the full view of one task — content, prompt, execution
		* history — and the only place execution can be triggered. Also offers
		* delete (with confirmation), manual status moves, and a jump to the
		* execution's session transcript.
		*/
		/**
		* Label of a manual-move chip. The machine may name a target the shipped
		* dictionary has no wording for (a custom column); the column's own label is
		* then better than a missing-key artifact.
		*/
		function moveLabel(status) {
			const key = `status.move.${status}`;
			return key in dictionary() ? t(key) : t(STATUS_KEY[status]);
		}
		/** Execution outcome → locale key. */
		const RESULT_KEY = {
			succeeded: "detail.result.succeeded",
			failed: "detail.result.failed",
			cancelled: "detail.result.cancelled"
		};
		/** One execution-history row. */
		function ExecutionRow({ execution, timeZone, onOpen }) {
			const result = execution.result;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: board_module_css_default.executionRow,
				"data-result": result,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.executionBadge,
						"data-result": result,
						children: result === void 0 ? t("detail.result.running") : t(RESULT_KEY[result])
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: board_module_css_default.executionTimes,
						children: [
							t("detail.executionStarted"),
							" ",
							formatTime(execution.startedAt, timeZone),
							execution.endedAt !== void 0 && ` · ${t("detail.executionEnded")} ${formatTime(execution.endedAt, timeZone)}`
						]
					}),
					execution.initiatedBy !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.executionTimes,
						title: execution.initiatedBy,
						children: t("detail.execution.initiator", { session: execution.initiatedBy })
					}),
					execution.sessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: board_module_css_default.linkButton,
						onClick: () => {
							onOpen(execution.sessionId);
						},
						title: execution.sessionId,
						children: [t("detail.viewSession"), " ⌁"]
					}),
					execution.error !== void 0 && execution.error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.executionError,
						children: execution.error
					}),
					execution.reworkNote !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_css_default.executionTimes,
						"data-dsh-part": "execution-rework-note",
						children: t("detail.execution.reworkNote", { note: execution.reworkNote })
					})
				]
			});
		}
		/** The execution-target editor: workspace / mode / permission pickers. */
		function ExecutionSettingsSection({ controller, task, pending }) {
			const [options, setOptions] = (0, react.useState)(controller.getSnapshot().executionOptions);
			(0, react.useEffect)(() => controller.subscribe(() => setOptions(controller.getSnapshot().executionOptions)), [controller]);
			const workspaceId = task.workspaceId ?? "";
			const mode = task.mode ?? "";
			const permission = task.permission ?? "";
			const model = task.model ?? "";
			const workspaceKnown = workspaceId === "" || options.workspaces.some((item) => item.workspaceId === workspaceId);
			const modeKnown = mode === "" || options.presets.some((item) => item.id === mode);
			const modelKnown = model === "" || (options.models ?? []).some((item) => item.id === model);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: board_module_css_default.detailSection,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.executionSettings") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_css_default.detailText,
						children: t("exec.hint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.workspace")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: workspaceId,
							disabled: pending,
							onChange: (event) => {
								controller.updateTask(task.id, { workspaceId: event.target.value });
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("exec.workspace.recent")
								}),
								!workspaceKnown && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: workspaceId,
									children: [workspaceId, t("exec.mode.removed")]
								}),
								options.workspaces.map((workspace) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: workspace.workspaceId,
									children: workspace.title
								}, workspace.workspaceId))
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.mode")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: mode,
							disabled: pending,
							onChange: (event) => {
								controller.updateTask(task.id, { mode: event.target.value });
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("exec.mode.default")
								}),
								!modeKnown && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: mode,
									children: [mode, t("exec.mode.removed")]
								}),
								options.presets.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: preset.id,
									disabled: preset.broken !== void 0,
									children: [
										preset.name ?? preset.id,
										preset.isDefault ? t("exec.mode.defaultSuffix") : "",
										preset.broken !== void 0 ? t("exec.mode.brokenSuffix") : ""
									]
								}, preset.id))
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.permission")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: permission,
							disabled: pending,
							onChange: (event) => {
								controller.updateTask(task.id, { permission: event.target.value === "" ? void 0 : event.target.value });
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("exec.permission.default")
							}), TASK_PERMISSIONS.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: id,
								children: t(`exec.permission.${id}`)
							}, id))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: board_module_css_default.fieldLabel,
							children: t("new.model")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.select,
							value: model,
							disabled: pending,
							onChange: (event) => {
								controller.updateTask(task.id, { model: event.target.value === "" ? void 0 : event.target.value });
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("exec.model.default")
								}),
								!modelKnown && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: model,
									children: [model, t("exec.model.unknown")]
								}),
								options.models?.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: item.id,
									children: item.name ?? item.id
								}, item.id))
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.scheduleToggle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: task.reuseSession === true,
							disabled: pending,
							onChange: (event) => {
								controller.updateTask(task.id, { reuseSession: event.target.checked });
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("exec.reuseSession") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_css_default.detailText,
						children: t("exec.reuseSessionHint")
					})
				]
			});
		}
		/** The scheduled-runs editor: enable toggle, cron input + presets, next-run info. */
		function ScheduleSection({ controller, task, pending }) {
			const schedule = task.schedule;
			const [cron, setCron] = (0, react.useState)(schedule?.cron ?? "0 9 * * *");
			const [enabled, setEnabled] = (0, react.useState)(schedule?.enabled ?? false);
			const [nextRunAt, setNextRunAt] = (0, react.useState)(schedule?.nextRunAt);
			const [lastTriggeredAt, setLastTriggeredAt] = (0, react.useState)(schedule?.lastTriggeredAt);
			const [error, setError] = (0, react.useState)(void 0);
			const timeZone = controller.getSnapshot().host?.scheduler.timeZone;
			(0, react.useEffect)(() => {
				setCron(schedule?.cron ?? "0 9 * * *");
				setEnabled(schedule?.enabled ?? false);
				setNextRunAt(schedule?.nextRunAt);
				setLastTriggeredAt(schedule?.lastTriggeredAt);
				setError(void 0);
			}, [
				task.id,
				schedule?.enabled,
				schedule?.cron,
				schedule?.nextRunAt,
				schedule?.lastTriggeredAt
			]);
			/** Validate + persist the current cron text (Enter or blur). */
			const saveCron = (value) => {
				const trimmed = value.trim();
				setCron(trimmed);
				if (trimmed === "" || !isValidCron(trimmed)) {
					setError(t("detail.schedule.invalid"));
					return;
				}
				setError(void 0);
				controller.setSchedule(task.id, { cron: trimmed });
			};
			/** Arm/disarm the schedule (arming first persists the edited cron). */
			const toggleEnabled = (next) => {
				const trimmed = cron.trim();
				if (next && (trimmed === "" || !isValidCron(trimmed))) {
					setError(t("detail.schedule.invalid"));
					return;
				}
				setError(void 0);
				if (controller.setSchedule(task.id, {
					enabled: next,
					...next && trimmed !== schedule?.cron ? { cron: trimmed } : {}
				}) && !controller.isHostBacked()) setEnabled(next);
			};
			const applyPreset = (preset) => {
				if (preset === "") return;
				setCron(preset);
				setError(void 0);
				controller.setSchedule(task.id, { cron: preset });
			};
			const nextLabel = !enabled || nextRunAt === void 0 ? t("detail.schedule.notScheduled") : nextRunAt <= Date.now() ? t("detail.schedule.dueSoon") : formatHostTimestamp(nextRunAt, timeZone);
			const lastLabel = lastTriggeredAt === void 0 ? "—" : formatHostTimestamp(lastTriggeredAt, timeZone);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: board_module_css_default.detailSection,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.schedule") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: board_module_css_default.scheduleToggle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: enabled,
							disabled: pending,
							onChange: (event) => {
								toggleEnabled(event.target.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("detail.schedule.enable") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.scheduleRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: `${board_module_css_default.input} ${board_module_css_default.scheduleInput}${error !== void 0 ? ` ${board_module_css_default.scheduleInputInvalid}` : ""}`,
							value: cron,
							disabled: pending,
							placeholder: "0 9 * * *",
							spellCheck: false,
							"aria-label": t("detail.schedule.cron"),
							onChange: (event) => {
								setCron(event.target.value);
								setError(void 0);
							},
							onBlur: () => {
								saveCron(cron);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter") saveCron(cron);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: board_module_css_default.schedulePreset,
							value: "",
							disabled: pending,
							"aria-label": t("detail.schedule.presets"),
							onChange: (event) => {
								applyPreset(event.target.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: "",
								children: [t("detail.schedule.presets"), "…"]
							}), SCHEDULE_PRESETS.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: preset.cron,
								children: t(preset.label)
							}, preset.cron))]
						})]
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_css_default.formError,
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: board_module_css_default.scheduleMeta,
						children: [
							t("detail.schedule.nextRun"),
							" ",
							nextLabel,
							" · ",
							t("detail.schedule.lastTriggered"),
							" ",
							lastLabel
						]
					})
				]
			});
		}
		/** Task detail overlay. */
		function TaskDetail({ controller, task }) {
			const [confirmDelete, setConfirmDelete] = (0, react.useState)(false);
			const [showEdit, setShowEdit] = (0, react.useState)(false);
			const [showEditTags, setShowEditTags] = (0, react.useState)(false);
			const [showDuplicate, setShowDuplicate] = (0, react.useState)(false);
			/** Correction remark of a rework round; cleared when it was accepted. */
			const [reworkNote, setReworkNote] = (0, react.useState)("");
			const [latest, setLatest] = (0, react.useState)(task);
			(0, react.useEffect)(() => {
				setLatest(task);
			}, [task]);
			(0, react.useEffect)(() => {
				setShowEdit(false);
				setShowEditTags(false);
				setShowDuplicate(false);
				setReworkNote("");
			}, [task.id]);
			const current = latest;
			const snapshot = controller.getSnapshot();
			const running = current.status === "running";
			const archived = current.archivedAt !== void 0;
			const pending = snapshot.pendingTaskIds.includes(current.id);
			const transportError = snapshot.transportError;
			const timeZone = snapshot.host?.scheduler.timeZone;
			const permissionPending = requiresPermissionConfirmation(current, snapshot.host?.sessionDefaultPermission);
			const machine = resolveStateMachine(snapshot.host?.stateMachine).machine;
			const moveTargets = machine.targets(current.status).filter((status) => !machine.actionsFor(current.status, status).includes("run"));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: board_module_css_default.modalBackdrop,
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) controller.closeTask();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.detail,
						role: "dialog",
						"aria-label": t("detail.title"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								className: board_module_css_default.detailHeader,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: board_module_css_default.detailTitle,
										children: current.title
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_css_default.statusBadge,
										"data-status": archived ? "archived" : current.status,
										children: archived ? t("board.archive") : t(STATUS_KEY[current.status])
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.iconButton,
										"aria-label": t("detail.close"),
										onClick: () => {
											controller.closeTask();
										},
										children: "×"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_css_default.detailBody,
								children: [
									transportError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: board_module_css_default.formError,
										children: [
											t("board.hostError", { error: transportError }),
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: board_module_css_default.linkButton,
												onClick: () => {
													controller.retryHostSync();
												},
												children: t("board.retryHost")
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.description") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: board_module_css_default.detailText,
											children: current.description !== "" ? current.description : "—"
										})]
									}),
									current.tags !== void 0 && current.tags.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										"data-dsh-part": "tags",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("new.tags") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: board_module_css_default.cardTags,
											children: current.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: board_module_css_default.cardTag,
												"data-tag-tone": tagTone(tag.name),
												"data-dsh-part": "tag-badge",
												"data-tag-hint": tag.promptPrefix === void 0 ? void 0 : tag.promptPrefix,
												title: tag.promptPrefix === void 0 ? tag.name : tag.promptPrefix,
												children: tag.name
											}, tag.name))
										})]
									}),
									current.freeze !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										"data-dsh-part": "freeze",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.freeze") }),
											current.freeze.redacted === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.formError,
												children: t("detail.freeze.redacted")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailText,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("detail.freeze.goal") })
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
												className: board_module_css_default.promptBlock,
												children: current.freeze.goal
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailText,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("detail.freeze.progress") })
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
												className: board_module_css_default.promptBlock,
												children: current.freeze.progress
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailText,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("detail.freeze.next") })
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
												className: board_module_css_default.promptBlock,
												children: current.freeze.next
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailMeta,
												children: t("detail.freeze.frozenAt", { time: formatHostTimestamp(current.freeze.frozenAt, timeZone) })
											}),
											current.freeze.frozenBy !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailMeta,
												children: t("detail.freeze.frozenBy", { session: current.freeze.frozenBy })
											})
										]
									}),
									current.handover !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										"data-dsh-part": "handover",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.handover") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
												className: board_module_css_default.detailText,
												children: [
													t("new.workspace"),
													": ",
													current.handover.workspaceId ?? t("exec.workspace.recent"),
													" · ",
													t("new.mode"),
													": ",
													current.handover.mode ?? t("exec.mode.default"),
													" · ",
													t("new.permission"),
													": ",
													current.handover.permission === void 0 ? t("exec.permission.default") : t(`exec.permission.${current.handover.permission}`)
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailText,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("detail.handover.references") })
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
												className: board_module_css_default.executionList,
												children: current.handover.references.map((reference, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
													className: board_module_css_default.executionRow,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: reference })
												}, `${reference}-${index}`))
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailMeta,
												children: t("detail.handover.bundledAt", { time: formatHostTimestamp(current.handover.bundledAt, timeZone) })
											})
										]
									}),
									permissionPending && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										"data-dsh-part": "permission-gate",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: board_module_css_default.formError,
											children: t("detail.permissionPending", { permission: t(`exec.permission.${current.handover?.permission ?? current.permission}`) })
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: board_module_css_default.primaryButton,
											disabled: pending,
											onClick: () => {
												controller.confirmPermission(current.id);
											},
											children: t("detail.permissionConfirm")
										})]
									}),
									current.permissionConfirmedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: board_module_css_default.detailMeta,
										children: t("detail.permissionConfirmed", { time: formatHostTimestamp(current.permissionConfirmedAt, timeZone) })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.prompt") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
											className: board_module_css_default.promptBlock,
											children: current.prompt !== "" ? current.prompt : current.title
										})]
									}),
									!archived && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionSettingsSection, {
										controller,
										task: current,
										pending
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScheduleSection, {
										controller,
										task: current,
										pending
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.execution") }), current.executions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: board_module_css_default.detailText,
											children: t("detail.noExecution")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
											className: board_module_css_default.executionList,
											children: [...current.executions].reverse().map((execution) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionRow, {
												execution,
												timeZone,
												onOpen: (sessionId) => {
													controller.openSession(sessionId);
												}
											}, execution.id))
										})]
									}),
									!archived && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("board.status") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: board_module_css_default.moveRow,
												children: moveTargets.map((status) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: board_module_css_default.ghostButton,
													disabled: current.status === status || running || pending,
													onClick: () => {
														controller.moveTask(current.id, status);
													},
													children: moveLabel(status)
												}, status))
											}),
											current.status === "ready_for_test" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: board_module_css_default.field,
												"data-dsh-part": "rework",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: board_module_css_default.fieldLabel,
														children: t("detail.rework.label")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: board_module_css_default.fieldHint,
														children: t("detail.rework.hint")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
														className: board_module_css_default.input,
														rows: 4,
														value: reworkNote,
														disabled: pending,
														placeholder: t("detail.rework.placeholder"),
														onChange: (event) => {
															setReworkNote(event.target.value);
														}
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: board_module_css_default.aiParseRow,
														children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: board_module_css_default.ghostButton,
															disabled: pending || reworkNote.trim() === "",
															onClick: () => {
																controller.reworkTask(current.id, reworkNote.trim()).then((accepted) => {
																	if (accepted) setReworkNote("");
																});
															},
															children: t("detail.rework.send")
														})
													})
												]
											})
										]
									}),
									!archived && current.reworkNote !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: board_module_css_default.detailSection,
										"data-dsh-part": "rework-note",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.rework.pending") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
												className: board_module_css_default.promptBlock,
												children: current.reworkNote
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: board_module_css_default.detailMeta,
												children: t("detail.rework.pendingHint")
											})
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
								className: board_module_css_default.detailFooter,
								children: [
									!archived && pending && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: board_module_css_default.detailMeta,
										children: [t("board.pending"), "…"]
									}),
									!archived && canEditTaskContent(current) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.ghostButton,
										disabled: pending,
										onClick: () => {
											setShowEdit(true);
										},
										children: t("detail.edit")
									}),
									!archived && !canEditTaskContent(current) && current.status !== "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.ghostButton,
										disabled: pending,
										onClick: () => {
											setShowEditTags(true);
										},
										children: t("detail.editTags")
									}),
									!archived && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.ghostButton,
										disabled: pending,
										onClick: () => {
											setShowDuplicate(true);
										},
										title: canEditTaskContent(current) ? t("detail.duplicate") : t("detail.duplicateAndEdit"),
										children: canEditTaskContent(current) ? t("detail.duplicate") : t("detail.duplicateAndEdit")
									}),
									!archived && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.primaryButton,
										disabled: running || pending,
										onClick: () => {
											controller.rerunTask(current.id).then(() => {
												if (controller.getSnapshot().transportError === void 0) controller.closeTask();
											});
										},
										children: current.executions.length === 0 ? t("detail.run") : t("detail.rerun")
									}),
									archived ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.primaryButton,
										disabled: pending,
										onClick: () => {
											controller.restoreTask(current.id);
										},
										children: t("detail.restore")
									}) : (current.status === "done" || current.status === "failed") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.ghostButton,
										disabled: pending,
										onClick: () => {
											controller.archiveTask(current.id);
										},
										children: t("detail.archive")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: board_module_css_default.dangerButton,
										disabled: pending,
										onClick: () => {
											setConfirmDelete(true);
										},
										children: t("detail.delete")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: board_module_css_default.detailMeta,
										children: [
											t("board.created"),
											" ",
											formatTime(current.createdAt, timeZone),
											archived && ` · ${t("detail.archivedAt", { time: formatTime(current.archivedAt, timeZone) })}`
										]
									})
								]
							})
						]
					}),
					confirmDelete && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmDialog, {
						title: t("delete.title"),
						message: t("delete.confirm", { name: current.title }),
						confirmLabel: t("delete.ok"),
						danger: true,
						onCancel: () => {
							setConfirmDelete(false);
						},
						onConfirm: () => {
							setConfirmDelete(false);
							controller.deleteTask(current.id);
						}
					}),
					showEdit && !archived && canEditTaskContent(current) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EditTaskModal, {
						controller,
						task: current,
						onClose: () => {
							setShowEdit(false);
						}
					}),
					showEditTags && !archived && current.status !== "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EditTagsModal, {
						controller,
						task: current,
						onClose: () => {
							setShowEditTags(false);
						}
					}),
					showDuplicate && !archived && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NewTaskModal, {
						controller,
						initialTask: current,
						onClose: () => {
							setShowDuplicate(false);
						},
						onDuplicateSuccess: async (sourceId) => {
							await controller.archiveTask(sourceId);
							controller.closeTask();
						}
					})
				]
			});
		}
		/**
		* Drag payload MIME type carrying the whole group: a JSON array of card ids in
		* board (display) order. `text/plain` keeps the lead card's id so an external
		* drop target, an older board, or a plain single-card drag still works.
		*/
		const BATCH_DRAG_MIME = "application/x-dsh-taskboard-cards";
		/** Stable empty set, so clearing the drag marker keeps the same reference. */
		const NO_IDS = /* @__PURE__ */ new Set();
		/**
		* Dropping onto a column whose transition carries the `run` action starts the
		* task (the same Host action as the detail view's Run button): the machine
		* declares that entry, the runner owns it. Such a column accepts the drop even
		* with `"drop": false` (the shipped `running` column does).
		*/
		function isRunColumn(machine, status) {
			return machine.config.transitions.some((item) => item.to === status && (item.actions ?? []).includes("run"));
		}
		/**
		* The cards of one column in the order the board renders them. The
		* runner-owned column reads as a work queue — the card being executed now sits
		* on top, the runs still waiting for a WIP slot follow in arrival order (the
		* card dragged in last sits at the bottom) — every other column keeps the
		* ledger's order. Rendering and the Shift-click range share this, so the two
		* never disagree about what "between two cards" means.
		*/
		function columnTasks(machine, visible, status) {
			const tasks = visible.filter((task) => task.status === status);
			if (isRunColumn(machine, status)) tasks.sort(compareWipOrder);
			return tasks;
		}
		/**
		* The dragged card ids: the batch payload when present and well-formed, else
		* the lead id from `text/plain` (single-card drags and older writers).
		*/
		function readDragIds(dataTransfer, lead) {
			const raw = typeof dataTransfer.getData === "function" ? dataTransfer.getData(BATCH_DRAG_MIME) : "";
			if (raw !== "") try {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((id) => typeof id === "string" && id !== "")) return parsed;
			} catch {}
			return lead === "" ? [] : [lead];
		}
		/** Case-insensitive title/description/tag/freeze-snapshot match. */
		function matchesFilter(task, filter) {
			if (filter.trim() === "") return true;
			const needle = filter.trim().toLowerCase();
			const haystacks = [
				task.title,
				task.description,
				...(task.tags ?? []).map((tag) => tag.name)
			];
			if (task.freeze !== void 0) haystacks.push(task.freeze.goal, task.freeze.progress, task.freeze.next);
			return haystacks.some((text) => text.toLowerCase().includes(needle));
		}
		/**
		* Whether a task carries every selected label (issue #1521). Multi-select is
		* conjunctive: adding a label narrows the board instead of widening it, which
		* is the only reading that keeps "工作" selected from dragging unrelated cards
		* back in when a second label is added.
		*/
		function matchesTagFilter(task, selected) {
			if (selected.length === 0) return true;
			const names = new Set((task.tags ?? []).map((tag) => tag.name));
			return selected.every((name) => names.has(name));
		}
		/**
		* Memoized per-card adapter: with a stable `onOpen` from the board and an
		* immutable task record (only the changed card gets a new object ref), a card
		* re-renders only when its own task changes — not when a sibling card status,
		* the filter, or the selection moves.
		*/
		const MemoTaskCard = (0, react.memo)(function MemoTaskCard({ task, pending, timeZone, selected, dragging, onSelect, onKeySelect, onOpen, onDragStart, onDragEnd, onOpenSession }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
				task,
				pending,
				timeZone,
				selected,
				dragging,
				onClick: (0, react.useCallback)((event) => {
					onSelect(task.id, event);
				}, [task.id, onSelect]),
				onKeyDown: (0, react.useCallback)((event) => {
					onKeySelect(task.id, event);
				}, [task.id, onKeySelect]),
				onDoubleClick: (0, react.useCallback)(() => {
					onOpen(task.id);
				}, [task.id, onOpen]),
				onDragStart: (0, react.useCallback)((event) => {
					onDragStart(task.id, event);
				}, [task.id, onDragStart]),
				onDragEnd,
				onOpenSession
			});
		});
		/** Board component; subscribes to the controller snapshot. */
		function TaskBoard({ controller }) {
			const [snapshot, setSnapshot] = (0, react.useState)(controller.getSnapshot());
			(0, react.useEffect)(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
			const [filter, setFilter] = (0, react.useState)("");
			const [tagFilter, setTagFilter] = (0, react.useState)([]);
			const [showNew, setShowNew] = (0, react.useState)(false);
			const [projectId, setProjectId] = (0, react.useState)("");
			const [showNewProject, setShowNewProject] = (0, react.useState)(false);
			const [newProjectPath, setNewProjectPath] = (0, react.useState)("");
			const [newProjectError, setNewProjectError] = (0, react.useState)(void 0);
			const [newProjectPending, setNewProjectPending] = (0, react.useState)(false);
			const [selectedIds, setSelectedIds] = (0, react.useState)(NO_IDS);
			const [dragIds, setDragIds] = (0, react.useState)(NO_IDS);
			const anchorRef = (0, react.useRef)(void 0);
			const selected = selectedTaskOf(snapshot);
			const archiveView = snapshot.archiveView;
			const machine = resolveStateMachine(snapshot.host?.stateMachine).machine;
			const knownTags = collectKnownTags(snapshot.tasks);
			const pendingSet = (0, react.useMemo)(() => new Set(snapshot.pendingTaskIds), [snapshot.pendingTaskIds]);
			const visible = (0, react.useMemo)(() => snapshot.tasks.filter((task) => (archiveView ? task.archivedAt !== void 0 : task.archivedAt === void 0) && (projectId === "" || task.workspaceId === projectId) && matchesFilter(task, filter) && matchesTagFilter(task, tagFilter)), [
				snapshot.tasks,
				archiveView,
				projectId,
				filter,
				tagFilter
			]);
			const selectableIds = (0, react.useMemo)(() => visible.filter((task) => selectedIds.has(task.id) && isCardDraggable(task, pendingSet.has(task.id))).map((task) => task.id), [
				visible,
				selectedIds,
				pendingSet
			]);
			const boardOrderIds = (0, react.useMemo)(() => archiveView ? [] : machine.states.flatMap((column) => columnTasks(machine, visible, column.status).map((task) => task.id)), [
				archiveView,
				machine,
				visible
			]);
			const projects = snapshot.executionOptions.workspaces;
			const canCreateProject = snapshot.canCreateWorkspace === true;
			const submitNewProject = async () => {
				const path = newProjectPath.trim();
				if (path === "") return;
				setNewProjectPending(true);
				setNewProjectError(void 0);
				try {
					const created = await controller.createWorkspace(path);
					setProjectId(created.workspaceId);
					setShowNewProject(false);
					setNewProjectPath("");
				} catch (error) {
					setNewProjectError(error instanceof Error ? error.message : String(error));
				} finally {
					setNewProjectPending(false);
				}
			};
			const toggleTag = (0, react.useCallback)((name) => {
				setTagFilter((current) => current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]);
			}, []);
			const clearSelection = (0, react.useCallback)(() => {
				anchorRef.current = void 0;
				setSelectedIds((current) => current.size === 0 ? current : NO_IDS);
			}, []);
			const markCard = (0, react.useCallback)((id, modifiers) => {
				const to = boardOrderIds.indexOf(id);
				if (to < 0) return;
				if (modifiers.shift) {
					const from = anchorRef.current === void 0 ? -1 : boardOrderIds.indexOf(anchorRef.current);
					if (from < 0) {
						anchorRef.current = id;
						setSelectedIds(/* @__PURE__ */ new Set([id]));
						return;
					}
					setSelectedIds(new Set(boardOrderIds.slice(Math.min(from, to), Math.max(from, to) + 1)));
					return;
				}
				if (modifiers.toggle) {
					anchorRef.current = id;
					setSelectedIds((current) => {
						const next = new Set(current);
						if (next.has(id)) next.delete(id);
						else next.add(id);
						return next;
					});
					return;
				}
				anchorRef.current = id;
				setSelectedIds(/* @__PURE__ */ new Set([id]));
			}, [boardOrderIds]);
			const selectCard = (0, react.useCallback)((id, event) => {
				if (archiveView) {
					controller.openTask(id);
					return;
				}
				if (event.detail === 0) {
					controller.openTask(id);
					return;
				}
				markCard(id, {
					shift: event.shiftKey,
					toggle: event.metaKey || event.ctrlKey
				});
			}, [
				archiveView,
				controller,
				markCard
			]);
			const selectCardByKey = (0, react.useCallback)((id, event) => {
				if (event.key !== " ") return;
				event.preventDefault();
				if (archiveView) {
					controller.openTask(id);
					return;
				}
				markCard(id, {
					shift: event.shiftKey,
					toggle: event.metaKey || event.ctrlKey
				});
			}, [
				archiveView,
				controller,
				markCard
			]);
			const openDetail = (0, react.useCallback)((id) => {
				controller.openTask(id);
			}, [controller]);
			const openSession = (0, react.useCallback)((sessionId) => {
				controller.openSession?.(sessionId);
			}, [controller]);
			const endDrag = (0, react.useCallback)(() => {
				setDragIds(NO_IDS);
			}, []);
			const startDrag = (0, react.useCallback)((id, event) => {
				const task = snapshot.tasks.find((item) => item.id === id);
				if (task === void 0 || !isCardDraggable(task, pendingSet.has(id))) return;
				const ids = selectedIds.has(id) && selectableIds.includes(id) ? selectableIds : [id];
				event.dataTransfer.setData("text/plain", id);
				event.dataTransfer.setData(BATCH_DRAG_MIME, JSON.stringify(ids));
				event.dataTransfer.effectAllowed = "move";
				setDragIds(new Set(ids));
			}, [
				pendingSet,
				selectableIds,
				selectedIds,
				snapshot.tasks
			]);
			const dropOnColumn = (0, react.useCallback)((columnStatus, isRunTarget, event) => {
				event.preventDefault();
				const ids = readDragIds(event.dataTransfer, event.dataTransfer.getData("text/plain"));
				setDragIds(NO_IDS);
				const movable = ids.map((id) => snapshot.tasks.find((task) => task.id === id)).filter((task) => task !== void 0).filter((task) => isCardDraggable(task, pendingSet.has(task.id))).filter((task) => isRunTarget ? task.status !== columnStatus && machine.actionsFor(task.status, columnStatus).includes("run") : machine.canTransition(task.status, columnStatus));
				if (movable.length === 0) return;
				if (isRunTarget) {
					(async () => {
						for (const task of movable) await controller.rerunTask(task.id);
					})();
					clearSelection();
					return;
				}
				const moving = movable.map((task) => task.id);
				if (moving.length === 1) {
					controller.moveTask(moving[0], columnStatus);
					clearSelection();
					return;
				}
				controller.moveTasks(moving, columnStatus).then((moved) => {
					if (moved) clearSelection();
				});
			}, [
				clearSelection,
				controller,
				machine,
				pendingSet,
				snapshot.tasks
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: board_module_css_default.board,
				"data-dsh-taskboard-board": "",
				"data-dsh-plugin": "task-board",
				onClick: (event) => {
					if (event.target.closest("[data-dsh-part=\"card-box\"]") !== null) return;
					clearSelection();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: board_module_css_default.boardHeader,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: `${board_module_css_default.ghostButton} ${board_module_css_default.backButton}`,
								"data-dsh-center-view-back": "",
								"aria-label": t("board.close"),
								onClick: () => {
									controller.closeBoard();
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: "‹"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("board.close") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: board_module_css_default.boardTitle,
								children: t("board.title")
							}),
							snapshot.host !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_css_default.detailMeta,
								children: t("board.hostMeta", {
									revision: String(snapshot.host.revision),
									timeZone: snapshot.host.scheduler.timeZone
								})
							}),
							selectedIds.size > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: board_module_css_default.selectionBar,
								"data-dsh-part": "selection-bar",
								role: "status",
								children: [t("board.selectedCount", { count: String(selectedIds.size) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_css_default.linkButton,
									onClick: clearSelection,
									children: t("board.selectionClear")
								})]
							}),
							(projects.length > 0 || canCreateProject) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_css_default.projectFilter,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_css_default.projectFilterLabel,
									children: t("board.project")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: board_module_css_default.select,
									"data-dsh-part": "project-filter",
									value: projectId,
									"aria-label": t("board.project"),
									onChange: (event) => {
										const value = event.target.value;
										if (value === "__dsh_new_project__") {
											setNewProjectError(void 0);
											setShowNewProject(true);
											return;
										}
										setProjectId(value);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: t("board.projectAll")
										}),
										projects.map((project) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: project.workspaceId,
											children: project.title
										}, project.workspaceId)),
										canCreateProject && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "__dsh_new_project__",
											children: t("board.projectNew")
										})
									]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: board_module_css_default.search,
								type: "search",
								placeholder: t("board.search"),
								value: filter,
								onChange: (event) => {
									setFilter(event.target.value);
								},
								"aria-label": t("board.search")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: archiveView ? board_module_css_default.primaryButton : board_module_css_default.ghostButton,
								onClick: () => {
									clearSelection();
									controller.toggleArchiveView();
								},
								children: archiveView ? t("board.backToBoard") : t("board.archiveView", { count: String(snapshot.tasks.filter((task) => task.archivedAt !== void 0).length) })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: board_module_css_default.primaryButton,
								onClick: () => {
									setShowNew(true);
								},
								children: ["+ ", t("board.new")]
							})
						]
					}),
					showNewProject && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.projectDialog,
						"data-dsh-part": "project-dialog",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_css_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_css_default.fieldLabel,
									children: t("board.projectNewPath")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: board_module_css_default.input,
									value: newProjectPath,
									placeholder: t("board.projectNewPathPlaceholder"),
									spellCheck: false,
									onChange: (event) => {
										setNewProjectPath(event.target.value);
										setNewProjectError(void 0);
									}
								})]
							}),
							newProjectError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: board_module_css_default.formError,
								children: t("board.projectCreateFailed", { error: newProjectError })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_css_default.projectDialogActions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_css_default.ghostButton,
									onClick: () => {
										setShowNewProject(false);
										setNewProjectError(void 0);
									},
									children: t("new.cancel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_css_default.primaryButton,
									disabled: newProjectPending || newProjectPath.trim() === "",
									onClick: () => {
										submitNewProject();
									},
									children: t("board.projectCreate")
								})]
							})
						]
					}),
					!archiveView && knownTags.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.tagFilter,
						"data-dsh-part": "tag-filter",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_css_default.tagFilterLabel,
								children: t("board.tagFilter")
							}),
							knownTags.map((tag) => {
								const active = tagFilter.includes(tag.name);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_css_default.tagChip,
									"data-dsh-part": "tag-chip",
									"data-tag-tone": tagTone(tag.name),
									"data-active": active ? "true" : void 0,
									"aria-pressed": active,
									title: tag.promptPrefix === void 0 ? tag.name : tag.promptPrefix,
									onClick: () => {
										toggleTag(tag.name);
									},
									children: tag.name
								}, tag.name);
							}),
							tagFilter.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_css_default.linkButton,
								onClick: () => {
									setTagFilter([]);
								},
								children: t("board.tagFilterClear")
							})
						]
					}),
					snapshot.transportError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.formError,
						children: [
							t("board.hostError", { error: snapshot.transportError }),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_css_default.linkButton,
								onClick: () => {
									controller.retryHostSync();
								},
								children: t("board.retryHost")
							})
						]
					}),
					snapshot.sessionOpenError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_css_default.formError,
						"data-dsh-part": "session-error",
						children: [
							t("board.sessionOpenError", { error: snapshot.sessionOpenError }),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_css_default.linkButton,
								onClick: () => {
									controller.dismissSessionOpenError?.();
								},
								children: t("board.dismiss")
							})
						]
					}),
					dragIds.size > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: board_module_css_default.dragBadge,
						"data-dsh-part": "drag-count",
						role: "status",
						children: t("board.dragCount", { count: String(dragIds.size) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: board_module_css_default.columns,
						children: archiveView ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: board_module_css_default.column,
							"data-status": "archived",
							"data-dsh-part": "column",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								className: board_module_css_default.columnHeader,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: board_module_css_default.columnTitle,
									children: t("board.archive")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_css_default.columnCount,
									children: visible.length
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_css_default.cards,
								children: [visible.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoTaskCard, {
									task,
									pending: pendingSet.has(task.id),
									timeZone: snapshot.host?.scheduler.timeZone,
									selected: false,
									dragging: false,
									onSelect: selectCard,
									onKeySelect: selectCardByKey,
									onOpen: openDetail,
									onDragStart: startDrag,
									onDragEnd: endDrag,
									onOpenSession: openSession
								}, task.id)), visible.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: board_module_css_default.columnEmpty,
									children: tagFilter.length > 0 ? t("board.tagEmpty") : t("archive.empty")
								})]
							})]
						}) : machine.states.map((column) => {
							const tasks = columnTasks(machine, visible, column.status);
							const isRunDropTarget = isRunColumn(machine, column.status);
							const isDropTarget = machine.acceptsDrop(column.status) || isRunDropTarget;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: board_module_css_default.column,
								"data-status": column.status,
								"data-dsh-part": "column",
								onDragOver: isDropTarget ? (event) => {
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
								} : void 0,
								onDrop: isDropTarget ? (event) => {
									dropOnColumn(column.status, isRunDropTarget, event);
								} : void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
									className: board_module_css_default.columnHeader,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: board_module_css_default.statusDot,
											"data-status": column.status,
											"aria-hidden": "true"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											className: board_module_css_default.columnTitle,
											children: column.label ?? t(`board.status.${column.status}`)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: board_module_css_default.columnCount,
											children: tasks.length
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: board_module_css_default.cards,
									children: [tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoTaskCard, {
										task,
										pending: pendingSet.has(task.id),
										timeZone: snapshot.host?.scheduler.timeZone,
										selected: selectedIds.has(task.id),
										dragging: dragIds.has(task.id),
										onSelect: selectCard,
										onKeySelect: selectCardByKey,
										onOpen: openDetail,
										onDragStart: startDrag,
										onDragEnd: endDrag,
										onOpenSession: openSession
									}, task.id)), tasks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: board_module_css_default.columnEmpty,
										children: tagFilter.length > 0 ? t("board.tagEmpty") : t("board.empty")
									})]
								})]
							}, column.status);
						})
					}),
					selected !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskDetail, {
						controller,
						task: selected
					}),
					showNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NewTaskModal, {
						controller,
						...projectId === "" ? {} : { defaultWorkspaceId: projectId },
						onClose: () => {
							setShowNew(false);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/body-mutations.ts
		/** Cross-bundle registry key; `Symbol.for` so every module copy agrees. */
		const HUB_KEY = Symbol.for("dsh-web.body-mutation-hub");
		const INVALIDATION_ONLY = Symbol.for("dsh-web.body-mutation-invalidation");
		function needsRecords(subscribers) {
			for (const listener of subscribers) if (!listener[INVALIDATION_ONLY]) return true;
			return false;
		}
		/**
		* Subscribe to a coalesced DOM re-check without retaining mutation records.
		* The marked wrapper also works with an older hub, which delivers records
		* that it simply ignores until a page reload picks up the updated hub.
		*/
		function subscribeBodyInvalidations(subscriber) {
			const listener = () => {
				subscriber();
			};
			listener[INVALIDATION_ONLY] = true;
			return subscribeBodyMutations(listener);
		}
		/**
		* Subscribe to body-level childList mutations.
		* @param subscriber - called at most once per animation frame with the records
		*   collected since the previous flush; must be safe to run repeatedly.
		* @returns the disposer removing this subscriber (and the observer when it was
		*   the last one).
		*/
		function subscribeBodyMutations(subscriber) {
			if (typeof globalThis === "undefined" || typeof document === "undefined") return () => {};
			if (typeof MutationObserver !== "function") return () => {};
			const registry = globalThis;
			let hub = registry[HUB_KEY];
			if (hub === void 0) {
				const subscribers = /* @__PURE__ */ new Set();
				const created = {
					observer: void 0,
					subscribers,
					pending: [],
					scheduled: false
				};
				const flush = () => {
					created.frame = void 0;
					created.scheduled = false;
					const batch = created.pending;
					created.pending = [];
					for (const listener of [...subscribers]) {
						if (!subscribers.has(listener)) continue;
						try {
							listener(batch);
						} catch {}
					}
				};
				const schedule = () => {
					if (created.scheduled) return;
					created.scheduled = true;
					if (typeof requestAnimationFrame === "function") created.frame = requestAnimationFrame(flush);
					else flush();
				};
				created.observer = new MutationObserver((records) => {
					if (needsRecords(subscribers)) for (const record of records) created.pending.push(record);
					schedule();
				});
				created.observer.observe(document.body ?? document.documentElement, {
					childList: true,
					subtree: true
				});
				registry[HUB_KEY] = created;
				hub = created;
			}
			const active = hub;
			active.subscribers.add(subscriber);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				active.subscribers.delete(subscriber);
				if (!needsRecords(active.subscribers)) active.pending = [];
				if (active.subscribers.size === 0 && registry[HUB_KEY] === active) {
					active.observer.disconnect();
					if (active.frame !== void 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(active.frame);
					active.frame = void 0;
					active.pending = [];
					active.scheduled = false;
					delete registry[HUB_KEY];
				}
			};
		}
		//#endregion
		//#region src/client/panel-mount-core.ts
		/**
		* Center-column panel takeover lifecycle.
		*
		* The `conversation` slot is single-occupant (ui-conversation) and external
		* plugins cannot declare slots, so a family panel takes over the center
		* column at the DOM level: a container is appended inside the center column
		* (`[class*="centerCol"]`, the 0.1.0-rc.6+ AppFrame layout; previously
		* `[data-pane="conversation"]` on older shells — the mount selector keeps
		* both, ssh #243 / task-board #107) as an extra trailing child React never
		* manages, and a stylesheet rule hides the conversation content while the
		* panel is active. Toggling is a data attribute on <html> — no React
		* involvement, so the conversation subtree underneath stays mounted and
		* stateful.
		*
		* Consuming plugins keep a thin wrapper that supplies the panel tree,
		* container attribute names, and stylesheet class; those names are pinned by
		* each package's CSS, skins, and the semantic-attributes contract. The
		* sidebar row toggling the panel shares its core the same way
		* (shared/client/sidebar-entry-core.ts, synced copy).
		*/
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"]";
		/** Cross-plugin activation event; detail is the activating panel name. */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
		/** Find the center column, or undefined while the frame is not mounted. */
		function conversationColumn() {
			return document.querySelector(CONVERSATION_COLUMN_SELECTOR) ?? void 0;
		}
		/**
		* Mount a family panel into the center column and bind its visibility to the
		* owning controller's open state.
		* @returns disposer unmounting the tree and restoring the column.
		*/
		function mountCenterPanel(options) {
			let root;
			let container;
			let unsubscribeLocale;
			try {
				unsubscribeLocale = options.locale?.subscribe(() => {
					if (root !== void 0) options.render(root);
				});
			} catch {}
			const ensure = () => {
				if (container !== void 0 && !container.isConnected) {
					root?.unmount();
					root = void 0;
					container.remove();
					container = void 0;
				}
				if (container === void 0) {
					const column = conversationColumn();
					if (column === void 0) return;
					container = document.createElement("div");
					container.dataset[options.viewDatasetKey] = "";
					container.dataset.dshPlugin = options.pluginName;
					container.className = options.viewClassName;
					column.appendChild(container);
				}
				if (root !== void 0 || !options.isOpen()) return;
				root = (0, react_dom_client.createRoot)(container);
				options.render(root);
			};
			const unsubscribeBody = subscribeBodyInvalidations(() => {
				ensure();
			});
			const applyActive = () => {
				if (options.isOpen()) {
					ensure();
					document.documentElement.removeAttribute(options.siblingActiveAttribute);
					document.documentElement.setAttribute(options.activeAttribute, "");
					document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: options.panelName }));
				} else document.documentElement.removeAttribute(options.activeAttribute);
			};
			const onOtherActivate = (event) => {
				if (event.detail === options.siblingPanelName && options.isOpen()) options.close();
			};
			const onClickSidebarRow = (event) => {
				if (!options.isOpen()) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) options.close();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			const unsubscribe = options.subscribe(applyActive);
			applyActive();
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				unsubscribeBody();
				unsubscribe();
				unsubscribeLocale?.();
				document.documentElement.removeAttribute(options.activeAttribute);
				root?.unmount();
				root = void 0;
				container?.remove();
				container = void 0;
			};
		}
		//#endregion
		//#region src/client/board-mount.tsx
		/**
		* Mount the board React tree into the center column and bind its visibility
		* to the controller's boardOpen state.
		* @param controller - the board controller driving the view.
		* @param locale - locale-change source; when given, re-renders a mounted board
		*   on a Language switch.
		* @returns disposer unmounting the tree and restoring the column.
		*/
		function mountBoard(controller, locale) {
			return mountCenterPanel({
				render: (root) => root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskBoard, { controller })),
				viewDatasetKey: "dshTaskboardView",
				pluginName: "task-board",
				viewClassName: board_module_css_default.boardView,
				activeAttribute: "data-dsh-taskboard-active",
				siblingActiveAttribute: "data-dsh-ssh-active",
				panelName: "taskboard",
				siblingPanelName: "ssh",
				isOpen: () => controller.getSnapshot().boardOpen,
				close: () => controller.closeBoard(),
				subscribe: (listener) => controller.subscribe(listener),
				locale
			});
		}
		//#endregion
		//#region src/client/sidebar-entry-core.ts
		/**
		* Shared sidebar entry injection core.
		*
		* dsh's sidebar shell exposes no slot an external plugin can register into,
		* so the entry row is injected between the shell's New Session button and the
		* workspace browser. The injection self-heals: a MutationObserver watches the
		* sidebar root and re-inserts the row whenever a React re-render displaces it
		* (re-insertion happens in the same frame, before paint, so no flicker).
		*
		* The row is plain DOM (no React tree) so it can never disturb the shell's
		* reconciliation; the view it toggles is a separate root owned by the caller.
		*
		* Packages receive this file as a generated copy via scripts/sync-shared.mjs;
		* edit the shared source and re-run the sync instead of editing a copy.
		*/
		/** Find the sidebar shell root element, or undefined while not yet mounted. */
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
		function newSessionButton(root) {
			const nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (const child of root.children) if (child.tagName === "BUTTON") return child;
		}
		/** Build the entry row (a detached button; insert once the shell is up). */
		function createEntry(options) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.setAttribute(options.rowAttribute, "");
			if (options.plugin !== void 0) {
				entry.setAttribute("data-dsh-plugin", options.plugin);
				entry.setAttribute("data-dsh-part", "sidebar-entry");
			}
			entry.className = options.css["entry"] ?? "";
			const labelSpan = document.createElement("span");
			labelSpan.className = options.css["entryLabel"] ?? "";
			const iconSpan = document.createElement("span");
			iconSpan.className = options.css["entryIcon"] ?? "";
			iconSpan.innerHTML = options.icon;
			entry.append(iconSpan, labelSpan);
			const applyLabel = () => {
				entry.setAttribute("aria-label", options.label());
				if (options.tooltip !== void 0) entry.setAttribute("title", options.tooltip());
				labelSpan.textContent = options.label();
			};
			applyLabel();
			entry.addEventListener("click", options.onToggle);
			return {
				entry,
				applyLabel
			};
		}
		/** Re-insert the entry after the New Session row (before the browser region). */
		function placeEntry(root, entry, options) {
			const button = newSessionButton(root);
			if (button === void 0) return false;
			if (entry.parentElement !== root) {
				const row = button.closest("[class*=\"logoRow\"]");
				const base = row !== null && row.parentElement === root ? row : button;
				const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches(options.familySelectors.join(", ")));
				const anchor = options.position === "before" ? family.length > 0 ? family[0] : base.nextElementSibling : family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @param options - the row's attribute/icon/copy/action/ordering configuration.
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry$1(options) {
			if (typeof document !== "undefined" && document.querySelector(options.rowSelector) !== null) return () => {};
			const { entry, applyLabel } = createEntry(options);
			let root;
			let placed = false;
			let unsubscribeRefresh;
			if (options.refresh !== void 0) try {
				unsubscribeRefresh = options.refresh.subscribe(applyLabel);
			} catch {}
			const tryPlace = () => {
				if (root !== void 0 && !root.isConnected) {
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				placed = placeEntry(root, entry, options);
				if (placed) rootObserver.observe(root, {
					childList: true,
					subtree: true
				});
			};
			const unsubscribeBody = subscribeBodyInvalidations(() => {
				tryPlace();
			});
			const rootObserver = new MutationObserver(() => {
				if (root === void 0 || !root.isConnected) {
					placed = false;
					tryPlace();
					return;
				}
				if (!root.contains(entry)) placed = placeEntry(root, entry, options);
			});
			const unsubscribeActive = options.active === void 0 ? void 0 : (() => {
				const syncActive = () => {
					if (options.active.isOpen()) entry.dataset.active = "true";
					else delete entry.dataset.active;
				};
				const unsubscribe = options.active.subscribe(syncActive);
				syncActive();
				return unsubscribe;
			})();
			tryPlace();
			return () => {
				unsubscribeBody();
				rootObserver.disconnect();
				unsubscribeRefresh?.();
				unsubscribeActive?.();
				entry.remove();
			};
		}
		//#endregion
		//#region src/client/sidebar-entry.ts
		/** Stable data attribute identifying the injected entry row. */
		const ENTRY_SELECTOR = "[data-dsh-taskboard-entry]";
		/** Inline icon normalized to the shell's 18px navigation glyph size. */
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"2\" y=\"2.5\" width=\"12\" height=\"11\" rx=\"1.5\"/><path d=\"M2 6.5h12M6.5 6.5v7\"/></svg>";
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @param controller - the board controller the entry toggles.
		* @param locale - locale-change source; when given, re-applies the label on
		*   a Language switch (the plain-DOM row otherwise keeps the mount-time copy).
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry(controller, locale) {
			return mountSidebarEntry$1({
				rowAttribute: "data-dsh-taskboard-entry",
				rowSelector: ENTRY_SELECTOR,
				plugin: "task-board",
				icon: ICON,
				css: board_module_css_default,
				label: () => t("entry.label"),
				refresh: locale === void 0 ? void 0 : { subscribe: (listener) => locale.subscribe(listener) },
				onToggle: () => {
					controller.toggleBoard();
				},
				position: "before",
				familySelectors: ["[data-dsh-taskboard-entry]", "[data-dsh-ssh-entry]"],
				active: {
					subscribe: (listener) => controller.subscribe(listener),
					isOpen: () => controller.getSnapshot().boardOpen
				}
			});
		}
		//#endregion
		//#region \0dsh-css:src/client/settings-card.module.css.mjs
		const css = ".KApx_W_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.KApx_W_card:hover{border-color:var(--dsw-alias-label-dimmed)}.KApx_W_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.KApx_W_header{appearance:none;box-sizing:border-box;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.KApx_W_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.KApx_W_headerStatic{box-sizing:border-box;border-radius:12px;align-items:center;gap:12px;width:100%;padding:14px 16px;display:flex}.KApx_W_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.KApx_W_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.KApx_W_description{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}.KApx_W_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.KApx_W_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.KApx_W_chevronOpen{transform:rotate(180deg)}.KApx_W_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.KApx_W_readOnly{color:var(--dsw-alias-label-secondary);margin:12px 0 0;font-size:12px;line-height:1.5}.KApx_W_notExposed{color:var(--dsw-alias-state-warn-primary);margin:12px 0 0;font-size:12px;line-height:1.5}.KApx_W_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.KApx_W_failed{min-width:0;color:var(--dsw-alias-state-error-primary,#b42318);text-overflow:ellipsis;white-space:nowrap;flex:1;margin:0;font-size:12px;line-height:1.5;overflow:hidden}.KApx_W_discard,.KApx_W_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.KApx_W_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.KApx_W_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.KApx_W_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.KApx_W_discard:disabled,.KApx_W_save:disabled{opacity:.4;cursor:default}.KApx_W_discard:focus-visible,.KApx_W_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.KApx_W_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.KApx_W_field+.KApx_W_field{border-top:1px solid var(--dsw-alias-border-l2)}.KApx_W_head{align-items:center;gap:8px;display:flex}.KApx_W_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.KApx_W_badges{align-items:center;gap:8px;display:inline-flex}.KApx_W_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.KApx_W_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.KApx_W_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.KApx_W_reset:disabled{cursor:default}.KApx_W_reset:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.KApx_W_input,.KApx_W_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.KApx_W_input:focus-visible,.KApx_W_select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.KApx_W_input:disabled,.KApx_W_select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.KApx_W_inputInvalid{border:1px solid var(--dsw-alias-state-error-primary,#b42318);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.KApx_W_inputInvalid:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary,#b42318);outline-offset:1px;border-color:var(--dsw-alias-state-error-primary,#b42318)}.KApx_W_selectWrap{position:relative}.KApx_W_selectButton{appearance:none;text-align:left;cursor:pointer;justify-content:space-between;align-items:center;gap:8px;width:100%;display:flex}.KApx_W_selectLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.KApx_W_selectChevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.KApx_W_selectChevronOpen{transform:rotate(180deg)}.KApx_W_selectPopup{z-index:40;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);max-height:240px;box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2);opacity:0;border-radius:8px;flex-direction:column;padding:4px;transition:opacity .1s,transform .1s;display:flex;position:absolute;top:calc(100% + 4px);left:0;right:0;overflow-y:auto;transform:translateY(-4px)}.KApx_W_selectPopupOpen{opacity:1;transform:none}.KApx_W_selectPopupClose{opacity:0;pointer-events:none;transform:translateY(-4px)}.KApx_W_selectOption{color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;text-overflow:ellipsis;border-radius:6px;flex-shrink:0;padding:6px 10px;font-size:13px;line-height:1.5;overflow:hidden}.KApx_W_selectOption:hover,.KApx_W_selectOptionActive{background:var(--dsw-alias-interactive-bg-hover)}.KApx_W_selectOptionSelected{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 10%, transparent);font-weight:500}.KApx_W_invalid{color:var(--dsw-alias-state-error-primary,#b42318);margin:0;font-size:12px;line-height:1.5}.KApx_W_hint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5}@media (prefers-reduced-motion:reduce){.KApx_W_card,.KApx_W_header,.KApx_W_chevron,.KApx_W_chevronOpen,.KApx_W_discard,.KApx_W_save,.KApx_W_selectChevron,.KApx_W_selectChevronOpen,.KApx_W_selectPopup{transition:none}}";
		const tagId = "dsh-next-task-board/src/client/settings-card.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-next-task-board";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var settings_card_module_css_default = {
			"badge": "KApx_W_badge",
			"badges": "KApx_W_badges",
			"body": "KApx_W_body",
			"card": "KApx_W_card",
			"cardOpen": "KApx_W_cardOpen",
			"chevron": "KApx_W_chevron",
			"chevronOpen": "KApx_W_chevronOpen",
			"description": "KApx_W_description",
			"discard": "KApx_W_discard",
			"failed": "KApx_W_failed",
			"field": "KApx_W_field",
			"footer": "KApx_W_footer",
			"head": "KApx_W_head",
			"headText": "KApx_W_headText",
			"header": "KApx_W_header",
			"headerStatic": "KApx_W_headerStatic",
			"hint": "KApx_W_hint",
			"input": "KApx_W_input",
			"inputInvalid": "KApx_W_inputInvalid",
			"invalid": "KApx_W_invalid",
			"label": "KApx_W_label",
			"name": "KApx_W_name",
			"notExposed": "KApx_W_notExposed",
			"pending": "KApx_W_pending",
			"readOnly": "KApx_W_readOnly",
			"reset": "KApx_W_reset",
			"save": "KApx_W_save",
			"select": "KApx_W_select",
			"selectButton": "KApx_W_selectButton",
			"selectChevron": "KApx_W_selectChevron",
			"selectChevronOpen": "KApx_W_selectChevronOpen",
			"selectLabel": "KApx_W_selectLabel",
			"selectOption": "KApx_W_selectOption",
			"selectOptionActive": "KApx_W_selectOptionActive",
			"selectOptionSelected": "KApx_W_selectOptionSelected",
			"selectPopup": "KApx_W_selectPopup",
			"selectPopupClose": "KApx_W_selectPopupClose",
			"selectPopupOpen": "KApx_W_selectPopupOpen",
			"selectWrap": "KApx_W_selectWrap"
		};
		//#endregion
		//#region src/client/PluginSettingsCard.tsx
		/**
		* Family-shared chrome for plugin settings cards: a disclosure header naming
		* the plugin and what its settings govern, the controls inside, and the save
		* that writes them. Renders nothing while the namespace is unavailable — a
		* deployment that does not compose the owning plugin should show no trace of
		* it. Inlined into each consumer's client bundle; mirrors the official
		* ui-plugin-config PluginCard in a self-contained slice.
		*/
		/**
		* Render one plugin settings card.
		* @param props - the plugin's copy keys, its form state, and its controls.
		* @returns the card, or nothing while the namespace is still loading.
		*/
		function PluginSettingsCard(props) {
			const [open, setOpen] = (0, react.useState)(props.defaultOpen ?? true);
			const { state, alwaysOpen } = props;
			if (!state.available) return null;
			const title = props.t(props.titleKey);
			const description = props.t(props.descriptionKey);
			const blocked = !state.dirty || state.invalid || state.saving;
			const expanded = alwaysOpen === true || open;
			const cardClass = expanded ? `${settings_card_module_css_default.cardOpen} ${settings_card_module_css_default.card}` : settings_card_module_css_default.card;
			const header = alwaysOpen === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: settings_card_module_css_default.headerStatic,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: settings_card_module_css_default.headText,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: settings_card_module_css_default.name,
						title,
						children: title
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: settings_card_module_css_default.description,
						title: description,
						children: props.descriptionNode ?? description
					})]
				}), state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: settings_card_module_css_default.pending,
					title: props.t("settings.unsaved"),
					children: props.t("settings.unsaved")
				}) : null]
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: settings_card_module_css_default.header,
				"aria-expanded": open,
				"aria-label": `${props.t(open ? "settings.collapse" : "settings.expand")}: ${title}`,
				onClick: () => {
					setOpen(!open);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: settings_card_module_css_default.headText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: settings_card_module_css_default.name,
							title,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: settings_card_module_css_default.description,
							title: description,
							children: props.descriptionNode ?? description
						})]
					}),
					state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: settings_card_module_css_default.pending,
						title: props.t("settings.unsaved"),
						children: props.t("settings.unsaved")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
						width: "14",
						height: "14",
						viewBox: "0 0 14 14",
						fill: "none",
						xmlns: "http://www.w3.org/2000/svg",
						className: open ? `${settings_card_module_css_default.chevron} ${settings_card_module_css_default.chevronOpen}` : settings_card_module_css_default.chevron,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
							fill: "currentColor"
						})
					})
				]
			});
			if (!state.exposed) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: cardClass,
				children: [header, expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: settings_card_module_css_default.body,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: settings_card_module_css_default.notExposed,
						role: "status",
						children: props.t("settings.notExposed")
					})
				}) : null]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: cardClass,
				children: [header, expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: settings_card_module_css_default.body,
					children: [
						!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: settings_card_module_css_default.readOnly,
							role: "status",
							children: props.t("settings.readOnly")
						}) : null,
						props.children,
						props.hideFooter === true ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: settings_card_module_css_default.footer,
							children: [
								state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: settings_card_module_css_default.failed,
									role: "status",
									children: [props.t("settings.saveFailed"), state.failedReason ? " - " + state.failedReason : ""]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: settings_card_module_css_default.discard,
									disabled: !state.dirty || state.saving,
									onClick: props.onDiscard,
									children: props.t("settings.discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: settings_card_module_css_default.save,
									disabled: blocked,
									onClick: props.onSave,
									children: props.t(!state.saving ? "settings.save" : "settings.saving")
								})
							]
						})
					]
				}) : null]
			});
		}
		/** A staged value field. `numeric` only hints the keypad: which drafts a field accepts is decided by its spec. */
		function ValueField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: settings_card_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: settings_card_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: settings_card_module_css_default.label,
							htmlFor: props.id,
							children: props.label
						}), props.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: settings_card_module_css_default.badges,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: settings_card_module_css_default.badge,
								children: props.overriddenLabel
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: settings_card_module_css_default.reset,
								disabled: props.disabled,
								onClick: props.onReset,
								children: props.resetLabel
							})]
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: props.id,
						className: props.invalid ? settings_card_module_css_default.inputInvalid : settings_card_module_css_default.input,
						type: "text",
						...props.numeric === true ? { inputMode: "numeric" } : {},
						...props.invalid ? { "aria-invalid": true } : {},
						value: props.text,
						placeholder: props.placeholder ?? "",
						disabled: props.disabled,
						onChange: (event) => {
							props.onEdit(event.target.value);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: props.invalid ? settings_card_module_css_default.invalid : settings_card_module_css_default.hint,
						children: props.invalid ? props.invalidLabel : props.hint
					})
				]
			});
		}
		const NON_SKIN_BODY_MARKERS = /* @__PURE__ */ new Set(["dshSkinCenter", "dshSidebarCollapsed"]);
		function isSkinActive() {
			return Object.keys(document.body.dataset).some((key) => key.startsWith("dsh") && !NON_SKIN_BODY_MARKERS.has(key));
		}
		const SELECT_CLOSE_MS = 100;
		/**
		* The shared dual-mode select control. While an appearance skin is active it
		* renders the legacy native `<select>` untouched, so element-level skin
		* selectors keep working; under the default appearance it renders a
		* self-drawn `role="listbox"` popup whose open/close is transition-animated.
		* Staged cards reach it through BooleanField/ChoiceField; immediate-apply
		* editors (the side-card prefs) bind it directly through onEdit.
		* 双模式下拉框：皮肤激活时用原生 select，默认外观用自绘动画弹层。
		*/
		function SelectField(props) {
			const { id, options, value } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [closing, setClosing] = (0, react.useState)(false);
			const [phase, setPhase] = (0, react.useState)("initial");
			const [activeIndex, setActiveIndex] = (0, react.useState)(0);
			const closeTimer = (0, react.useRef)(void 0);
			const wrapRef = (0, react.useRef)(null);
			const popupRef = (0, react.useRef)(null);
			const currentIndex = () => {
				const index = options.findIndex((option) => option.value === value);
				return index >= 0 ? index : 0;
			};
			const close = (0, react.useCallback)(() => {
				if (closeTimer.current !== void 0) clearTimeout(closeTimer.current);
				setClosing(true);
				closeTimer.current = setTimeout(() => {
					setClosing(false);
					setOpen(false);
				}, SELECT_CLOSE_MS);
			}, []);
			const openPopup = () => {
				if (closeTimer.current !== void 0) clearTimeout(closeTimer.current);
				setActiveIndex(currentIndex());
				setPhase("initial");
				setClosing(false);
				setOpen(true);
			};
			const commit = (index) => {
				const option = options[index];
				if (option) props.onEdit(option.value);
				close();
			};
			const onTriggerClick = () => {
				if (props.disabled) return;
				if (open && !closing) close();
				else openPopup();
			};
			const onKeyDown = (event) => {
				if (props.disabled) return;
				const count = options.length;
				switch (event.key) {
					case "ArrowDown":
					case "ArrowUp":
					case "Enter":
					case " ":
						event.preventDefault();
						if (!open) openPopup();
						else if (!closing) if (event.key === "ArrowDown") setActiveIndex((index) => (index + 1) % count);
						else if (event.key === "ArrowUp") setActiveIndex((index) => (index - 1 + count) % count);
						else commit(activeIndex);
						break;
					case "Escape":
						if (open) {
							event.preventDefault();
							event.stopPropagation();
							close();
						}
						break;
					case "Tab":
						if (open) close();
						break;
				}
			};
			(0, react.useEffect)(() => () => {
				if (closeTimer.current !== void 0) clearTimeout(closeTimer.current);
			}, []);
			(0, react.useLayoutEffect)(() => {
				if (open && !closing && phase === "initial") {
					popupRef.current?.offsetHeight;
					setPhase("open");
				}
			}, [
				open,
				closing,
				phase
			]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const target = event.target;
					if (target instanceof Node && !wrapRef.current?.contains(target)) close();
				};
				document.addEventListener("pointerdown", onPointerDown);
				return () => document.removeEventListener("pointerdown", onPointerDown);
			}, [open, close]);
			(0, react.useEffect)(() => {
				if (props.disabled && open) close();
			}, [
				props.disabled,
				open,
				close
			]);
			if (isSkinActive()) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
				id,
				className: settings_card_module_css_default.select,
				value,
				disabled: props.disabled,
				onChange: (event) => {
					props.onEdit(event.target.value);
				},
				children: options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
					value: option.value,
					children: option.label
				}, option.value))
			});
			const label = options.find((option) => option.value === value)?.label ?? "";
			const popupClass = closing ? `${settings_card_module_css_default.selectPopup} ${settings_card_module_css_default.selectPopupClose}` : phase === "open" ? `${settings_card_module_css_default.selectPopup} ${settings_card_module_css_default.selectPopupOpen}` : settings_card_module_css_default.selectPopup;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: settings_card_module_css_default.selectWrap,
				ref: wrapRef,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					id,
					className: `${settings_card_module_css_default.select} ${settings_card_module_css_default.selectButton}`,
					disabled: props.disabled,
					"aria-haspopup": "listbox",
					"aria-expanded": open,
					"aria-activedescendant": open ? `${id}-o${activeIndex}` : void 0,
					"aria-invalid": props.invalid || void 0,
					onClick: onTriggerClick,
					onKeyDown,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: settings_card_module_css_default.selectLabel,
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
						width: "14",
						height: "14",
						viewBox: "0 0 14 14",
						fill: "none",
						xmlns: "http://www.w3.org/2000/svg",
						className: open ? `${settings_card_module_css_default.selectChevron} ${settings_card_module_css_default.selectChevronOpen}` : settings_card_module_css_default.selectChevron,
						"aria-hidden": "true",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
							fill: "currentColor"
						})
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: popupClass,
					role: "listbox",
					ref: popupRef,
					children: options.map((option, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						id: `${id}-o${index}`,
						role: "option",
						"aria-selected": option.value === value,
						className: `${settings_card_module_css_default.selectOption}${option.value === value ? ` ${settings_card_module_css_default.selectOptionSelected}` : ""}${index === activeIndex && !closing ? ` ${settings_card_module_css_default.selectOptionActive}` : ""}`,
						onClick: () => {
							commit(index);
						},
						children: option.label
					}, option.value))
				}) : null]
			});
		}
		/** A staged boolean field: 继承 / 开 / 关. */
		function BooleanField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: settings_card_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: settings_card_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: settings_card_module_css_default.label,
							htmlFor: props.id,
							children: props.label
						}), props.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: settings_card_module_css_default.badges,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: settings_card_module_css_default.badge,
								children: props.overriddenLabel
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: settings_card_module_css_default.reset,
								disabled: props.disabled,
								onClick: props.onReset,
								children: props.resetLabel
							})]
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectField, {
						id: props.id,
						options: [
							{
								value: "",
								label: props.inheritLabel
							},
							{
								value: "true",
								label: props.onLabel
							},
							{
								value: "false",
								label: props.offLabel
							}
						],
						value: props.text,
						disabled: props.disabled,
						invalid: props.invalid,
						onEdit: props.onEdit
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: settings_card_module_css_default.hint,
						children: props.hint
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-store-engine
		const platform = ["@deepseek-ai/dsh-client", "-store"].join("");
		const legacy = ["@deepseek-ai/dsh-client-runtime", "/client"].join("");
		let engine;
		try {
			engine = require(platform);
		} catch {
			engine = require(legacy);
		}
		const createSnapshotStore = engine.createSnapshotStore;
		engine.defineStore;
		engine.shallowEqual;
		//#endregion
		//#region src/client/settings-form.ts
		/** A whole- or decimal-number field. An empty draft clears the field; any other draft that is not a finite number within the constraints blocks the save. */
		function numberField(field, constraints = {}) {
			const { integer = false, min } = constraints;
			return {
				field,
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					if (!Number.isFinite(parsed)) return void 0;
					if (integer && !Number.isInteger(parsed)) return void 0;
					if (min !== void 0 && parsed < min) return void 0;
					return {
						kind: "set",
						value: parsed
					};
				}
			};
		}
		/** A boolean field, edited through true/false draft text. */
		function booleanField(field) {
			return {
				field,
				format: (value) => typeof value === "boolean" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					if (trimmed === "true") return {
						kind: "set",
						value: true
					};
					if (trimmed === "false") return {
						kind: "set",
						value: false
					};
				}
			};
		}
		/**
		* Stages one card's edits over one settings namespace and writes them on save.
		*
		* The Host is the only authority on whether a value was accepted — its
		* validators own the constraints no schema can express — so the outcome is
		* read back from the section rather than predicted here. A save that did not
		* land keeps its drafts, so the user can correct them instead of retyping.
		*/
		var CardForm = class {
			scope;
			specs;
			staged = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			/** The form subscription installed in the constructor; released by dispose(). */
			disposeForm;
			disposed = false;
			saving = false;
			failed = false;
			failedReason;
			/** @param scope - the bound configuration form for this card's namespace. */
			constructor(scope, specs) {
				this.scope = scope;
				this.specs = new Map(specs.map((spec) => [spec.field, spec]));
				this.disposeForm = scope.subscribe(() => {
					this.publish();
				});
			}
			/**
			* Release the form subscription and every bound store listener. The card
			* must call this on teardown; later calls are no-ops.
			*/
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.disposeForm();
				this.listeners.clear();
			}
			/** Publish a projection of this form, rebuilt whenever the form or a draft changes. */
			bind(project) {
				const store = createSnapshotStore(project());
				this.listeners.add(() => {
					store.set(project());
				});
				return store;
			}
			/** Read the card-level state: what the Host serves, and what a save would do. */
			shell() {
				const snapshot = this.scope.getSnapshot();
				const plan = this.plan();
				return {
					available: snapshot.status !== "loading",
					exposed: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: plan.length > 0,
					invalid: plan.some((item) => item.judge === void 0),
					saving: this.saving,
					failed: this.failed,
					...this.failedReason === void 0 ? {} : { failedReason: this.failedReason }
				};
			}
			/** Read one field's state from the effective section and its staged draft. */
			field(field) {
				const spec = this.specOf(field);
				const staged = this.staged.get(field);
				if (staged === void 0) return {
					text: spec.format(this.sectionValue(field)),
					overridden: this.stored(field),
					invalid: false
				};
				const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					overridden: write?.kind === "set",
					invalid: write === void 0
				};
			}
			/** The actions the card's slot registration injects. */
			actions() {
				return {
					edit: (field, text) => {
						this.stage(field, {
							text,
							clear: false
						});
					},
					resetField: (field) => {
						this.stage(field, {
							text: this.specOf(field).format(this.baseValue(field)),
							clear: true
						});
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.failed = false;
						this.failedReason = void 0;
						this.publish();
					}
				};
			}
			/**
			* Write every staged edit in one atomic form mutation, then re-seed from
			* what the Host accepted.
			*
			* The whole batch rides one mutate, so cross-field validate hooks
			* (baseURL+model) judge it as a unit: the Host either applies every write
			* or refuses the batch. The form contract answers a refusal or a skipped
			* write with `false` (it recovers with a fresh Host view instead of
			* throwing), so the outcome is judged twice: the answer itself, and then the
			* settled snapshot read back one planned write at a time. One missed write
			* fails the whole save. A transport that rejects instead (the dsh-web bridge
			* controller on a dead connection) reports through the same failure path
			* with its rejection message. A save that did not land keeps its drafts, so
			* the user can correct them instead of retyping.
			* @returns settlement after the mutation and the read-back.
			*/
			async save() {
				const plan = this.plan();
				const valid = plan.filter((item) => item.judge !== void 0);
				if (plan.length === 0 || this.saving || valid.length !== plan.length) return;
				const pending = /* @__PURE__ */ new Map();
				for (const item of plan) pending.set(item.field, this.staged.get(item.field));
				this.saving = true;
				this.failed = false;
				this.failedReason = void 0;
				this.publish();
				const ops = valid.map((item) => item.op.op === "set" ? {
					op: "set",
					path: [item.field],
					value: item.op.value
				} : {
					op: "unset",
					path: [item.field]
				});
				let failedReason;
				let accepted = false;
				try {
					accepted = await this.scope.mutate(ops);
				} catch (error) {
					failedReason = error instanceof Error ? error.message : String(error);
				}
				const landed = accepted && failedReason === void 0 && valid.every((item) => item.judge());
				for (const [field, before] of pending) if (landed && this.staged.get(field) === before) this.staged.delete(field);
				this.saving = false;
				this.failed = !landed;
				this.failedReason = failedReason;
				this.publish();
			}
			/**
			* Every staged edit a save would write. An entry whose draft is not a value
			* its field accepts carries no write: the form is still dirty, and the save
			* refuses rather than dropping the edit. A staged edit that matches the
			* effective section is not a write at all.
			* @returns the planned writes, in the order the fields were staged.
			*/
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					const spec = this.specOf(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({
							field,
							op: {
								field,
								op: "unset"
							},
							judge: () => this.landedUnset(field)
						});
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({
						field,
						op: {
							field,
							op: "unset"
						},
						judge: void 0
					});
					else if (write.kind === "clear") plan.push({
						field,
						op: {
							field,
							op: "unset"
						},
						judge: () => this.landedUnset(field)
					});
					else plan.push({
						field,
						op: {
							field,
							op: "set",
							value: write.value
						},
						judge: () => this.landedSet(field, write.value)
					});
				}
				return plan;
			}
			/**
			* Read-back judgment for a planned set: the user layer must hold the
			* intended value once the mutation has settled.
			*/
			landedSet(field, value) {
				if (this.specOf(field).secret) return true;
				return this.userLayer()?.[field] === value;
			}
			/**
			* Read-back judgment for a planned unset: the field must be gone from the
			* user layer once the mutation has settled.
			*/
			landedUnset(field) {
				return !this.stored(field);
			}
			stage(field, edit) {
				this.staged.set(field, edit);
				this.failed = false;
				this.failedReason = void 0;
				this.publish();
			}
			specOf(field) {
				const spec = this.specs.get(field);
				if (spec === void 0) throw new Error(`settings card has no field ${field}`);
				return spec;
			}
			snapshotOf() {
				return this.scope.getSnapshot();
			}
			sectionValue(field) {
				return this.snapshotOf().value?.[field];
			}
			baseValue(field) {
				return this.snapshotOf().base?.[field];
			}
			userLayer() {
				return this.snapshotOf().user;
			}
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			}
			publish() {
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/TaskBoardSettingsCard.tsx
		/**
		* A JSON field: the draft is the pretty-printed document, and a save is
		* refused unless it parses AND passes the same validation the Host applies.
		* That keeps "what the card accepted" and "what the Host enforces" one rule.
		*/
		function jsonField(field, validate) {
			return {
				field,
				format: (value) => value === void 0 ? "" : JSON.stringify(value, null, 2),
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					let parsed;
					try {
						parsed = JSON.parse(trimmed);
					} catch {
						return;
					}
					return validate(parsed).length === 0 ? {
						kind: "set",
						value: parsed
					} : void 0;
				}
			};
		}
		/** Bridges the `task-board` scope onto the card's staged form. */
		var TaskBoardSettingsCardController = class {
			form;
			store;
			/** @param scope - the bound settings scope for the `task-board` namespace. */
			constructor(scope) {
				this.form = new CardForm(scope, [
					booleanField("enabled"),
					booleanField("announceToAgent"),
					booleanField("preventIdleSleep"),
					numberField("maxConcurrentRuns", {
						integer: true,
						min: 1
					}),
					numberField("maxDoneTasks", {
						integer: true,
						min: 1
					}),
					jsonField("stateMachine", (value) => normalizeStateMachine(value).errors)
				]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					enabled: this.form.field("enabled"),
					announceToAgent: this.form.field("announceToAgent"),
					preventIdleSleep: this.form.field("preventIdleSleep"),
					maxConcurrentRuns: this.form.field("maxConcurrentRuns"),
					maxDoneTasks: this.form.field("maxDoneTasks"),
					stateMachine: this.form.field("stateMachine")
				};
			}
			/**
			* Build the face the card's slot registration injects.
			* @returns the card's snapshot and its form actions.
			*/
			inject() {
				return {
					hooks: { taskBoardSettingsCard: this.store },
					...this.form.actions()
				};
			}
			/**
			* Release the card's scope subscription and bound stores; the slot
			* disposer calls this on teardown.
			*/
			dispose() {
				this.form.dispose();
			}
		};
		/**
		* Render the task-board card.
		* @param props - locale copy, the card snapshot, and its form actions.
		* @returns the card.
		*/
		function TaskBoardSettingsCard(props) {
			const { t } = props;
			const state = props.useTaskBoardSettingsCard((snapshot) => snapshot);
			const disabled = !state.writable;
			const [power, setPower] = (0, react.useState)();
			(0, react.useEffect)(() => {
				let live = true;
				const events = new EventSource("/api/task-board/events");
				events.onmessage = (message) => {
					try {
						const frame = JSON.parse(message.data);
						if (frame.power !== void 0 && live) setPower(frame.power);
					} catch {}
				};
				return () => {
					live = false;
					events.close();
				};
			}, []);
			const fieldProps = {
				overriddenLabel: t("settings.overridden"),
				resetLabel: t("settings.reset"),
				invalidLabel: t("settings.invalidNumber"),
				disabled
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PluginSettingsCard, {
				t,
				titleKey: "settings.title",
				descriptionKey: "settings.description",
				defaultOpen: false,
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BooleanField, {
						id: "settings-task-board-enabled",
						label: t("settings.enabled"),
						hint: t("settings.enabledHint"),
						inheritLabel: t("settings.inherit"),
						onLabel: t("settings.on"),
						offLabel: t("settings.off"),
						...fieldProps,
						...state.enabled,
						onEdit: (text) => {
							props.edit("enabled", text);
						},
						onReset: () => {
							props.resetField("enabled");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BooleanField, {
						id: "settings-task-board-announce",
						label: t("settings.announceToAgent"),
						hint: t("settings.announceToAgentHint"),
						inheritLabel: t("settings.inherit"),
						onLabel: t("settings.on"),
						offLabel: t("settings.off"),
						...fieldProps,
						...state.announceToAgent,
						onEdit: (text) => {
							props.edit("announceToAgent", text);
						},
						onReset: () => {
							props.resetField("announceToAgent");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BooleanField, {
						id: "settings-task-board-prevent-idle-sleep",
						label: t("settings.preventIdleSleep"),
						hint: t("settings.preventIdleSleepHint"),
						inheritLabel: t("settings.inherit"),
						onLabel: t("settings.on"),
						offLabel: t("settings.off"),
						...fieldProps,
						...state.preventIdleSleep,
						onEdit: (text) => {
							props.edit("preventIdleSleep", text);
						},
						onReset: () => {
							props.resetField("preventIdleSleep");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "settings-task-board-max-concurrent-runs",
						label: t("settings.maxConcurrentRuns"),
						hint: t("settings.maxConcurrentRunsHint"),
						numeric: true,
						...fieldProps,
						...state.maxConcurrentRuns,
						onEdit: (text) => {
							props.edit("maxConcurrentRuns", text);
						},
						onReset: () => {
							props.resetField("maxConcurrentRuns");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "settings-task-board-max-done-tasks",
						label: t("settings.maxDoneTasks"),
						hint: t("settings.maxDoneTasksHint"),
						numeric: true,
						...fieldProps,
						...state.maxDoneTasks,
						onEdit: (text) => {
							props.edit("maxDoneTasks", text);
						},
						onReset: () => {
							props.resetField("maxDoneTasks");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "settings-task-board-state-machine",
						label: t("settings.stateMachine"),
						hint: t("settings.stateMachineHint"),
						...fieldProps,
						...state.stateMachine,
						onEdit: (text) => {
							props.edit("stateMachine", text);
						},
						onReset: () => {
							props.resetField("stateMachine");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("settings.powerStatus", {
						platform: power?.platform ?? t("settings.powerUnknown"),
						phase: power?.phase ?? t("settings.powerUnknown"),
						running: String(power?.runningSessions ?? 0),
						schedules: String(power?.armedSchedules ?? 0)
					}) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("settings.powerBoundary") }),
					power?.lastError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("settings.powerError", { error: power.lastError }) })
				]
			});
		}
		//#endregion
		//#region src/protocol.ts
		const TASK_BOARD_API_PREFIX = "/api/task-board";
		/** Whether a decoded reply carries the three draft strings the form accepts. */
		function isTaskParseDraft(value) {
			if (typeof value !== "object" || value === null) return false;
			const record = value;
			return typeof record.title === "string" && typeof record.description === "string" && typeof record.prompt === "string";
		}
		//#endregion
		//#region src/client/host-api.ts
		const IMPORT_MARKER = "dsh.taskBoard.v2.hostImported";
		const SOURCE_KEY = "dsh.taskBoard.v2.sourceId";
		const IMPORT_REQUEST_KEY = "dsh.taskBoard.v2.importRequestId";
		const REQUEST_TIMEOUT_MS = 15e3;
		/** Re-notify the panel at most this often while the event stream stays broken. */
		const STREAM_ERROR_NOTIFY_MS = 15e3;
		/** Mirrors the Host's own parse budget; only used to phrase the timeout. */
		const TASK_PARSE_TIMEOUT_SECONDS = 45;
		/** Transport failure carrying a stable class next to its user-facing message. */
		var HostApiError = class extends Error {
			failure;
			status;
			constructor(failure, message, status) {
				super(message);
				this.failure = failure;
				this.status = status;
				this.name = "HostApiError";
			}
		};
		function uuid() {
			return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		}
		/**
		* Read one Host response without ever handing a non-JSON body to JSON.parse:
		* the core webserver answers an unmounted `/api/*` path with the plain text
		* "not found", which used to surface as a JavaScript parse error in the panel.
		*/
		async function readJson(response) {
			const text = await response.text();
			let parsed;
			let readable = false;
			if (text.trim() !== "") try {
				parsed = JSON.parse(text);
				readable = true;
			} catch {
				readable = false;
			}
			const hostError = readable && typeof parsed === "object" && parsed !== null && typeof parsed.error === "string" ? parsed.error : void 0;
			if (response.ok) {
				if (!readable) throw new HostApiError("unexpected", t("board.hostError.unexpected", { status: String(response.status) }), response.status);
				return parsed;
			}
			if (hostError !== void 0) {
				if (hostError === "forbidden") throw new HostApiError("unauthorized", t("board.hostError.unauthorized"), response.status);
				if (response.status === 503 || /lock/i.test(hostError)) throw new HostApiError("locked", t("board.hostError.locked", { detail: hostError }), response.status);
				throw new HostApiError("rejected", hostError, response.status);
			}
			if (response.status === 404) throw new HostApiError("not-mounted", t("board.hostError.notMounted"), 404);
			if (response.status === 401 || response.status === 403) throw new HostApiError("unauthorized", t("board.hostError.unauthorized"), response.status);
			throw new HostApiError("unexpected", t("board.hostError.unexpected", { status: String(response.status) }), response.status);
		}
		var HttpTaskBoardHostTransport = class {
			storage;
			constructor(storage = globalThis.localStorage) {
				this.storage = storage;
			}
			async bootstrap(legacy) {
				const initial = await this.state();
				const ledgerId = initial.scheduler.ledgerId;
				if (legacy.length > 0 && ledgerId !== void 0 && this.storage?.getItem(IMPORT_MARKER) !== ledgerId) {
					let sourceId = this.storage?.getItem(SOURCE_KEY);
					if (sourceId === null || sourceId === void 0 || sourceId === "") {
						sourceId = uuid();
						this.storage?.setItem(SOURCE_KEY, sourceId);
					}
					let requestId = this.storage?.getItem(IMPORT_REQUEST_KEY);
					if (requestId === null || requestId === void 0 || requestId === "") {
						requestId = uuid();
						this.storage?.setItem(IMPORT_REQUEST_KEY, requestId);
					}
					const snapshot = await this.post(requestId, {
						kind: "import",
						sourceId,
						tasks: [...legacy]
					});
					this.storage?.setItem(IMPORT_MARKER, snapshot.scheduler.ledgerId ?? ledgerId);
					return snapshot;
				}
				return initial;
			}
			async state() {
				return await this.request(`${TASK_BOARD_API_PREFIX}/state`, { cache: "no-store" });
			}
			async action(action, initiator) {
				return await this.post(uuid(), action, initiator);
			}
			async post(requestId, action, initiator) {
				const envelope = {
					requestId,
					action,
					...initiator === void 0 || initiator === "" ? {} : { initiator }
				};
				return await this.request(`${TASK_BOARD_API_PREFIX}/action`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(envelope)
				});
			}
			async request(url, init) {
				const controller = new AbortController();
				const timeout = globalThis.setTimeout(() => {
					controller.abort();
				}, REQUEST_TIMEOUT_MS);
				try {
					return await readJson(await fetch(url, {
						...init,
						signal: controller.signal
					}));
				} catch (error) {
					if (error instanceof HostApiError) throw error;
					if (controller.signal.aborted) throw new HostApiError("timeout", t("board.hostError.timeout", { seconds: String(REQUEST_TIMEOUT_MS / 1e3) }));
					throw new HostApiError("unreachable", t("board.hostError.unreachable"));
				} finally {
					globalThis.clearTimeout(timeout);
				}
			}
			/**
			* Ask the Host to turn pasted text into task fields. The route answers a
			* typed failure (no model, timeout, unparseable reply) already phrased for
			* the form, so the UI never renders a raw status code (issue #1540).
			*/
			async parseDraft(request, signal) {
				let response;
				try {
					response = await fetch(`${TASK_BOARD_API_PREFIX}/parse`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request),
						...signal === void 0 ? {} : { signal }
					});
				} catch {
					throw new HostApiError("unreachable", t("board.hostError.unreachable"));
				}
				const text = await response.text();
				let parsed;
				let readable = false;
				if (text.trim() !== "") try {
					parsed = JSON.parse(text);
					readable = true;
				} catch {
					readable = false;
				}
				const record = readable && typeof parsed === "object" && parsed !== null ? parsed : void 0;
				if (response.ok) {
					if (record !== void 0 && isTaskParseDraft(record.draft)) return record.draft;
					throw new HostApiError("unexpected", t("new.aiParseFailed", { error: t("board.hostError.unexpected", { status: String(response.status) }) }), response.status);
				}
				if (response.status === 404) throw new HostApiError("not-mounted", t("new.aiParseUnavailable"), 404);
				if (response.status === 401 || response.status === 403) throw new HostApiError("unauthorized", t("board.hostError.unauthorized"), response.status);
				const code = typeof record?.code === "string" ? record.code : void 0;
				if (code === "no-model") throw new HostApiError("rejected", t("new.aiParseNoModel"), response.status);
				if (code === "timeout") throw new HostApiError("timeout", t("new.aiParseTimeout", { seconds: String(TASK_PARSE_TIMEOUT_SECONDS) }), response.status);
				throw new HostApiError("rejected", t("new.aiParseFailed", { error: typeof record?.error === "string" && record.error !== "" ? record.error : String(response.status) }), response.status);
			}
			subscribe(listener) {
				const events = new EventSource(`${TASK_BOARD_API_PREFIX}/events`);
				let lastStreamErrorNotify = 0;
				events.onmessage = (message) => {
					try {
						const parsed = JSON.parse(message.data);
						if (parsed === null || typeof parsed !== "object" || typeof parsed.revision !== "number") throw new Error("invalid event frame");
						listener(parsed);
					} catch {
						listener();
					}
				};
				events.onerror = () => {
					const now = Date.now();
					if (now - lastStreamErrorNotify < STREAM_ERROR_NOTIFY_MS) return;
					lastStreamErrorNotify = now;
					listener();
				};
				const onVisible = () => {
					if (document.visibilityState === "visible") listener();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					document.removeEventListener("visibilitychange", onVisible);
					events.close();
				};
			}
		};
		//#endregion
		//#region src/client/main-session.ts
		/**
		* Resolve the Session the main view currently shows.
		*
		* Reads the catalog's rows rather than a per-id retain-info source: ownership
		* counts ride the list snapshot, so this neither allocates observers nor opens
		* history, and a subscription to the list still fires when the selection moves.
		* @param byId - the session catalog's rows (`SessionListState.byId`), when available.
		* @returns the main-view session id, or undefined when the main view shows none.
		*/
		function mainViewSessionId(byId) {
			if (byId === void 0 || byId === null) return void 0;
			for (const row of Object.values(byId)) if (row !== void 0 && (row.retainedBy?.mainView ?? 0) > 0) return row.id;
		}
		//#endregion
		//#region src/client/plugin-card-seat.ts
		/**
		* Family plugin-card seat.
		*
		* A family plugin contributes its settings card to whichever plugin-card seat
		* the running host actually renders:
		*
		* - `web-ui.plugin.item` — the list seat declared by the dsh-web-settings
		*   group section (this family's own first-level "Web UI plugins" section);
		* - `settings.plugin.item` — the official keyed seat of the harness's
		*   `ui-settings-plugins` tab, keyed by the settings namespace the card edits.
		*
		* SEAT SELECTION IS NOT A DECLARATION PROBE. The official `ui-settings-plugins`
		* row belongs to the harness bundle and its `configurable` tab always declares
		* `settings.plugin.item` before any external plugin's `apply()` runs, so
		* "is the official seat declared?" answers yes even in the deployment whose
		* whole point is the family group. Choosing on that probe sends every family
		* card to the official Plugins tab and leaves the group's own section
		* permanently empty — the family of reports where the section renders its
		* heading and zero cards.
		*
		* The signal that actually distinguishes the two deployments is whether
		* dsh-web-settings is loaded: it is the package that owns the group section and
		* it publishes the `webUiSettings` service during `apply()`, which every
		* family plugin already reads for its settings scope. Group loaded -> the family
		* seat; group absent -> the official seat.
		*
		* The decision is re-evaluated on every `slots/changed` because the group may
		* apply after this plugin (the family aggregate orders it first, a profile that
		* installs the group separately need not): the initial contribution goes to the
		* official seat, then moves to the family seat the moment the group's section
		* registers. The entry is disposed before the replacement is registered, so a
		* card is never in two seats at once.
		*
		* The shared tree has no client-SDK dependency, so this module reads its
		* context through the structural shape below; callers pass the plugin's own
		* `ctx`.
		*/
		/** The family list seat key. */
		const FAMILY_PLUGIN_CARD_SEAT = "web-ui.plugin.item";
		/** The official keyed plugin-card seat key. */
		const OFFICIAL_PLUGIN_CARD_SEAT = "settings.plugin.item";
		/** The service dsh-web-settings publishes while it is loaded. */
		const FAMILY_GROUP_SERVICE = "webUiSettings";
		/**
		* Whether the family group (dsh-web-settings) is loaded in this page. The
		* service is the group package's own contract, so the probe cannot be fooled
		* by a harness release that starts declaring the official seat differently.
		*/
		function familyGroupLoaded(ctx) {
			const get = ctx.get;
			if (typeof get !== "function") return false;
			try {
				return get.call(ctx, FAMILY_GROUP_SERVICE) !== void 0;
			} catch {
				return false;
			}
		}
		/** Report a refused registration instead of leaving the user with no card. */
		function warnRefusedSeat(seat, error) {
			try {
				console.warn(`[dsh-web] plugin card registration into "${seat}" was refused; the card will not render`, error);
			} catch {}
		}
		/**
		* Contribute one family plugin card to the seat this host renders, following
		* the group if it loads later. The entry is disposed and re-registered on a
		* seat change, never duplicated.
		* @param ctx - client context (its slot registry decides the seat).
		* @param seat - the card contribution.
		*/
		function installPluginCard(ctx, seat) {
			const slots = ctx.slots;
			const component = seat.component;
			const inject = seat.inject;
			let dispose;
			let current;
			/**
			* Re-entrancy latch. The registry emits a change event synchronously from
			* inside both `register` and the previous entry's disposer, so an unguarded
			* reconcile would re-enter itself mid-move and register the card twice into
			* the seat it is leaving ("already has an entry for key ...").
			*/
			let reconciling = false;
			/** Reconcile the contribution with the currently live seat (no-op when unchanged). */
			const reconcile = () => {
				if (reconciling) return;
				const target = familyGroupLoaded(ctx) ? FAMILY_PLUGIN_CARD_SEAT : OFFICIAL_PLUGIN_CARD_SEAT;
				if (current === target) return;
				reconciling = true;
				const previous = dispose;
				dispose = void 0;
				current = void 0;
				previous?.();
				try {
					dispose = slots.register(target === "web-ui.plugin.item" ? {
						name: FAMILY_PLUGIN_CARD_SEAT,
						id: seat.id,
						...seat.order === void 0 ? {} : { order: seat.order },
						...seat.label === void 0 ? {} : { label: seat.label },
						locale: seat.locale,
						...seat.inject === void 0 ? {} : { inject }
					} : {
						name: OFFICIAL_PLUGIN_CARD_SEAT,
						key: seat.namespace,
						locale: seat.locale,
						...seat.inject === void 0 ? {} : { inject }
					}, component);
					current = target;
				} catch (error) {
					warnRefusedSeat(target, error);
				} finally {
					reconciling = false;
				}
			};
			if (typeof ctx.on === "function") try {
				ctx.on("slots/changed", () => {
					reconcile();
				});
			} catch {}
			reconcile();
		}
		//#endregion
		//#region src/client/index.ts
		/** Locale namespace this plugin owns. */
		const NS = "task-board";
		/** Settings namespace the settings card edits (the Host plugin registers it). */
		const TASK_BOARD_NS = "task-board";
		/**
		* Profile entry ids this package's patch row can carry: the standalone bundle
		* patch row (`ui-task-board`), plus the bare namespace as the last resort for
		* a Host whose descriptor is keyed by the family namespace itself.
		*/
		const TASK_BOARD_ENTRY_IDS = ["ui-task-board", TASK_BOARD_NS];
		/**
		* Required services (fiber inject waiting — the runtime must be up first).
		* The generated remote faces are probed at use time instead of injected:
		* `remote.agentPresets` only registers on 0.1.2-alpha.2 hosts (the
		* api-remotes contribution), so a hard wait would pend the entry forever
		* on hosts below that cohort, which serve the same roster through the
		* connection RPC face.
		*/
		const inject = [
			"slots",
			"sessions",
			"workspaces",
			"connection",
			"configForms",
			"locale",
			"remote",
			"remote.session",
			"uiWorkspace"
		];
		/**
		* Mount the task board.
		* @param ctx - client root context (services: sessions, workspaces).
		*/
		function apply(ctx) {
			if (!claimTaskboardApply()) return;
			ctx.effect(() => releaseTaskboardApply, "task-board: apply claim");
			ctx.effect(() => {
				try {
					return ctx.locale.register(NS, {
						zh,
						en
					});
				} catch {
					return () => {};
				}
			}, "task-board: dictionaries");
			try {
				setRuntimeTranslate(ctx.locale.bind(NS));
			} catch {}
			const settingsForm = bindSettingsForm(ctx);
			const settingsCard = new TaskBoardSettingsCardController(settingsForm);
			installPluginCard(ctx, {
				namespace: TASK_BOARD_NS,
				id: "task-board",
				order: 110,
				locale: NS,
				inject: () => settingsCard.inject(),
				component: TaskBoardSettingsCard
			});
			ctx.effect(() => () => {
				settingsCard.dispose();
			}, "task-board: settings card");
			let uiDisposer;
			const mountUi = () => {
				if (uiDisposer !== void 0) return;
				const sessions = ctx.get("sessions");
				const workspaces = ctx.get("workspaces");
				const remote = ctx.get("remote");
				const controller = new BoardController({
					store: new LocalStorageTaskStore(),
					transport: new HttpTaskBoardHostTransport(),
					sessions: {
						list: {
							getSnapshot: () => ({ current: mainViewSessionId(sessions.list.getSnapshot().byId) }),
							subscribe: (fn) => sessions.list.subscribe(fn)
						},
						open: (id) => ctx.uiWorkspace.openSession(id),
						refresh: () => sessions.refresh()
					}
				});
				controller.start();
				const disposers = [];
				const openSessionFromHash = () => {
					const sessionId = sessionLinkTarget(window.location.hash);
					if (sessionId !== void 0) controller.openSession(sessionId);
				};
				window.addEventListener("hashchange", openSessionFromHash);
				disposers.push(() => window.removeEventListener("hashchange", openSessionFromHash));
				openSessionFromHash();
				const pushWorkspaceOptions = () => {
					const snapshot = workspaces.list.getSnapshot();
					controller.setExecutionOptions({ workspaces: snapshot.items.map((item) => ({
						workspaceId: item.workspaceId,
						title: item.title !== "" ? item.title : item.path
					})) });
				};
				pushWorkspaceOptions();
				disposers.push(workspaces.list.subscribe(pushWorkspaceOptions));
				controller.setWorkspaceCreator(async (path) => {
					return { workspaceId: (await workspaces.create({ path })).workspaceId };
				});
				const pushModelOptions = async () => {
					try {
						let models = [];
						let sessionRemote;
						try {
							sessionRemote = remote.session;
						} catch {
							sessionRemote = void 0;
						}
						if (typeof sessionRemote?.modelCatalog === "function") {
							const res = await sessionRemote.modelCatalog();
							if (res.ok && Array.isArray(res.value?.groups)) for (const g of res.value.groups) {
								const provider = g.id ?? g.provider;
								for (const m of g.models ?? []) {
									const qualifiedId = provider ? `${provider}/${m.id}` : m.id;
									models.push({
										id: qualifiedId,
										name: m.name ?? m.id,
										provider
									});
								}
							}
						}
						if (models.length === 0) {
							const conn = ctx.get("connection");
							if (conn?.api) {
								if (typeof conn.api.llm?.discoverModels === "function") {
									const list = (await conn.api.llm.discoverModels())?.result?.value?.models;
									if (Array.isArray(list)) models = list.map((m) => ({
										id: m.id,
										name: m.name
									}));
								}
								const catalogFn = typeof conn.api.session?.modelCatalog === "function" ? conn.api.session.modelCatalog : typeof conn.api.sessions?.modelCatalog === "function" ? conn.api.sessions.modelCatalog : void 0;
								if (models.length === 0 && catalogFn !== void 0) {
									const groups = (await catalogFn())?.result?.value?.groups;
									if (Array.isArray(groups)) for (const g of groups) {
										const provider = g.id ?? g.provider;
										for (const m of g.models ?? []) {
											const qualifiedId = provider ? `${provider}/${m.id}` : m.id;
											models.push({
												id: qualifiedId,
												name: m.name ?? m.id,
												provider
											});
										}
									}
								}
							}
						}
						if (models.length > 0) controller.setExecutionOptions({ models });
					} catch (error) {
						console.error("[dsh-task-board] model options read failed", error);
					}
				};
				pushModelOptions();
				disposers.push(ctx.on("connection/reset", () => {
					pushModelOptions();
				}));
				try {
					disposers.push(mountSidebarEntry(controller, ctx.locale));
					disposers.push(mountBoard(controller, ctx.locale));
				} catch (error) {
					console.error("[dsh-task-board] mount failed:", error);
				}
				uiDisposer = () => {
					for (const dispose of disposers.splice(0)) dispose();
					controller.dispose();
					uiDisposer = void 0;
				};
			};
			const syncEnabled = () => {
				const snapshot = settingsForm.getSnapshot();
				if (snapshot.status === "ready" ? snapshot.value?.enabled ?? true : snapshot.status === "unavailable") mountUi();
				else uiDisposer?.();
			};
			settingsForm.subscribe(syncEnabled);
			syncEnabled();
		}
		/**
		* Bind the settings form this card stages over.
		*
		* The family binder (`ctx.get('webUiSettings')`, published by dsh-web-settings)
		* comes first: it is what traces this package's family namespace onto the
		* profile entry id the Host serves the form under. A page without that group
		* falls back to the shared configuration forms service bound directly at one of
		* this package's own profile entry ids.
		* @param ctx - client root context.
		* @returns the form the settings card reads and writes.
		*/
		function bindSettingsForm(ctx) {
			const forms = ctx.get("configForms");
			if (forms !== void 0 && typeof forms.get === "function") return forms.get(servedEntryId(forms));
			const binder = ctx.get("webUiSettings");
			if (binder !== void 0 && typeof binder.bind === "function") return binder.bind({ namespace: TASK_BOARD_NS });
			throw new Error(`task-board: this page serves neither the shared configuration forms nor a settings binder for "${TASK_BOARD_NS}"`);
		}
		/**
		* The profile entry id this package's own row carries.
		*
		* The shared describe mirror is the only local evidence of which row id this
		* profile actually serves, but it answers asynchronously: at plugin activation
		* it usually holds nothing yet. An unanswered mirror therefore binds the row id
		* this bundle's own patch declares rather than the family namespace — the form
		* is bound once for the session, and the entry id is what the Host addresses a
		* form by under 0.1.7.
		* @param forms - the shared configuration forms service.
		* @returns the entry id to bind.
		*/
		function servedEntryId(forms) {
			let served;
			try {
				served = forms.describe().getSnapshot().view?.namespaces.map((view) => view.ns);
			} catch {
				served = void 0;
			}
			if (served === void 0) return TASK_BOARD_ENTRY_IDS[0] ?? TASK_BOARD_NS;
			return TASK_BOARD_ENTRY_IDS.find((id) => served.includes(id)) ?? TASK_BOARD_ENTRY_IDS[0] ?? TASK_BOARD_NS;
		}
		//#endregion
		exports.apply = apply;
		exports.bindSettingsForm = bindSettingsForm;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map