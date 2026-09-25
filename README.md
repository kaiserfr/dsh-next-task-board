# dsh-task-board — DSH web GUI task board plugin

English | [中文](README.zh.md)

> **Fork — `kaiserfr/dsh-next-task-board`.** Independent fork of
> [`zhu1090093659/dsh-web`'s `packages/dsh-task-board`](https://github.com/zhu1090093659/dsh-web/tree/dev/packages/dsh-task-board)
> (base **0.3.23**, Apache-2.0). It adds a **Host-enforced WIP limit per
> workspace**, **drag-to-start**, and an **agentic-programming workflow** (Ready-for-test
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
| **Execution concurrency** | Every run starts as soon as it is due; nothing bounds how many runs hold a session at once. | **Host-enforced WIP limit per workspace** `maxConcurrentRuns` (default **1**): runs of one workspace above the limit wait in a FIFO queue and start in arrival order as soon as a running execution of that workspace settles. Different workspaces are independent lanes and run in parallel. |
| **Done column** | Grows without bound; archiving is a manual action. | **Host-enforced Done-column limit** `maxDoneTasks` (default **9**): a move into Done that would exceed the limit archives the cards that entered Done earliest (FIFO) until the limit holds again — only as many as needed, never deleted, still reachable in the archive view. Applying the limit (Host start, settings change) trims an already over-limit column right away. |
| **Starting from the board** | Dragging a card only moves it between `backlog` and `todo`. | **Dragging a card onto "In progress" starts the task** through the same Host action as the detail view's Run button. |
| **Selecting several cards** | One card per drag; moving a set means dragging the cards one after another. | **Multi-select with group drag**: a click marks a card, Ctrl/Cmd-click adds or removes one, Shift-click marks the range from the anchor card up to the clicked one (board order: columns left to right, cards top to bottom). Dragging a marked card moves the whole marked set as one atomic `move-many` action — either every card moves or none does. A click on free board space or the clear button in the header chip drops the selection, an unmarked card still drags alone, and cards the state machine forbids in the target column stay behind. Since the plain click now marks, the **double click** opens the task detail (Enter on the focused card opens it too, Space marks it with the same modifiers). |
| **Card → session** | The card only shows a glyph for the latest run's session; reaching the transcript means opening the detail and finding the execution row. | **Each card with a session links straight into it**: a corner anchor jumps to the session transcript for a live (running) and a settled (inactive) execution alike, without opening the detail. The anchor carries a `#session=<id>` deep link, so middle-click / Ctrl-click or a copied URL opens the session too — the session roster is refreshed first when the id is not loaded yet, and a genuinely unknown session is reported instead of failing silently. |
| **Running card & WIP order** | The `running` column looks like any other column, and its cards keep the ledger's order. | The card that **holds a session right now** is unmistakable (thick warn border, warn-tinted surface, pulsing ring, "Running now" badge), while a card still waiting for a WIP slot keeps the thin column border and reads "Queued". The column is ordered like the queue: the executing card on top, then the waiting runs in arrival order — the card dragged in last sits at the bottom. |
| **Board workflow** | Five columns; new tasks start in `todo`. | **Agentic-programming defaults**: six columns with **Ready for test** directly before Done; new tasks start in **Backlog**; a successful run parks the card in Ready for test, and Done is reached only by a manual move. |
| **State engine** | The columns and their allowed moves are hardcoded. | **Configurable state machine** `stateMachine`: columns are task states, `transitions` declare which moves exist, and each transition carries its `actions` (`git.openBranch`, `git.mergeBranch`, `run`, `stamp`). The Host refuses any move the machine does not list and hands the resolved machine to the browser, so drag & drop is validated against exactly those transitions. See [`docs/state-machine.md`](docs/state-machine.md). |
| **Corrections after a test** | A card that failed its test can only be dragged back by hand, with nowhere to say what has to be fixed. | **Send back with a note**: a card in Ready for test gets a correction field and a *Send back to To Do* button (Host action `rework`). The note is stored on the card, shown there until the next run, and then delivered to the agent as its **own new message inside the card's previous conversation** — never as an edit of the original prompt, which stays the record of what was asked. A rework round therefore continues that conversation even for a card that never opted into session reuse; if the previous session is gone or busy, the note instead rides on a fresh prompt (with a Host warning) so it is never dropped silently. The move itself still goes through the state machine, and a rework never starts a run on its own. |
| **Git integration** | None. | When the card's pinned workspace is a local git worktree, the board **opens `task/<slug>-<id8>` when the card enters Todo, checks it out for the run, and commits + merges it back into the base branch when the card reaches Done** (no-op without a repository). |
| **Editing task content** | Content (title, description, prompt) locks after the first run, so a card that failed and was dragged back stays read-only forever. | **Content stays editable while the card waits in Backlog/To do** — whatever ran before; `running` and the settled columns (`ready_for_test`/`done`/`failed`) stay read-only, where *Edit as New Copy* is the way forward. The **"Parse with AI" source text is stored on the card**, so the edit form offers the same text again and *Parse and fill* can be re-run; when that text is gone the box opens on the card's title, description, and prompt. |
| **Telemetry** | The client sends one anonymous install heartbeat per UTC day to `dsh-market.com`. | **Removed.** No heartbeat is sent at mount; `src/client/telemetry.ts` stays on disk for a possible own endpoint but is not imported. |
| **Distribution** | Part of the `dsh-web` monorepo, installed from npm or the `web-ui-all` aggregate. | **Standalone repo**: `lib/` is committed, so `dsh plugin --profile web add github:kaiserfr/dsh-next-task-board` installs without a build step and without an `allowBuilds` approval. |
| **Agent announcement** | Names `dsh-task-board` and the upstream aggregate package. | Names this fork and spells out the WIP queue semantics to the agent. |

### Host-enforced WIP limit (per workspace / lane)

- Enforced in `TaskBoardHostService`, not merely in the browser.
- The limit is counted **per lane**, where a lane is the task's effective
  workspace (the handover bundle's workspace overrides the pin). Cards without a
  pinned workspace share one lane, because their real target is only resolved at
  launch time.
- Lanes are independent: runs of different workspaces start in parallel, and a
  saturated lane does not hold back later queue entries of other lanes. Within
  one lane the queue is still FIFO.
- A slot is freed when a running execution **settles**, not when its session is
  attached; otherwise the board would only be throttled at start instead of truly
  serial per workspace.
- A waiting run is already `running` in the ledger without a session, so its card
  reads as in progress and cannot be started a second time.
- Lowering the limit never aborts a running task: surplus slots drain as their
  executions settle while the queue holds the remaining launches back.
- The queue self-heals — an entry whose execution is no longer open (deleted,
  archived, or settled while it waited) is dropped on the next pump.
- Manual runs and cron runs share the launch queue, so both are limited.

### Done-column limit (FIFO displacement)

- The `done` column holds at most `maxDoneTasks` cards (default **9**). A move
  into Done that would leave more archives the cards that have been in Done
  longest — by their Done entry stamp, so the ledger's array position and the
  card's other fields do not affect the order. The limit applies to the `done`
  column only; other columns are never touched, and the surviving cards keep
  their order.
- Only as many cards are displaced as the limit requires, and they are
  **archived, not deleted**: status and execution history stay, the card leaves
  the columns and is reachable through the board's archive view, where it can be
  restored.
- The trim also runs whenever the limit is applied — at Host start (the
  configured `maxDoneTasks`) and on every settings change — so an already
  over-limit column converges immediately instead of waiting for the next move.
  Lowering N therefore trims the surplus right away.

### Drag a card onto "In progress" to start it

- The `running` column is a drop target and sends the same Host `rerun` action as
  the detail view's Run button, so the task really goes through the Host queue
  instead of being relabelled locally.
- Waiting, running, archived, and unknown cards are ignored; `backlog`/`todo`
  remain pure manual status moves.

### Send a card back with a correction note

- A card in **Ready for test** that did not pass review goes back to **To do**
  with a reason: the detail view offers a *Correction note* field and the
  *Send back to To Do* button (only there — the field has no meaning in any other
  column).
- The note travels as the Host action `rework` (trimmed, capped at 4000
  characters; a blank note is refused by the wire gate and re-checked by the
  Host). The move is validated against the state machine like every other move,
  so a machine without `ready_for_test → todo` refuses the rework instead of
  inventing a transition. A rework never starts a run: the human still decides
  when the agent works again (drag onto "In progress", the Run button, cron).
- The note does **not** rewrite the original prompt. Sessions are append-only and
  the original prompt is followed by everything the agent did, so the next run
  sends the note as **its own user message** inside the card's previous
  conversation: the transcript then reads *the original ask, the work, the review
  remark*. Without a note, a reuse prompt stays byte-for-byte what it was.
- To make that possible a rework round continues the previous session even for a
  card that never opted into `reuseSession`; the conditions of
  `core/session-reuse.ts` stay the single authority and keep failing closed. If
  the previous session is gone, still running, or the roster is unknown, no
  session is continued and the note is appended to a fresh prompt instead (with a
  Host warning), so a correction is never dropped silently.
- Lifecycle: the note sits on the card (`reworkNote`, shown in the detail view
  while it is pending), moves onto the execution record when the next run opens
  (audit trail), and then leaves the card. Without a Host transport the rework is
  refused, because only the Host writes the ledger.

### Edit content while the card waits

- Content (title, description, prompt) is editable exactly while the card is not
  archived and still waits in **`backlog` or `todo`** — regardless of how many
  runs it already had. A card that failed and was dragged back into a waiting
  column is preparation again and gets the edit form back; `running` (the session
  is reading that content right now), `ready_for_test`, `done`, and `failed` are
  locked and offer *Edit as New Copy* instead. The Host re-checks the same rule on
  every `update` patch, so a card that started running while the modal was open
  fails closed.
- The text of the **"Parse with AI"** box is stored on the card (`parseText`), so
  reopening the edit form offers the same source text and *Parse and fill* can be
  run again on an edited copy of it. Like the other content fields it is trimmed,
  and an empty box means "no stored text" rather than an empty string.
- When no stored text exists — cards created before the field, or a cleared box —
  the box opens on the card's **title, description, and prompt joined into one
  block** (blank parts dropped). The user edits that block and runs *Parse and
  fill* to rewrite the three fields. That fallback is derived, so it is only
  saved once the user actually works in the box: editing just the title or prompt
  leaves the stored source alone, and a card that never used the box does not
  acquire the fallback as its source.
- The box only appears where the deployment carries a parse face
  (`canParseTask`).

### Multi-select and group drag

- Selection works like a file manager: a plain click marks exactly that card and
  becomes the anchor, Ctrl/Cmd-click adds or removes a single card, and
  Shift-click marks the range from the anchor to the clicked card in board order
  (columns left to right, cards top to bottom within a column). A click on free
  board space or the clear button in the header chip drops the selection.
- Because the plain click now marks, the **double click** opens the task detail,
  and **Enter** on the focused card opens it directly. **Space** marks the
  focused card like a plain click, with the same modifiers (Shift = range,
  Ctrl/Cmd = toggle); the card consumes the keydown, so neither the button's
  synthetic click nor a page scroll follows. Opening the detail keeps the
  selection.
- Dragging a marked card carries the whole **draggable** selection; dragging an
  unmarked card still moves that one card only, so single-card drag & drop is
  unchanged. The drag payload keeps the lead id in `text/plain` for
  compatibility and adds the full id list under
  `application/x-dsh-taskboard-cards`.
- The Host receives one atomic `move-many` action: it validates every card
  before writing anything, so an invalid entry leaves the whole batch untouched
  and the revision bumps exactly once. Cards the machine does not allow into the
  target column stay where they are; if no dragged card may move, nothing
  happens and the selection stays.
- Moved cards keep their order among themselves (the Host keeps the ledger
  order). Dropping the group on the "In progress" column starts each eligible
  card one after another through the existing `rerun` path, so the runner's
  single-run invariant still holds.
- Feedback: marked cards get an accent border and tint, the cards under the
  cursor dim, and a counter names how many cards the drop will carry. The
  selection is browser-only view state (like the filter), never part of the
  ledger, and it is empty after a successful move.

### Running card marking and WIP column order

- "Running now" means the task's latest execution is open **and** has already
  attached its session — exactly the condition under which the Host holds a WIP
  slot (`isTaskExecuting`). Only that card gets the heavy warn treatment; an open
  run without a session is queued, not running, and stays visually quiet.
- The runner-owned column is ordered like its queue: the executing card(s) on
  top, then the waiting runs in arrival order, so the card pulled in last lands
  at the bottom. Every other column keeps the ledger's order.
- The ordering is presentation only (`compareWipOrder`); the ledger and the Host
  are untouched. The pulse respects `prefers-reduced-motion`.

### Agentic-programming workflow and git integration

- Columns: `backlog → todo → running → ready_for_test → done → failed`.
- New tasks are created in **Backlog**; pulling a card into **Todo** is the
  manual start signal.
- A successful execution parks the card in **Ready for test** (a failed one in
  Failed); the runner never produces `done`, so accepting the work is always a
  human move.
- The park is a **session-end statement**: the Host waits until the execution's
  session has actually stopped — its newest turn ended, the roster reports it
  idle, nothing sits in its prompt inbox and no background job of it is still in
  flight — before the card moves. A turn boundary alone never parks a card,
  because a session continues every queued prompt and every job wake-up as its
  own turn. Only a turn that ended `completed` counts as success: a run the user
  aborted, that hit the model token limit, was interrupted or errored ends in
  Failed with that reason, so an unfinished run can never look ready for testing.
  While the session is still working, the card stays in **In progress**.
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
  repository is meant); each workspace uses its own worktree, and the per-lane
  WIP limit means two runs of the same workspace never share a checkout — runs of
  different workspaces are safe to overlap.

## Features

- **Task board UI**: a sidebar entry below New Session shows icon and text in the wide sidebar and an icon in the collapsed rail; the board provides six kanban columns, search, task details, archive/restore, execution history, and links to execution transcripts. New tasks land in Backlog and cards drag between Backlog, Todo, Ready for test, and Done for a manual status change; dragging a card onto the running column starts it through the same Host action as the detail view's Run button **(fork addition)**. A card whose latest execution has a session also carries a direct session link in its corner, which jumps into the transcript for an active and an inactive session alike **(fork addition)**. Archived tasks are read-only except for restore, delete, and transcript viewing, and cannot run manually or on schedule until restored.
- **Host-enforced WIP limit per workspace (fork addition)**: at most `maxConcurrentRuns` task runs (default `1`) of one workspace hold a session at once; further manual and cron runs of that workspace wait in a FIFO queue and start as a running execution settles. Different workspaces run in parallel. See [What this fork adds](#what-this-fork-adds-over-the-upstream-task-board).
- **Host-enforced Done-column limit (fork addition)**: the `done` column holds at most `maxDoneTasks` cards (default `9`); a move into Done beyond the limit archives the cards that have been in Done longest (FIFO) — only as many as needed, never deleted, and restorable from the archive view. Applying the limit trims an already over-limit column immediately.
- **Running-card marking and WIP column order (fork addition)**: the card the runner is executing right now — latest execution open *and* session attached — is unmistakable (thick warn border, warn-tinted surface, pulsing ring, "Running now" badge), while a card of the same column still waiting for a WIP slot keeps the thin column border and reads "Queued". The runner-owned column is ordered like the queue: executing card first, then waiting runs in arrival order (last dragged-in card at the bottom); other columns keep the ledger order.
- **Multi-select and group drag (fork addition)**: a click marks a card, Ctrl/Cmd-click adds or removes one, Shift-click marks the range from the anchor card to the clicked one, and dragging any marked card moves the whole marked set in one atomic `move-many` Host action — either every card moves or none does, and the revision bumps once. Cards the state machine forbids in the target column stay behind; a drop with nothing movable changes nothing and keeps the selection. Dropping the group on the running column starts each eligible card in turn through the ordinary `rerun` path. A click on free board space or the header chip's clear button empties the selection, an unmarked card still drags alone, and the double click (or Enter on the focused card; Space marks from the keyboard) opens the detail as before.
- **Corrections after a test (fork addition)**: a card in Ready for test that did not pass the review goes back to To do with a written reason. The detail view offers a correction field and the *Send back to To Do* button (Host action `rework`, note trimmed and capped at 4000 characters); the move is validated against the state machine and never starts a run by itself. The note is not an edit of the original prompt: the next run delivers it as **its own user message inside the card's previous conversation**, which a rework round continues even for a card that never opted into session reuse. If that conversation is gone or busy, the note is appended to a fresh prompt instead, with a Host warning — a correction is never dropped silently. The note then lives on the execution record as the round's audit stamp.
- **Continuation cards (data plane)**: a new task may paste a `<<<FREEZE ... >>>FREEZE` block from a session; it parses into a goal/progress/next snapshot persisted with the task (ledger v3). Cards carry a frozen badge, the detail view shows the full snapshot and freeze time, search covers snapshot text, and archive/restore matches plain tasks. The snapshot reuses the freeze security gate at the protocol layer: sensitive patterns become `[REDACTED]` with a marker, slash-prefixed command lines reject the whole snapshot, and each field is capped at 8 KiB.
- **Handover bundles and the permission confirmation gate**: a continuation card may attach a handover bundle — the pinned execution triplet (workspace / agent preset / permission) plus doc/script references. The bundle's triplet overrides the plain pin fields at execution, and the references ride the prompt as a handover preamble. A binding whose effective permission is above `sessionDefaultPermission` (default `read-only`) is unconfirmed: manual run refuses, cron skips the card and rolls to the next occurrence, and the confirm button in the task detail resolves the binding; any later permission or bundle change re-arms the gate.
- **Claim provenance wrap and source audit**: executing a continuation card (a card with a frozen snapshot) mandatorily wraps the task instruction in a source-declaration template — freeze instant, source session, and an unreviewed-content warning — composed after the handover preamble so the picking-up agent stays wary of stored prompt injection in card text. The session issuing a create/update action is stamped into the snapshot (frozenBy, re-stamped when the snapshot is replaced), and the session issuing a run/rerun lands on the execution record (initiatedBy) together with a captured copy of the freeze provenance; both are visible in the task detail. The initiator is client-asserted audit metadata, not a trust boundary.
- **Task tags (issue #1521)**: a task may carry up to eight labels. A label renders as a colour-toned badge on the card — the tone is hashed from the name, so one label always paints the same way and no colour is stored — the board header gains a multi-select tag filter built from every label in use (including archived tasks), and search also matches label names. A label with an "execution hint" is injected ahead of the execution prompt on every run as a `标签提示` block; a label without one is display and filter only, so an untagged task's prompt is byte-for-byte what it was before the feature. Labels stay editable even where the content is locked: they classify the task and shape the next run, they are not the record of what already ran.
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
| `maxConcurrentRuns` | `1` | **Fork addition.** WIP limit per workspace: how many task runs of one workspace may hold a session at once. Runs of that workspace above the limit wait in a FIFO queue and start as soon as one of its tasks settles; other workspaces run in parallel. Queued cards already read as running (no session yet) and are recorded as `cancelled` when the Host restarts before they start. |
| `maxDoneTasks` | `9` | **Fork addition.** Done-column limit (N): a move into Done that would leave more than N cards there archives the cards that entered Done earliest (FIFO) until the limit holds again — only as many as needed, never deleted, still reachable in the archive view. Applying the limit at Host start or on a settings change trims an already over-limit column right away. Applies to the `done` column only. |
| `stateMachine` | the shipped machine | **Fork addition.** The board's state engine as one JSON document: the columns (`states`), the allowed state changes (`transitions`) and the actions a transition fires (`actions`: `git.openBranch`, `git.mergeBranch`, `run`, `stamp`). The Host refuses any `move` the machine does not list, and hands the resolved machine to the browser in the snapshot, so drag & drop is validated against exactly the same transitions. An invalid config is refused as a whole and the machine in force stays. See [`docs/state-machine.md`](docs/state-machine.md). |
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
3. Run a task with pinned workspace, preset, and permission; confirm a new session appears and the card turns **Ready for test** only once that session has ended (its turn finished and nothing is queued or still running in it).
4. Enable a near-future cron, close all browser pages, and confirm the Host still creates and settles exactly one execution.
5. Stop the Host past a cron occurrence, restart it, and confirm the missed occurrence is skipped and `nextRunAt` rolls forward from current Host time.
6. Enable `preventIdleSleep`, run a long session, and let the display turn off; after restoring the display, confirm the session continued and the execution settled.
7. Trigger three runs of one workspace at once and confirm the Host starts them one after another in arrival order (default WIP limit 1); pin one of them to a different workspace and confirm it starts in parallel. Raising `maxConcurrentRuns` to 2 starts two runs of the same workspace at once.
8. Disable the setting and all schedules, stop DSH, and confirm the helper exits; on macOS, `pmset -g assertions` should show no display-sleep assertion from this plugin.
9. On Linux, use `systemd-inhibit --list` to confirm that only an `idle`/`block` entry exists; the display should still follow desktop settings, while manual sleep and lid close remain under system policy.
10. Start one task and drag a second one of the same workspace onto "In progress": the executing card carries the thick warn border, the tinted surface and the "Running now" badge on top of the column, the waiting card keeps the thin border and reads "Queued" below it.
11. Click one card, Ctrl-click a second one, then Shift-click a fourth: the header chip should count the marked cards, the Shift range should cover everything between the anchor and the clicked card, and dragging any marked card onto another column should move them all at once, leaving the selection empty. A click on free board space, the chip's clear button, and a double click on a card (which opens the detail) should all behave as described.
12. Let a card run to **Ready for test**, open its detail, write a correction note and press *Send back to To Do*: the card lands in To do with the note shown as pending. Mark the card's `reuseSession` as off first and confirm that the next run still continues the previous session and that the session transcript shows the note as a **new user message** (the original prompt is untouched); after the run the pending note is gone from the card and sits on the execution row instead.

## Known limitations

- Missed occurrences during Host downtime, system sleep, or a long pause are skipped and never queued for catch-up.
- A task that is already running skips its due occurrence and rolls to the next cron match; two occurrences of the same task never overlap. Runs of *different* tasks of the same workspace do queue at the WIP limit (fork addition); runs of other workspaces do not.
- DST follows the Host local wall clock: a nonexistent spring-forward minute is skipped, and a repeated fall-back minute is not replayed a second time.
- Power protection prevents only idle system sleep. It deliberately allows display sleep and lock.
- A correction note can only be delivered into the card's previous conversation if that session is idle and still in the roster. Otherwise the next run starts a fresh session and the note is appended to the prompt there: the agent then gets the correction without the conversation it corrects (the Host logs a warning, and the note is never dropped).
- Lid close, manual sleep, hibernation, shutdown, low-battery forced sleep, and enterprise power policy are outside the guarantee.
- The plugin does not schedule wake timers and cannot wake a computer that is already asleep.
- Linux requires systemd-logind and policy permission for the current user to acquire an idle block lock. Containers, WSL, hosts without a system bus, and non-systemd systems may report `unsupported` or `error`. Whether a desktop also associates a logind idle lock with display idleness is desktop policy; the plugin does not request a screensaver or display inhibitor.
- Keeping enabled schedules armed may increase battery consumption because protection starts before their future trigger time.
- A run waiting in the WIP queue (fork addition) has no session yet; if the Host restarts before it starts, the execution settles as `cancelled` and the task must be started again.
- Multi-select (fork addition) moves cards **into a column**, not to a position: dropping *between* two cards is not supported, and the moved cards land in the target column in their previous order.
- Multi-select (fork addition) needs Ctrl/Cmd or Shift: on a pure touch device a tap only ever marks one card, so a group drag is not available there.
- Host execution consumes the same API quota as an ordinary DSH agent session.

## Telemetry

**This fork sends no telemetry.** Upstream 0.3.23's browser half reported one anonymous install heartbeat per UTC day to `dsh-market.com` (a random localStorage id plus the package name, nothing else). This fork removed that call, so the board makes no telemetry request. `src/client/telemetry.ts` is kept on disk for a possible own endpoint but is not imported by the client entry. The removed algorithm is documented upstream in `docs/telemetry.md`, which is not part of this repository.
