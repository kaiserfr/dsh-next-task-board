# dsh-task-board — DSH web GUI task board plugin

English | [中文](README.zh.md)

> **Fork — `kaiserfr/dsh-next-task-board`.** Independent fork of
> [`zhu1090093659/dsh-web`'s `packages/dsh-task-board`](https://github.com/zhu1090093659/dsh-web/tree/dev/packages/dsh-task-board)
> (base **0.3.23**, Apache-2.0). It adds a **Host-enforced WIP limit**,
> **drag-to-start**, and an **agentic-programming workflow** (Ready-for-test
> column, Backlog-by-default, automatic git feature branch and merge), and
> drops upstream's telemetry heartbeat — see
> [What this fork adds over the upstream task board](#what-this-fork-adds-over-the-upstream-task-board)
> and [FORK-NOTES.md](FORK-NOTES.md) (German).


A hot-pluggable DeepSeek Harness (DSH) Web GUI plugin with a Host-authoritative task ledger, real DSH session execution, Host cron scheduling, and optional cross-platform idle-sleep protection. It is mounted through `cordis.patch.yml` and the profile mechanism and does not modify DSH source code.

- The browser is an asynchronous view; closing the page does not stop Host scheduling or execution settlement.
- Every run applies the pinned workspace, agent preset, and permission before sending the task prompt; by default each run creates its own DSH session, and a task can opt into continuing in its previous session instead (issue #1419).
- The display may turn off while optional power protection keeps the computer from entering idle system sleep.

## What this fork adds over the upstream task board

This package is a **drop-in replacement** for upstream
`@linxin666/dsh-client-ui-task-board` 0.3.23: it reads and writes the same ledger
(`$DSH_HOME/task-board/ledger-v2.json`, schema v3), so existing tasks survive, and
the two packages must not be installed side by side (both mount the same Host
route and system-prompt section).

| Area | Upstream 0.3.23 | This fork |
| --- | --- | --- |
| **Execution concurrency** | Every run starts as soon as it is due; nothing bounds how many runs hold a session at once. | **Host-enforced WIP limit** `maxConcurrentRuns` (default **1**): runs above the limit wait in a FIFO queue and start in arrival order as soon as a running execution settles. |
| **Starting from the board** | Dragging a card only moves it between `backlog` and `todo`. | **Dragging a card onto "In progress" starts the task** through the same Host action as the detail view's Run button. |
| **Board workflow** | Five columns; new tasks start in `todo`. | **Agentic-programming defaults**: six columns with **Ready for test** directly before Done; new tasks start in **Backlog**; a successful run parks the card in Ready for test, and Done is reached only by a manual move. |
| **Git integration** | None. | When the card's pinned workspace is a local git worktree, the board **opens `task/<slug>-<id8>` when the card enters Todo, checks it out for the run, and commits + merges it back into the base branch when the card reaches Done** (no-op without a repository). |
| **Telemetry** | The client sends one anonymous install heartbeat per UTC day to `dsh-market.com`. | **Removed.** No heartbeat is sent at mount; `src/client/telemetry.ts` stays on disk for a possible own endpoint but is not imported. |
| **Distribution** | Part of the `dsh-web` monorepo, installed from npm or the `web-ui-all` aggregate. | **Standalone repo**: `lib/` is committed, so `dsh plugin --profile web add github:kaiserfr/dsh-next-task-board` installs without a build step and without an `allowBuilds` approval. |
| **Agent announcement** | Names `dsh-task-board` and the upstream aggregate package. | Names this fork and spells out the WIP queue semantics to the agent. |

### Host-enforced WIP limit

- Enforced in `TaskBoardHostService`, not merely in the browser.
- A slot is freed when a running execution **settles**, not when its session is
  attached; otherwise the board would only be throttled at start instead of truly
  serial.
- A waiting run is already `running` in the ledger without a session, so its card
  reads as in progress and cannot be started a second time.
- Lowering the limit never aborts a running task: surplus slots drain as their
  executions settle while the queue holds the remaining launches back.
- The queue self-heals — an entry whose execution is no longer open (deleted,
  archived, or settled while it waited) is dropped on the next pump.
- Manual runs and cron runs share the launch queue, so both are limited.

### Drag a card onto "In progress" to start it

- The `running` column is a drop target and sends the same Host `rerun` action as
  the detail view's Run button, so the task really goes through the Host queue
  instead of being relabelled locally.
- Waiting, running, archived, and unknown cards are ignored; `backlog`/`todo`
  remain pure manual status moves.

### Agentic-programming workflow and git integration

- Columns: `backlog → todo → running → ready_for_test → done → failed`.
- New tasks are created in **Backlog**; pulling a card into **Todo** is the
  manual start signal.
- A successful execution parks the card in **Ready for test** (a failed one in
  Failed); the runner never produces `done`, so accepting the work is always a
  human move.
- When the card's pinned workspace is a git worktree, the Host keeps the work on
  a feature branch and runs the whole flow in the background:
  - Backlog → Todo opens `task/<title-slug>-<id8>`, cut from the current branch
    (or `main`/`master` when HEAD is already on a board branch, so a second card
    does not nest on the first).
  - Before every run the branch is checked out, so "In progress" works on it; a
    run that skipped the Todo pull (cron, dragged straight to In progress, or
    the Run button) opens the branch at start.
  - Ready for test → Done commits whatever the run left in the worktree and
    merges the branch back with `--no-ff`. A git failure (e.g. a merge conflict)
    fails the move and keeps the card in Ready for test.
- Limits: git needs a pinned workspace (without one the board cannot know which
  repository is meant); the flow shares one worktree, which matches the default
  WIP limit of 1 — parallel runs (`maxConcurrentRuns > 1`) would race on the
  checkout.

## Features

- **Task board UI**: a sidebar entry below New Session shows icon and text in the wide sidebar and an icon in the collapsed rail; the board provides six kanban columns, search, task details, archive/restore, execution history, and links to execution transcripts. New tasks land in Backlog and cards drag between Backlog, Todo, Ready for test, and Done for a manual status change; dragging a card onto the running column starts it through the same Host action as the detail view's Run button **(fork addition)**. Archived tasks are read-only except for restore, delete, and transcript viewing, and cannot run manually or on schedule until restored.
- **Host-enforced WIP limit (fork addition)**: at most `maxConcurrentRuns` task runs (default `1`) hold a session at once; further manual and cron runs wait in a FIFO queue and start as a running execution settles. See [What this fork adds](#what-this-fork-adds-over-the-upstream-task-board).
- **Continuation cards (data plane)**: a new task may paste a `<<<FREEZE ... >>>FREEZE` block from a session; it parses into a goal/progress/next snapshot persisted with the task (ledger v3). Cards carry a frozen badge, the detail view shows the full snapshot and freeze time, search covers snapshot text, and archive/restore matches plain tasks. The snapshot reuses the freeze security gate at the protocol layer: sensitive patterns become `[REDACTED]` with a marker, slash-prefixed command lines reject the whole snapshot, and each field is capped at 8 KiB.
- **Handover bundles and the permission confirmation gate**: a continuation card may attach a handover bundle — the pinned execution triplet (workspace / agent preset / permission) plus doc/script references. The bundle's triplet overrides the plain pin fields at execution, and the references ride the prompt as a handover preamble. A binding whose effective permission is above `sessionDefaultPermission` (default `read-only`) is unconfirmed: manual run refuses, cron skips the card and rolls to the next occurrence, and the confirm button in the task detail resolves the binding; any later permission or bundle change re-arms the gate.
- **Claim provenance wrap and source audit**: executing a continuation card (a card with a frozen snapshot) mandatorily wraps the task instruction in a source-declaration template — freeze instant, source session, and an unreviewed-content warning — composed after the handover preamble so the picking-up agent stays wary of stored prompt injection in card text. The session issuing a create/update action is stamped into the snapshot (frozenBy, re-stamped when the snapshot is replaced), and the session issuing a run/rerun lands on the execution record (initiatedBy) together with a captured copy of the freeze provenance; both are visible in the task detail. The initiator is client-asserted audit metadata, not a trust boundary.
- **Task tags (issue #1521)**: a task may carry up to eight labels. A label renders as a colour-toned badge on the card — the tone is hashed from the name, so one label always paints the same way and no colour is stored — the board header gains a multi-select tag filter built from every label in use (including archived tasks), and search also matches label names. A label with an "execution hint" is injected ahead of the execution prompt on every run as a `标签提示` block; a label without one is display and filter only, so an untagged task's prompt is byte-for-byte what it was before the feature. Labels stay editable after the first run: they classify the task and shape the next run, they are not the record of what already ran.
- **Project partition (issue #1536)**: the board header offers a project row built from the deployment's DSH workspaces — "all projects" plus one entry per registered project. Selecting a project narrows the columns to the tasks pinned to it, and tasks with no pinned workspace stay visible under "all projects". Opening the new-task form while a project is open preselects that project as the task's workspace, and "new project…" registers a host directory through the same runtime call the GUI's own add-project uses.
- **AI parse of pasted text (issue #1540)**: the new-task form takes text copied from anywhere and has a model turn it into the title, description, and run prompt. The model is one of the deployment's configured models (the same list the task's model pin uses, first entry preselected), and the call runs on the Host behind the board's usual loopback and same-origin fence, with a 45 s budget and a cancel affordance. The draft only fills the form: nothing is created until the task is submitted, and a failed parse leaves what you already typed untouched.
- **Host-authoritative ledger**: tasks, schedules, and execution records live in `$DSH_HOME/task-board/ledger-v2.json`; browser actions become confirmed Host transactions.
- **Bounded execution history**: each task keeps the most recent 20 execution records; the oldest runs are trimmed when a new run starts, so ledger size and write cost stay bounded regardless of how often a task has run.
- **Real execution**: manual and scheduled runs use the same Host runner, which by default creates a fresh session, renames it, applies the agent preset and `/permission <id>`, then queues the task prompt.
- **Optional session reuse**: a task can opt into continuing in its previous execution's session (issue #1419). Reuse happens only when that session is idle and still present in the runtime roster — the Host then re-applies the pinned permission and model on it and queues the prompt, keeping the conversation title and history; otherwise the run mints a fresh session as before, so an unknown roster or a busy session never blocks a scheduled run.
- **Fail-closed pins**: a missing workspace, missing or broken preset, or rejected permission command fails before the task prompt is sent.
- **Host scheduler**: 5-field cron supports `*`, `*/n`, ranges, comma lists, Sunday `0/7`, and standard day-of-month/day-of-week OR semantics in the Host local time zone.
- **Deterministic recovery**: a running execution with a recorded session is observed after restart; an interrupted start without a session id is cancelled and is not resent.
- **Live synchronization**: mutations return a full revisioned snapshot; SSE announces revision, scheduler, and power changes, while reconnect and page visibility recovery fetch a full snapshot.
- **Optional idle-sleep protection**: off by default; when enabled it covers every running DSH session, enabled non-archived task-board schedules, and unknown session state.
- **System-prompt injection**: the Host registers a `plugin:task-board` section (order 200) through `SystemPrompt.section`, and the task-board settings can disable the announcement without disabling the board. The guidance also reminds agents to close any visible `todo_write` plan before the final answer.

## Architecture and protocol

The board view renders on first open and keeps its local view state when closed and reopened. Host synchronization, scheduling and execution remain active independently of the view.

- `src/index.ts` mounts the Host service through the official `@deepseek-ai/dsh-api-gateway`, `@deepseek-ai/dsh-workspace`, and `@deepseek-ai/dsh-host-webserver` SDKs.
- `src/host-ledger.ts` serializes actions and persists `{ schemaVersion: 3, revision, tasks, scheduler, recentRequests }` through a temporary file plus atomic rename.
- `src/host-service.ts` owns cron ticks, missed-trigger skipping, runner launch, restart reconciliation, and power reasons.
- `src/client/host-api.ts` imports legacy browser data once, submits idempotent actions, and treats Host snapshots as the only confirmed UI state.
- Same-origin endpoints are `GET /api/task-board/state`, `GET /api/task-board/events`, and `POST /api/task-board/action`.
- Every endpoint requires a browser same-origin marker. Direct access is restricted to the DSH loopback origin; an authenticated same-host reverse proxy must use an explicit Host allowlist and a server-injected token. POST requests additionally require JSON. Ordinary actions are limited to 64 KiB and import to 2 MiB. The action union has no command, executable path, shell text, or arbitrary argument field.

## Install

Install this package alone, then restart `dsh web`:

```sh
dsh plugin --profile web add github:kaiserfr/dsh-next-task-board
```

`lib/` is committed, so this needs no build step and no `allowBuilds` approval.
For local development:

```sh
git clone https://github.com/kaiserfr/dsh-next-task-board.git
cd dsh-next-task-board
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)
```

## Configuration

| Key | Default | Behavior |
| --- | --- | --- |
| `enabled` | `true` | Enables the Host service and browser board. |
| `announceToAgent` | `false` | Opt-in: when true, adds the task-board guidance section to agent system prompts. |
| `preventIdleSleep` | `false` | Holds one system idle-sleep assertion while any DSH session runs, any schedule is enabled, or session state is unknown. |
| `maxConcurrentRuns` | `1` | **Fork addition.** WIP limit: how many task runs may hold a session at once. Runs above the limit wait in a FIFO queue and start as soon as a running task settles. Queued cards already read as running (no session yet) and are recorded as `cancelled` when the Host restarts before they start. |
| `trustedProxyHosts` | `[]` | Canonical `host[:port]` authorities accepted only through the authenticated loopback reverse-proxy path. |
| `proxyTokenEnv` | `DSH_TASK_BOARD_PROXY_TOKEN` | Environment variable containing the reverse-proxy token; the token itself is never stored in plugin config. |
| `sessionDefaultPermission` | `read-only` | The deployment's session-default permission. A card whose effective permission (handover bundle or pin) is above this value requires a human confirmation before it may run; cron refuses unconfirmed cards. |

Direct browser access remains limited to the DSH loopback origin. For a same-host authenticated reverse proxy, bind DSH Web to loopback, set `trustedProxyHosts`, place a high-entropy token in the environment variable selected by `proxyTokenEnv`, and configure the proxy to replace (not forward from the client) `X-Dsh-Task-Board-Proxy-Token` after it authenticates the request. The proxy Host must be allowlisted, and the browser `Origin` must have that same authority. Restart the Host after changing these composition-level proxy settings.

On macOS the backend starts `/usr/bin/caffeinate -i -w <host-pid>` and never requests `-d`. On Windows it starts the absolute Windows PowerShell under `SystemRoot` with a fixed helper that requests only `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`; it never requests `ES_DISPLAY_REQUIRED`, changes a power plan, or requires administrator privileges. On Linux it starts a systemd-logind `idle` block inhibitor only from `/usr/bin/systemd-inhibit` or `/bin/systemd-inhibit`; it does not request `sleep`, `handle-lid-switch`, or a display/screensaver inhibitor. A Linux host without systemd-logind reports `unsupported` or a visible error and does not start a desktop-specific fallback. Other platforms report `unsupported`.

## Data storage and migration

- The authoritative ledger file is `$DSH_HOME/task-board/ledger-v2.json` (the file name is historical); the current document schema is v3, and a v2 document is migrated losslessly to v3 in place on the next Host start. New POSIX files use mode `0600`; Windows inherits the user directory ACL.
- A v2 to v3 migration failure (structurally invalid task rows) fails closed with an explicit error and keeps the original file untouched; it never restarts from an empty ledger silently. A corrupt or unsupported-schema file is moved to a collision-resistant `ledger-v2.json.corrupt-*` name and the Host starts with an empty ledger plus a visible scheduler error. The corrupt bytes are not overwritten.
- On the first upgraded page load for an origin, `dsh.taskBoard.v1` is imported by stable source and request ids. Tasks merge by id, strictly newer browser top-level fields win, equal timestamps keep Host fields, and execution records merge by execution id.
- The most recent 256 request ids and SHA-256 action fingerprints are stored with the ledger, so a retried mutation remains idempotent after a Host restart without duplicating full action payloads.
- Task labels are an optional `tags` field on the task row (`{ name, promptPrefix? }[]`) and needed no schema bump: a v3 document without it loads unchanged, and a malformed list is repaired entry by entry (blanks, repeats, and over-long names dropped, count capped) rather than dropping the task row.
- The import marker `dsh.taskBoard.v2.hostImported` stores the confirmed Host ledger generation only after import succeeds. A new or recovered ledger generation is offered the retained v1 data again. The v1 localStorage value remains untouched as a read-only rollback copy.
- One Host process owns a task-board ledger directory at a time through `$DSH_HOME/task-board/ledger-v2.lock`; a second Host using the same DSH home fails closed instead of concurrently writing the ledger.

## Security model

- The plugin stays inside the existing DSH Web deployment and network boundary and emits no permissive CORS headers. State, action, and SSE routes share the same access fence; bare local command-line requests are not accepted as browser requests.
- All mutation payloads use a strict, versioned discriminated union; schedule-owned timestamps and execution outcomes cannot be written by the browser.
- Workspace, preset, permission, cron, task status, and imported records are validated again on the Host.
- A card's effective permission above the configured session default enters a pending-confirmation state: the Host refuses manual runs and cron triggers until a human confirms the exact binding, and changing the pinned permission or the handover bundle clears the confirmation (no confirm-then-swap escalation).
- A task prompt is data sent to a DSH agent session. The protocol does not accept shell commands, PowerShell bodies, executable paths, or configurable helper arguments.
- Task labels are client-asserted like the prompt itself and ride the same gated action channel: the protocol gate rejects a blank name, an unknown key, more than eight labels, and an over-long name or hint. A label's injected hint is delimiter-escaped (it cannot forge the continuation-card provenance markers) and is placed outside that provenance wrap.
- Power helpers use fixed executable paths, fixed arguments, `shell: false`, and bounded retry delays of 1, 2, 5, 10, then 30 seconds. The Linux helper follows the Host stdin lifetime so the systemd inhibitor is released automatically after an abnormal Host exit.

## Build and test

Node 20 or newer and the official NPM SDK packages are required; no DSH source checkout is used.

```sh
pnpm typecheck
pnpm test
pnpm build
```

Set `DSH_POWER_SMOKE=1` to opt into the native helper smoke test on Windows, macOS, or Linux. It starts the fixed helper, waits for readiness, releases it in cleanup, and confirms process exit without changing the system power plan. Linux first probes systemd-logind with a bounded timeout; without a usable system bus the native portion is skipped while pure logic tests remain available.

## Manual verification

1. Mount the package, restart `dsh web`, open the task board, and confirm the Host time zone and power status are visible.
2. Create and edit a task; refresh or open a second same-origin tab and confirm both show the same Host revision.
3. Run a task with pinned workspace, preset, and permission; confirm a new session appears and the task settles from its `turn/end` history.
4. Enable a near-future cron, close all browser pages, and confirm the Host still creates and settles exactly one execution.
5. Stop the Host past a cron occurrence, restart it, and confirm the missed occurrence is skipped and `nextRunAt` rolls forward from current Host time.
6. Enable `preventIdleSleep`, run a long session, and let the display turn off; after restoring the display, confirm the session continued and the execution settled.
7. Trigger three runs at once and confirm the Host starts them one after another in arrival order (default WIP limit 1), and that raising `maxConcurrentRuns` to 2 starts two at once.
8. Disable the setting and all schedules, stop DSH, and confirm the helper exits; on macOS, `pmset -g assertions` should show no display-sleep assertion from this plugin.
9. On Linux, use `systemd-inhibit --list` to confirm that only an `idle`/`block` entry exists; the display should still follow desktop settings, while manual sleep and lid close remain under system policy.

## Known limitations

- Missed occurrences during Host downtime, system sleep, or a long pause are skipped and never queued for catch-up.
- A task that is already running skips its due occurrence and rolls to the next cron match; two occurrences of the same task never overlap. Runs of *different* tasks do queue at the WIP limit (fork addition).
- DST follows the Host local wall clock: a nonexistent spring-forward minute is skipped, and a repeated fall-back minute is not replayed a second time.
- Power protection prevents only idle system sleep. It deliberately allows display sleep and lock.
- Lid close, manual sleep, hibernation, shutdown, low-battery forced sleep, and enterprise power policy are outside the guarantee.
- The plugin does not schedule wake timers and cannot wake a computer that is already asleep.
- Linux requires systemd-logind and policy permission for the current user to acquire an idle block lock. Containers, WSL, hosts without a system bus, and non-systemd systems may report `unsupported` or `error`. Whether a desktop also associates a logind idle lock with display idleness is desktop policy; the plugin does not request a screensaver or display inhibitor.
- Keeping enabled schedules armed may increase battery consumption because protection starts before their future trigger time.
- A run waiting in the WIP queue (fork addition) has no session yet; if the Host restarts before it starts, the execution settles as `cancelled` and the task must be started again.
- Host execution consumes the same API quota as an ordinary DSH agent session.

## Telemetry

**This fork sends no telemetry.** Upstream 0.3.23's browser half reported one anonymous install heartbeat per UTC day to `dsh-market.com` (a random localStorage id plus the package name, nothing else). This fork removed that call, so the board makes no telemetry request. `src/client/telemetry.ts` is kept on disk for a possible own endpoint but is not imported by the client entry. The removed algorithm is documented upstream in `docs/telemetry.md`, which is not part of this repository.
