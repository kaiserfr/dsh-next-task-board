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
| **Execution concurrency** | Every run starts as soon as it is due; nothing bounds how many runs hold a session at once. | **Host-enforced WIP limit per workspace** `maxConcurrentRuns` (default **1**): runs of one workspace above the limit wait in a FIFO queue and start in arrival order as soon as the workspace has a free slot. Different workspaces are independent lanes and run in parallel. A slot is held by an open implementation run from session attachment until it settles (or its card is paused); the session roster does not free it, because a run that ended its turn mid-task still owns its worktree and branch. **Todo is WIP-free**: the clarification round of a card pulled into Todo starts right away, even while another card of the same workspace is working. |
| **Done column** | Grows without bound; archiving is a manual action. | **Host-enforced Done-column limit** `maxDoneTasks` (default **9**): a move into Done that would exceed the limit archives the cards that entered Done earliest (FIFO) until the limit holds again — only as many as needed, never deleted, still reachable in the archive view. Applying the limit (Host start, settings change) trims an already over-limit column right away. |
| **Starting from the board** | Dragging a card only moves it between `backlog` and `todo`. | **Dragging a card onto "In progress" starts the task** through the same Host action as the detail view's Run button. |
| **Selecting several cards** | One card per drag; moving a set means dragging the cards one after another. | **Multi-select with group drag**: a click marks a card, Ctrl/Cmd-click adds or removes one, Shift-click marks the range from the anchor card up to the clicked one (board order: columns left to right, cards top to bottom). Dragging a marked card moves the whole marked set as one atomic `move-many` action — either every card moves or none does. A click on free board space or the clear button in the header chip drops the selection, an unmarked card still drags alone, and cards the state machine forbids in the target column stay behind. Since the plain click now marks, the **double click** opens the task detail (Enter on the focused card opens it too, Space marks it with the same modifiers). |
| **Card → session** | The card only shows a glyph for the latest run's session; reaching the transcript means opening the detail and finding the execution row. | **Each card with a session links straight into it**: a corner anchor jumps to the session transcript for a live (running) and a settled (inactive) execution alike, without opening the detail. The anchor carries a `#session=<id>` deep link, so middle-click / Ctrl-click or a copied URL opens the session too — the session roster is refreshed first when the id is not loaded yet, and a genuinely unknown session is reported instead of failing silently. |
| **Running card & WIP order** | The `running` column looks like any other column, and its cards keep the ledger's order. | The card that **holds a session right now** is unmistakable (thick warn border, warn-tinted surface, pulsing ring, "Running now" badge), while a card still waiting for a WIP slot keeps the thin column border and reads "Queued". The column is ordered like the queue: the executing card on top, then the waiting runs in arrival order — the card dragged in last sits at the bottom. |
| **Pausing running work** | A running card can only be stopped by cancelling its session in the chat UI; the card then settles into its outcome column. | **Pause/resume in progress**: the board-header button pauses **every card in In progress** in one click (each card keeps its column and its execution record), each card carries a pause glyph while its run is open and a play glyph to start it again, and the detail view's execution button is the same control. Pausing stops the run's session, the run no longer counts as executing (no monitor, no WIP slot), and resuming writes a short **"continue" turn into that same conversation** — the card never changes column. The bulk button turns into *Resume all* once only paused cards are left. |
| **Board workflow** | Five columns; new tasks start in `todo`. | **Agentic-programming defaults**: six columns with **Ready for test** directly before Failed and **Done** last; new tasks start in **Backlog**; a successful run parks the card in Ready for test, and Done is reached only by a manual move. |
| **State engine** | The columns and their allowed moves are hardcoded. | **Configurable state machine** `stateMachine`: columns are task states, `transitions` declare which moves exist, and each transition carries its `actions` (`git.openBranch`, `git.commitBranch`, `git.mergeBranch`, `run`, `clarify`, `stamp`). The Host refuses any move the machine does not list and hands the resolved machine to the browser, so drag & drop is validated against exactly those transitions. See [`docs/state-machine.md`](docs/state-machine.md). |
| **Clarifying before work** | A task starts implementing straight away; whatever is unclear is discovered mid-run. | **Clarification step**: `backlog → todo` starts the card's run there (action `clarify`) exactly like a drop on the run column — same launch queue, but **no lane WIP limit** (Todo is WIP-free, so the round starts at once and links its session; pausable) — only its prompt is the card's run prompt plus the clarification block *Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts. / Stelle deine Fragen und stoppe dann. / Wenn noch Fragen offen sind, stelle die nächsten und stoppe wieder. / Wenn du alles geklärt hast stoppe und fasse nur kurz zusammen. / Die Implementierung beginnt erst mit dem Auftrag „Bitte jetzt implementieren".*. **The agent asks its open questions in that chat**, the human answers there and the agent stops; the card stays in Todo and there is **no question field** on the card. Pulling the card on to In progress (or its Run button) is the go-ahead: the open round is closed and that same session is continued with *Bitte jetzt implementieren.*. Dragging straight from Backlog to In progress has no transition at all. |
| **Waiting for an answer** | A card whose agent asked something looks exactly like any other card; the question is found by opening the session and reading the chat. | **The card shows that it waits and jumps to the question**: while a card's conversation holds a question the agent asked and stopped on, the card carries a question-mark anchor in its top-left corner. It appears with the question and leaves with the answer (the Host re-reads the conversation on its 5 s poll), and clicking it jumps into that very session — where the question card or the chat that asked sits. The `#session=<id>` deep link is the same one the session anchor uses. |
| **Reporting completion** | A finished run leaves the card in `running` until its session comes to rest; a session that keeps its turn open leaves the card looking busy, and only pausing it moves the card on. | **The run reports its own completion — the ended session decides the move**: the agent ends its last answer with a line of its own, `FERTIG: <short summary>`, for the human reading the chat. The card reaches **Ready for test** only once its session has actually ended (no running turn, nothing queued, no live job); a session the roster still reports as running keeps the card in In progress, whatever the chat says. |
| **Corrections after a test** | A card that failed its test can only be dragged back by hand, with nowhere to say what has to be fixed. | **Write the correction into the card's own chat**: the run settled, so the human types the remark into the very conversation it is about, and the Host — which watches the chat of every card waiting in Ready for test / Failed — sends the card back to **To do** on that human turn. There is **no note field** anywhere: the transcript *is* the note. The move is an ordinary, machine-validated `move`, and every send-back is stamped (`reworkAt`/`reworkCount`, shown in the detail view); it never starts a run by itself. The next run of that card is marked as the rework round (`ExecutionRecord.rework`), continues that conversation even for a card that never opted into session reuse, and opens with a short framing turn instead of the card body, because the ask, the work, and the correction are already in context. A card in Ready for test or Failed can also be pulled **straight onto the run column** (new transitions, `run` action) instead of being routed through To do. |
| **Git integration** | None. | When the card's pinned workspace is a local git worktree, the board **opens `task/<slug>-<id8>` when the card enters Todo, checks it out for the run, commits the work the moment the card reaches Ready for test (every run settle), and merges it back into the base branch when the card reaches Done** — so the worktree never keeps uncommitted card work (no-op without a repository). |
| **Editing task content** | Content (title, description, prompt) locks after the first run, so a card that failed and was dragged back stays read-only forever. | **Content stays editable while the card waits in Backlog/To do** — whatever ran before; `running` and the settled columns (`ready_for_test`/`done`/`failed`) stay read-only, where *Edit as New Copy* is the way forward. The **"Parse with AI" source text is stored on the card**, so the edit form offers the same text again and *Parse and fill* can be re-run; when that text is gone the box opens on the card's title, description, and prompt. |
| **Closing a task popup** | The form state lives in the popup component, and the backdrop closes it on mouse-down: one accidental click next to the popup throws the typed title, description, prompt, and — worst of all — the pasted "Parse with AI" text away, and no task is created because only the submit button talks to the Host. | **Closing keeps the form as a draft.** Clicking next to the popup, Escape, and *Cancel* all behave the same: the whole form (parse text, labels, workspace/mode/permission/model, schedule, freeze, handover) moves into a draft seat on the `BoardController` (in memory, so a page reload starts fresh) and comes back when the modal is opened again. Every modal has its own key — blank new task, duplicate (per source card), edit, labels (per card) — so a draft never surfaces on another card. A restored form shows *Restored what you had typed* with a **Discard draft** action, and the *+ New task* button carries a dot (`data-draft="true"`) while its draft waits. A form nobody touched leaves nothing, a created/saved task spends its draft (even when the Host confirms after the popup was closed), and a running AI parse is cancelled on close — the pasted text stays in the draft. |
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
- A slot is held by every open **implementation** execution that has attached
  its session, from attachment until the execution settles or the card is
  paused. The session roster is deliberately **not** consulted: it reports
  whether a turn is running right now, which is not the same as "the run is
  over". A run whose agent ended its turn mid-task (a question, a partial
  answer) is idle in the roster while its worktree, branch and card still belong
  to it — treating that as a free slot is what let a second run of the same
  workspace work in the same checkout. A clarification round never waits for, or
  holds, a slot — Todo is WIP-free, so it starts immediately. The queue is
  pumped again after every roster poll and on every ledger change (a settle or a
  pause releases the lane), so a waiting card starts as soon as its occupant
  settles.
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

### Write the correction into the card's chat

- A card in **Ready for test** (or **Failed**) that did not pass review goes back
  to **To do** by itself: the human writes the remark into the card's **own
  session chat** — the conversation the run lived in, reachable through the
  session link — and the Host sends the card back on that human turn. There is
  **no note field** in the detail view; the transcript *is* the note.
- The watch runs on the ordinary session poll (5 s) and reads only the head of
  the card's newest settled conversation: `ledger.reworkWatch()` is a cheap
  projection (the hot poll path never clones the document) and
  `HostExecutionRunner.newestHumanTurn()` reads the `session/follow` head. Two
  brakes keep it honest: an unchanged conversation `updatedAt` costs no history
  RPC, and an unreadable head is never treated as "no human turn" — it is
  retried. The correction itself is copied nowhere; the ledger keeps no note.
- The send-back is an ordinary, machine-validated `move` to `todo`, so a machine
  without `ready_for_test → todo` (or `failed → todo`) refuses it instead of
  inventing a transition. Every send-back is stamped (`reworkAt`, `reworkCount`),
  shown as a line in the detail view — whether the Host noticed the chat message
  or the human dragged/chipped the card back. A send-back never starts a run: the
  human still decides when the agent works again.
- The next run of a card whose stamp is newer than its last run is the **rework
  round** (`pendingRework`): it continues that conversation even for a card that
  never opted into `reuseSession` — `core/session-reuse.ts` stays the single
  authority and keeps failing closed — and its opening turn is the short rework
  framing (`reworkPrompt()`), not the card body, because the ask, the work, and
  the correction are already in context. A clarification round does not consume
  the marker. If the previous session is gone, still running, or the roster is
  unknown, no session is continued and the run proceeds with the full prompt
  (with a Host warning) rather than dropping the round silently.
- `ready_for_test → running` and `failed → running` (both carrying `run`) let the
  card be pulled straight from the review or failure column onto the run column;
  the run continues the same conversation, so the remark the human typed there is
  in context without a detour through To do.

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
  slot (`isTaskExecuting`). Only that card gets the heavy warn treatment.
- An open implementation run without a session is waiting for its lane's slot:
  the card reads "Waiting for the workspace" (`card.waiting`) and its tooltip
  names the blocker and the workspace ("… is already running in workspace (X)"),
  so a queued card never looks like a dead one. A card in Todo is never queued —
  it reaches its session at once. Dropping a card on the run column while the
  lane is held shows the same explanation once, as a board notice
  (`board.queuedNotice`); the task itself is still handed to the Host, which
  queues it and starts it as soon as the lane frees up.
- The runner-owned column is ordered like its queue: the executing card(s) on
  top, then the waiting runs in arrival order, so the card pulled in last lands
  at the bottom. Every other column keeps the ledger's order.
- The ordering is presentation only (`compareWipOrder`); the ledger and the Host
  are untouched. The pulse respects `prefers-reduced-motion`.

### Agentic-programming workflow and git integration

- Columns: `backlog → todo → running → ready_for_test → failed → done`.
- New tasks are created in **Backlog**. Pulling a card into **Todo** is the
  clarification step and starts the card's run there — the same execution a drop
  on the run column starts (same launch queue, same session link, same pause
  control, but no lane WIP limit: it starts right away), only its prompt tells
  the agent to ask what it still needs to know and to stop (see below).
- A card reaches **In progress** by a human start — the drag or the Run button —
  which closes the card's open clarification round and continues that
  conversation with the implementation. A drag straight from Backlog to In
  progress has no transition and is refused.
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
    run that skipped the Todo pull (cron or the Run button) opens the branch at
    start.
  - **Reaching Ready for test commits**: the `git.commitBranch` action covers
    every manual move into the column, and the runner's own settle
    (`running → ready_for_test`) commits through the same helper, because a
    settle fires no configurable action. `git add -A` commits the whole worktree
    as `task: <title>` (a clean worktree means no empty commit), the card's git
    state records `committedAt`, and a card without a branch gets one cut first.
  - **No run leaves work uncommitted**: a failed or cancelled run commits as
    well — including the Host cancelling an interrupted start at restart — while
    a clarification run implements nothing, checks no branch out and never
    commits. A commit git refuses (a rejecting hook, say) does not fail the move
    or the settle: the error is appended to the newest execution's error and
    shows up in the card's execution history (a card that never ran only gets a
    Host warning).
  - Ready for test → Done commits any leftover as a safety net and merges the
    branch back with `--no-ff`. A git failure there (e.g. a merge conflict) fails
    the move and keeps the card in Ready for test.
- Limits: git needs a pinned workspace (without one the board cannot know which
  repository is meant); each workspace uses its own worktree, and the per-lane
  WIP limit keeps two *implementation* runs of the same workspace out of one
  checkout — runs of different workspaces are safe to overlap. A clarification
  round may start next to a working run, but it checks no branch out and
  implements nothing, so the checkout stays with the run.

### Clarification step in Todo

- Pulling a card out of the backlog **starts its run in Todo** — the same
  execution a drop on the run column starts. It goes through the same launch
  queue, but **not** the per-lane WIP limit: Todo is WIP-free, so the round
  starts right away, even while another card of the same workspace is working
  (it reads *Running* once it has its session and links it in the corner), it is
  monitored and settled like any other run, and it carries the same pause/play
  control. The card **stays in Todo** — settling the run never
  changes its column, and the run never parks the card in
  `ready_for_test`/`failed`.
- Its prompt is the card's normal run prompt plus the clarification block
  *Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts. /
  Stelle deine Fragen und stoppe dann. / Wenn noch Fragen offen sind, stelle die
  nächsten und stoppe wieder. / Wenn du alles geklärt hast stoppe und fasse nur
  kurz zusammen. / Die Implementierung beginnt erst mit dem Auftrag „Bitte jetzt
  implementieren".*
- **The questions are the agent's: it asks them in the card's chat**, the human
  answers there, and the agent ends its turn. There is deliberately **no question
  field** on the card — the list would be the human's, and what has to be settled
  is what the agent does not know yet.
- **The stop holds past the first turn.** The board's system-prompt section
  carries a clarification-session stop rule that keys off the first line of that
  block and is re-sent with *every* turn: in a clarification session the agent
  implements nothing — after each answer it asks the next question and stops, or
  stops for good once everything is settled. The block's wording and the rule are
  the same constant (`CLARIFICATION_ADDENDUM`), so they cannot drift apart.
- **Pulling the card on to the run column is the go-ahead** (the Run button
  works the same way): the Host closes the open clarification round and
  continues that conversation with the short turn *Bitte jetzt implementieren.* —
  the agent already holds the card prompt, the questions it asked and the
  answers. A round the go-ahead supersedes while its launch is still running is
  closed as well: its late session is stopped instead of being attached, so the
  card owns exactly one open execution and one conversation.
- `backlog → running` has no transition at all, so the clarification step cannot
  be skipped by a drag.
- The run **continues the clarification session** (`clarificationSessionId`)
  instead of minting a new conversation: the answers are already in its context,
  and passing the step again re-enters that same conversation. If that session
  is gone or busy the run falls back to a fresh one, exactly like the optional
  session reuse.

### The card shows a waiting question

- **Two things count as "waiting"**, because the agent can ask in two ways. A
  **blocking `ask_user_question` call** nothing has answered yet: the turn stays
  open, so the roster still reports the session as *running* while the agent
  waits for the click. And a **turn the agent ended with a message of its own**
  while the session rests — the shape the clarification round produces by
  stopping after every question round, and the shape a run takes when it stops
  mid-work to ask.
- **The Host reads it off the conversation, not off the card.** The 5 s session
  poll re-reads a card's newest events (`session/follow`) for exactly the cards
  that can be waiting — every card with an open, unsettled run, plus a Todo card
  that already ran its clarification round — and publishes a `taskId → sessionId`
  map in the snapshot and on the SSE frame. Nothing is written to the ledger: the
  question is the chat's, the board only points at it.
- **Appears with the question, gone with the answer.** The map entry is dropped
  the moment the conversation's newest event is no longer the asking agent (the
  human's answer, a tool result, a new turn) — the symbol never survives the
  answer, and it does not wait for the next run to start. On hosts or presets
  that use the **timed** `ask_user_question` schema, the durable `userQuestions`
  session projection is read as a second source, because that call's foreground
  wait can end while the question stays answerable; the projection is absent in
  the shipped blocking presets, which is no evidence either way.
- **Failure policy.** An unreadable history keeps the last verdict and retries on
  the next poll (a question the human owes an answer to is never dropped because
  of one bad read), an unknown session roster leaves the published map untouched,
  and a session missing from the roster contributes nothing. A paused card is left
  out on purpose: its session was stopped deliberately, which is not a wait.
- **Clicking the symbol jumps into the session** through the same `#session=<id>`
  deep link as the card's session anchor (so middle-click / Ctrl-click and a
  copied URL work too) — the question card sits in that session's composer, or
  the chat that asked is right there to answer in. The existing session anchor
  stays in the bottom corner; the question symbol is the top-left one.

### The run reports its own completion

- A run in In progress ends its work with a **line of its own**:
  `FERTIG: <short summary>`. The wording comes from the `COMPLETION_MARKER` /
  `COMPLETION_INSTRUCTION` constants in `src/host-runner.ts` and is appended to
  **every implementation turn's prompt** (the full prompt, the short *Bitte jetzt
  implementieren.* go-ahead, the continue turn and the rework turn), so the run
  always knows the contract; the clarification turn deliberately does not carry
  it. The board's system-prompt section repeats the same constants as a rule for
  every turn when `announceToAgent` is on — the announcement is off by default
  and is therefore not the only carrier.
- **The report is for the human, not the state machine.** The card reaches
  **Ready for test** only once the execution's session has come to rest:
  `HostExecutionRunner.inspect()` returns `succeeded` only after a fresh roster
  read reports the session as no longer running **and** the live control baseline
  shows nothing queued and no background job in flight. A session that is still
  working — or simply still reported as running by the runtime — keeps the
  outcome `pending`, so the card stays in In progress with its open execution,
  even when its chat already says `FERTIG:`.
- The `FERTIG:` line therefore never races the session: it is what the human
  reads, and the settle is what the session end triggers. Both are covered:
  `tests/host-runner.spec.ts` proves the report alone cannot settle a running
  session and that the same run parks once the session has ended, and
  `tests/host-service.spec.ts` runs the whole poll loop — card stays `running`
  with the report in the chat, then moves to `ready_for_test` after the session
  ends.
- A session whose runtime never reports it as ended keeps its card in **In
  progress** (deliberately: no timeout, no exception). Pausing the card still
  moves it on by hand, and the lane slot stays with the card until it settles.
- A clarification round is exempt for the same reason it always was: its chat
  stops after every question round without the work being done, so a round keeps
  the card in Todo until the human pulls it on. Since the report no longer settles
  anything, the distinction needs no flag — the round simply never settles into
  Ready for test.

## Features

- **Task board UI**: a sidebar entry below New Session shows icon and text in the wide sidebar and an icon in the collapsed rail; the board provides six kanban columns, search, task details, archive/restore, execution history, and links to execution transcripts. New tasks land in Backlog and cards drag between Backlog, Todo, Ready for test, and Done for a manual status change; dragging a card onto the running column starts it through the same Host action as the detail view's Run button **(fork addition)**. A card whose latest execution has a session also carries a direct session link in its corner, which jumps into the transcript for an active and an inactive session alike **(fork addition)**. Archived tasks are read-only except for restore, delete, and transcript viewing, and cannot run manually or on schedule until restored.
- **Clarification step before the work (fork addition)**: pulling a card into Todo starts the card's run there — same launch queue as In progress, but no WIP limit, so it starts right away (Todo is WIP-free) and is pausable — with the card prompt plus the clarification block (*Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts.* … *Die Implementierung beginnt erst mit dem Auftrag „Bitte jetzt implementieren".*), which a system-prompt stop rule keeps in force after every answer. The agent asks its open questions in that chat and the human answers there (there is no question field on the card); pulling the card on to In progress (or the Run button) closes the round and continues that same session with *Bitte jetzt implementieren.*. See [Clarification step in Todo](#clarification-step-in-todo).
- **Host-enforced WIP limit per workspace (fork addition)**: at most `maxConcurrentRuns` task runs (default `1`) of one workspace hold a session at once; further manual and cron runs of that workspace wait in a FIFO queue and start as soon as the workspace has a free slot. Todo's clarification runs are exempt: they never wait for, or hold, a slot. A slot is held from session attachment until the execution settles or the card is paused — an idle session does not free it, so two runs of one workspace can never work in the same checkout **(fork addition)**. Different workspaces run in parallel. See [What this fork adds](#what-this-fork-adds-over-the-upstream-task-board).
- **Agent-reported completion (fork addition)**: an implementation run ends its last answer with `FERTIG: <summary>` for the human reading the chat; the Host settles the run and moves the card to Ready for test only once the session itself has ended — a session the roster still reports as running blocks the move. See [The run reports its own completion](#the-run-reports-its-own-completion).
- **Host-enforced Done-column limit (fork addition)**: the `done` column holds at most `maxDoneTasks` cards (default `9`); a move into Done beyond the limit archives the cards that have been in Done longest (FIFO) — only as many as needed, never deleted, and restorable from the archive view. Applying the limit trims an already over-limit column immediately.
- **Running-card marking and WIP column order (fork addition)**: the card the runner is executing right now — latest execution open *and* session attached — is unmistakable (thick warn border, warn-tinted surface, pulsing ring, "Running now" badge), while a card of the same column still waiting for a WIP slot keeps the thin column border and reads "Queued" (a card pulled into Todo never waits — its round starts at once). The runner-owned column is ordered like the queue: executing card first, then waiting runs in arrival order (last dragged-in card at the bottom); other columns keep the ledger order.
- **Pause and resume in-progress runs (fork addition)**: the board header's pause button suspends **every card holding an open run in one click** (the clarification run in Todo included) — each card keeps its column and its open execution record, only the run's session is stopped (`session/cancel`), so a paused card is neither "running now" nor "queued", does not occupy a WIP slot, and is left alone by the settlement monitor (an aborted turn never parks it in `failed`). The same button turns into *Resume all* (play glyph) when only paused cards are left, every card carries the pause/play control of its own run in its top corner, and the detail view's execution button is that same control. Resuming clears the stamp and writes a short **"continue" turn into the run's own conversation**, so the agent picks the task back up with its context intact; a run paused before it ever got a session is instead started normally. A paused card stays `running` (the stamp is `pausedAt`) and survives a Host restart paused.
- **Multi-select and group drag (fork addition)**: a click marks a card, Ctrl/Cmd-click adds or removes one, Shift-click marks the range from the anchor card to the clicked one, and dragging any marked card moves the whole marked set in one atomic `move-many` Host action — either every card moves or none does, and the revision bumps once. Cards the state machine forbids in the target column stay behind; a drop with nothing movable changes nothing and keeps the selection. Dropping the group on the running column starts each eligible card in turn through the ordinary `rerun` path. A click on free board space or the header chip's clear button empties the selection, an unmarked card still drags alone, and the double click (or Enter on the focused card; Space marks from the keyboard) opens the detail as before.
- **Corrections after a test (fork addition)**: a card that did not pass the review goes back to To do on the human's own chat turn. The Host watches the conversation of every card waiting in Ready for test / Failed, sends the card back with an ordinary, machine-validated `move`, and stamps the send-back (`reworkAt`/`reworkCount`, shown in the detail view). There is no correction field: the transcript is the note. The next run is the rework round (`ExecutionRecord.rework`) — it continues that conversation even for a card that never opted into session reuse and opens with the short rework framing instead of the card body; a clarification round does not consume the marker, and a lost or busy conversation falls back to the full prompt with a Host warning. `ready_for_test → running` and `failed → running` (both `run`) also let the card be pulled straight onto the run column.
- **Form drafts in the task modals (fork addition)**: an accidental click next to a popup no longer throws the form away. The new-task, duplicate, edit, and label forms hand their field values to a draft seat on the `BoardController` when they unmount, so backdrop click, Escape, and *Cancel* all close the popup while the next open restores exactly what was typed — the pasted "Parse with AI" text included. Drafts are keyed per form (one per card for the edit/label forms), live in memory only, and are forgotten by the explicit *Discard draft* action, by the *+ New task* button's dot resolving (a created or saved task), and by a form nobody touched; a parse still running is cancelled when the popup closes.
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
| `maxConcurrentRuns` | `1` | **Fork addition.** WIP limit per workspace: how many task runs of one workspace may hold a session at once. Runs of that workspace above the limit wait in a FIFO queue and start as soon as one of its tasks settles; other workspaces run in parallel. Todo's clarification runs do not count against the limit — they start without a slot, even while the workspace is working. Queued cards already read as running (no session yet) and are recorded as `cancelled` when the Host restarts before they start. |
| `maxDoneTasks` | `9` | **Fork addition.** Done-column limit (N): a move into Done that would leave more than N cards there archives the cards that entered Done earliest (FIFO) until the limit holds again — only as many as needed, never deleted, still reachable in the archive view. Applying the limit at Host start or on a settings change trims an already over-limit column right away. Applies to the `done` column only. |
| `stateMachine` | the shipped machine | **Fork addition.** The board's state engine as one JSON document: the columns (`states`), the allowed state changes (`transitions`) and the actions a transition fires (`actions`: `git.openBranch`, `git.commitBranch`, `git.mergeBranch`, `run`, `clarify`, `stamp`). The Host refuses any `move` the machine does not list, and hands the resolved machine to the browser in the snapshot, so drag & drop is validated against exactly the same transitions. An invalid config is refused as a whole and the machine in force stays. A custom machine should carry `git.commitBranch` on its own ways into `ready_for_test`; a stored document is left as it is. See [`docs/state-machine.md`](docs/state-machine.md). |
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
7. Trigger three runs of one workspace at once and confirm the Host starts them one after another in arrival order (default WIP limit 1); pin one of them to a different workspace and confirm it starts in parallel. Raising `maxConcurrentRuns` to 2 starts two runs of the same workspace at once. A card pulled into Todo is not part of that queue: its clarification round starts immediately, even while the workspace's run is working. When a run of the lane has ended its turn but is not settled yet (the agent asked a question mid-task), the queued card must stay queued — the lane frees up only when the run settles or the card is paused. Dropping a card on In progress while the lane is held leaves it in the column with the waiting badge and shows the board's queue notice naming the blocker.
8. Disable the setting and all schedules, stop DSH, and confirm the helper exits; on macOS, `pmset -g assertions` should show no display-sleep assertion from this plugin.
9. On Linux, use `systemd-inhibit --list` to confirm that only an `idle`/`block` entry exists; the display should still follow desktop settings, while manual sleep and lid close remain under system policy.
10. Start one task and drag a second one of the same workspace onto "In progress": the executing card carries the thick warn border, the tinted surface and the "Running now" badge on top of the column, the waiting card keeps the thin border and reads "Queued" below it.
11. Click one card, Ctrl-click a second one, then Shift-click a fourth: the header chip should count the marked cards, the Shift range should cover everything between the anchor and the clicked card, and dragging any marked card onto another column should move them all at once, leaving the selection empty. A click on free board space, the chip's clear button, and a double click on a card (which opens the detail) should all behave as described.
12. Let a card run to **Ready for test**, open its detail, write a correction note and press *Send back to To Do*: the card lands in To do with the note shown as pending. Mark the card's `reuseSession` as off first and confirm that the next run still continues the previous session and that the session transcript shows the note as a **new user message** (the original prompt is untouched); after the run the pending note now sits on the execution row instead.
13. Run a card in In progress and confirm its last answer contains `FERTIG: …`: the card stays in In progress as long as the session still shows as running in the session list, and moves to **Ready for test** within one poll cycle (~5 s) after that session has ended.
14. With a workspace whose card in To do has a clarification round still waiting for your answer (or a finished run that has not settled yet), drag another card of that workspace into To do or onto "In progress": the card must start (Running, session attached) instead of reading "Queued". While a run of the same workspace is genuinely working, a further card must still wait as "Queued" and start once that run is at rest.
15. As the counter-check, drop a card onto To do while nothing runs in its workspace and confirm it starts immediately, and drop one onto "In progress" while no run of that workspace is working — both must start, not queue.
16. Open **+ New task**, type something into *Parse with AI* (and a title), then click next to the popup (or press Escape): the popup closes and nothing is created. Open **+ New task** again: title and pasted text are back, the note *Restored what you had typed* with *Discard draft* sits on top, and the button carried a dot (`data-draft="true"`) while the draft waited. *Discard draft* empties the form and removes the mark; filling the form and pressing *Create* also leaves no draft behind. Reload the page and confirm the draft is gone (drafts are in memory by design), and repeat the same check in a card's *Edit* and label popups (one draft per card).

## Known limitations

- Missed occurrences during Host downtime, system sleep, or a long pause are skipped and never queued for catch-up.
- A task that is already running skips its due occurrence and rolls to the next cron match; two occurrences of the same task never overlap. Runs of *different* tasks of the same workspace do queue at the WIP limit (fork addition) — Todo's clarification rounds excepted, they start at once; runs of other workspaces do not.
- Whether a lane's slot is taken is decided by the session roster (`session/list`): a session the last poll saw at rest does not hold the slot. A run whose session is idle while it still owns queued work or a live background job (the inspect path knows that, the roster flag alone does not) can therefore free its lane's slot for a few seconds before its next turn starts. That is the deliberate trade-off for not queueing cards behind a finished run; the settlement monitor still refuses to settle such a run.
- DST follows the Host local wall clock: a nonexistent spring-forward minute is skipped, and a repeated fall-back minute is not replayed a second time.
- Power protection prevents only idle system sleep. It deliberately allows display sleep and lock.
- A correction note can only be delivered into the card's previous conversation if that session is idle and still in the roster. Otherwise the next run starts a fresh session and the note is appended to the prompt there: the agent then gets the correction without the conversation it corrects (the Host logs a warning, and the note is never dropped).
- Lid close, manual sleep, hibernation, shutdown, low-battery forced sleep, and enterprise power policy are outside the guarantee.
- The plugin does not schedule wake timers and cannot wake a computer that is already asleep.
- Linux requires systemd-logind and policy permission for the current user to acquire an idle block lock. Containers, WSL, hosts without a system bus, and non-systemd systems may report `unsupported` or `error`. Whether a desktop also associates a logind idle lock with display idleness is desktop policy; the plugin does not request a screensaver or display inhibitor.
- Keeping enabled schedules armed may increase battery consumption because protection starts before their future trigger time.
- A run waiting in the WIP queue (fork addition) has no session yet; if the Host restarts before it starts, the execution settles as `cancelled` and the task must be started again. Only implementation runs queue: a card in Todo starts right away.
- Multi-select (fork addition) moves cards **into a column**, not to a position: dropping *between* two cards is not supported, and the moved cards land in the target column in their previous order.
- Multi-select (fork addition) needs Ctrl/Cmd or Shift: on a pure touch device a tap only ever marks one card, so a group drag is not available there.
- A newly created card can be **invisible right away**: `+ New task` stays available in the archive view and under an active search/tag/project filter, but a fresh card is unarchived and matches no filter, so no column shows it. This is left as is (the draft fix above covers the reported case); switch back to the board or clear the filter to see it.
- Host execution consumes the same API quota as an ordinary DSH agent session.

## Telemetry

**This fork sends no telemetry.** Upstream 0.3.23's browser half reported one anonymous install heartbeat per UTC day to `dsh-market.com` (a random localStorage id plus the package name, nothing else). This fork removed that call, so the board makes no telemetry request. `src/client/telemetry.ts` is kept on disk for a possible own endpoint but is not imported by the client entry. The removed algorithm is documented upstream in `docs/telemetry.md`, which is not part of this repository.
