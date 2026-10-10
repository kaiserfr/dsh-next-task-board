# State machine of the task board

The board's **columns are the task states**: the machine below is what the Host
enforces and what the browser renders. It is declared as plain data in
`src/core/state-machine.ts` (`DEFAULT_STATE_MACHINE`) and can be replaced per
deployment through the plugin config / settings namespace `task-board`, field
`stateMachine`.

A *transition* is an allowed state change together with the **actions** that
fire when it happens (open a feature branch, commit a feature branch, merge a
feature branch, start a run, open the clarification session, stamp a field).
Drag & drop is validated
against exactly these transitions — the browser asks the machine whether a drop is allowed, and the
Host refuses any `move` the machine does not list.

```mermaid
stateDiagram-v2
    [*] --> backlog
    state "columns: backlog | clarification | todo | running | ready_for_test | failed | done" as columns
    backlog --> clarification: manual: openBranch, clarify
    backlog --> ready_for_test: manual: commitBranch
    backlog --> done: manual
    backlog --> failed: manual
    clarification --> todo: manual
    clarification --> backlog: manual
    clarification --> ready_for_test: manual: commitBranch
    clarification --> done: manual
    clarification --> failed: manual
    todo --> clarification: manual: clarify
    todo --> backlog: manual
    todo --> ready_for_test: manual: commitBranch
    todo --> done: manual
    todo --> failed: manual
    ready_for_test --> backlog: manual
    ready_for_test --> todo: manual
    ready_for_test --> done: manual: mergeBranch
    ready_for_test --> failed: manual
    done --> backlog: manual
    done --> todo: manual
    done --> ready_for_test: manual: commitBranch
    done --> failed: manual
    failed --> backlog: manual
    failed --> todo: manual
    failed --> ready_for_test: manual: commitBranch
    failed --> done: manual
    ready_for_test --> running: manual: run
    failed --> running: manual: run
    todo --> running: manual: run
    running --> ready_for_test, failed, todo: runner
```

*Regenerate after changing the machine:*

```sh
node scripts/render-state-machine.mjs
```

`tests/state-machine.spec.ts` fails when this diagram no longer matches the
definition.

## Triggers

| Trigger  | Who fires it                                              |
|----------|-----------------------------------------------------------|
| `manual` | A human: drag & drop on the board, or a chip in the task detail. |
| `runner` | The execution runner settling a run (success → `ready_for_test`, failure → `failed`, cancel → `todo`). |
| `cron`   | A scheduled run.                                          |

`running` is the runner's own state: it carries `"drop": false` and only
`runner` transitions leave it. It is *entered* through the `run` action
(`todo → running`), never by a plain status move.

## Clarification column

`backlog → clarification` is the card's **clarification step**, and it runs for
every card — the column is where the agent asks before anything is implemented:

* The transition fires `clarify`, which starts the card's **clarification run**:
  the run column's execution, started through the same launch queue but **not**
  through the lane WIP limit — the clarification column is WIP-free, so the round
  starts right away even while another card of the same workspace is working (no
  **Queued** badge), with the same session link and the same pause/resume
  control. It checks no branch out, because it implements nothing. Its prompt is
  the card's normal run prompt plus the clarification block *"Bitte kläre jetzt
  alle offenen Fragen — und implementiere noch nichts. / Stelle deine Fragen und
  stoppe dann. / Wenn noch Fragen offen sind, stelle die nächsten und stoppe
  wieder. / Wenn du alles geklärt hast stoppe und fasse nur kurz zusammen. / Die
  Implementierung beginnt erst mit «Bitte jetzt implementieren»."*.
* **The questions are the agent's, not a form field.** There is no question list
  on the card: the agent asks what it still needs to know **in the chat** of
  that run, the human answers there, and the agent ends its turn.
* **Stopping is enforced past the first turn.** The board's system-prompt
  section (`TASK_BOARD_GUIDANCE`) carries a clarification-session stop rule that
  keys off the first line of that block and is re-sent with *every* turn: while
  a session is a clarification session, the agent implements nothing — after
  each answer it asks the next question and stops, or stops for good once the
  questions are settled. The wording of the block and the rule cannot drift: the
  rule interpolates the very lines the run sends (`CLARIFICATION_ADDENDUM`). It
  keeps the card in `clarification` — settling the run never changes the column.
* **The human closes the step.** `clarification → todo` is an ordinary manual
  move: the answers are settled, so the card goes on to the column where its
  specification is released. `clarification → backlog` sends it back, and
  `todo → clarification` fires `clarify` again — that re-enters the card's one
  conversation instead of minting a second one.
* The run lands in the card's one conversation (`clarificationSessionId`); the
  run that implements the card continues that same session, so the answers stay
  in context and no second conversation is opened. Passing the step again
  re-enters that conversation.
* A drag straight from `backlog` — or from `clarification` — to `running` has no
  transition at all: the card must pass `todo` first.
* Pulling the card from `todo` on to the run column — or its Run button — is the
  **go-ahead**: it closes the card's open clarification round (recorded as
  cancelled; a round whose launch has not started yet is dropped, and one whose
  session is still being created has that late session stopped instead of
  attached — so the card owns exactly one open execution and one conversation)
  and continues that conversation with *"Bitte jetzt implementieren."*. The
  implementation run itself is an ordinary run and still obeys the lane's WIP
  limit — and it is gated by the released specification.
* A **group drop** (`move-many`) never opens executions: a batch onto a
  transition that carries `run` *or* `clarify` is refused, so a batch can never
  start runs and never park a card in the clarification column without its
  round.

## Actions attached to transitions

| Action              | Effect                                                                 |
|---------------------|------------------------------------------------------------------------|
| `git.openBranch`    | Cuts the card's feature branch (`task/<slug>-<id8>`) from the base branch. No-op without a git repository. |
| `git.commitBranch`  | Commits the worktree onto the card's feature branch (`committedAt` stamp) and stamps the resulting head as `reviewedCommit` — the commit the review column shows, cutting the branch first when the card has none. No-op without a repository or when the worktree is clean — never an empty commit. |
| `git.mergeBranch`   | Merges the feature branch back into its base branch — but **only** the commit the card was parked on: a card without a recorded review commit, a dirty worktree, or a branch that moved past that commit is refused, so the card stays in `ready_for_test` (see *Review gate*). |
| `run`               | Opens an execution for the card and moves it to the transition target (drag onto "In progress"). A human start releases the clarification gate and continues the card's clarification session; only cron refuses an unresolved card. **Every** `run` (this move, the detail Run button, `rerun`, cron) is refused while the card has no released specification (see *Specification release*). |
| `clarify`           | Opens the card's clarification run: the same execution as `run` (same queue, but WIP-free — the clarification column starts without waiting for a lane slot), its prompt asks the agent's open questions in the card's chat and stops, it checks no branch out, and settling it leaves the card in its column. |
| `{ kind: "stamp", field: "doneAt" }` | Writes a timestamp into a task field.                    |

In the shipped machine the git actions describe the agentic-programming flow:
`backlog → clarification` opens the branch, every way into `ready_for_test` commits it
(`backlog →`, `todo →`, `done →` and `failed → ready_for_test` all carry
`git.commitBranch`), and `ready_for_test → done` merges it back. A branch or
merge hook that refuses fails the move, so a card never claims a branch or a
merge that did not happen; the commit hook is the deliberate exception — it
records its failure on the card (below) instead of blocking the park, because
uncommitted work must not keep a card out of the review column. The `run` action
sits on the way into `running`: `todo → running` starts the card, and
`ready_for_test → running` / `failed → running` pull a reviewed or failed card
straight back onto the run column (the run continues the card's conversation, so
a correction written there is already in context). `clarify`
rides the same `backlog → clarification` transition as the branch hook — the
card's clarification step.

## Commit policy: nothing stays uncommitted

Work on a card happens on its **feature branch**, and the worktree is never left
holding uncommitted card work:

* The branch is cut when the card enters `clarification` (and at run start when
  a cron trigger or the Run button skipped that step).
* **A run settles into `ready_for_test` only once its session has ended**: the
  runner reports `succeeded` after the newest `turn/end` solely when a fresh
  roster read no longer lists the session as running and its live inbox and jobs
  are quiet. An agent writing `FERTIG: <summary>` in its answer reports the work
  for the human; it does not move the card while the session is still running.
* Reaching **`ready_for_test` commits**: the `git.commitBranch` action covers
  every manual move into the column, and the runner's own settle
  (`running → ready_for_test`) commits through the same git helper, because a
  settle fires no configurable action. `git add -A` takes the whole worktree and
  commits it as `task: <title>`; a clean worktree produces no commit and leaves
  the previous `committedAt` in place.
* **Every settle commits, not only a successful one**: a failed run and a
  cancelled run (including the Host cancelling an interrupted start at restart)
  commit their work too, so nothing is left behind in any outcome. A
  clarification run implements nothing and checks no branch out — it never
  commits. A paused run is not settled and therefore commits nothing until it is
  resumed and settles.
* A commit that git refuses (a rejecting hook, say) **does not fail the move or
  the settle**: the error is appended to the newest execution's `error`, which
  the card's execution history in the detail view shows. A card that never ran
  has no execution to carry it and only gets a Host warning.
* The card's `TaskGit` records `committedAt` (the instant of the last commit, not
  shown in the UI) next to `mergedAt`.

## Specification release: the gate in front of every run

A card is implemented only after a human released its specification. The release
is one ledger stamp, `TaskRecord.specApprovedAt`, written by exactly one action —
`approve-spec` (the *Release specification* button in the card detail) — and
checked by the Host on **every** `run` path:

* the `run` transition (a drop onto the run column),
* the detail view's Run button (`run`/`rerun`),
* cron (`openScheduled`): an unreleased card is not started unattended; the
  occurrence is skipped and the schedule rolls to the next one, exactly like the
  permission gate.

The refusal is a Host error, so no browser path can bypass it: manual runs throw
`spec-approval-required`, cron skips silently and advances the schedule. A
clarification run (`clarify`) is *not* gated — asking the questions is what
happens before the release.

The gate re-arms when the released text changes: editing the content (title,
description, prompt) or the parse source clears the stamp, so a card whose
instruction changed is never implemented on the old approval. The same holds for
an imported card: the wire sanitizer whitelists an imported card's fields, so a
release never travels with it.

## Review gate: the approval is bound to one commit

Reaching `ready_for_test` does not only commit — it stamps the commit the branch
now stands on as the card's `reviewedCommit`. That is the state a human reviews,
and `git.mergeBranch` (the way into `done`) merges **exactly** it:

* The branch head must still equal `reviewedCommit`, and the worktree must be
  clean. A commit or an edit that lands after the park makes the approval stale:
  the merge is refused, the card stays in `ready_for_test`, and nothing lands on
  the base branch. Committing the leftover as a "safety net" is deliberately
  gone — that is precisely the unreviewed work the gate exists to stop.
* Re-parking the card rebinds the approval: every route back into
  `ready_for_test` (`git.commitBranch` on the manual moves, and the runner's own
  settle) stamps the new head. The ordinary way to review new work is therefore
  `ready_for_test → todo` (the rework return), correction in the card's chat,
  the next run, and the next park.
* A card **without** a `reviewedCommit` is refused too (fail closed): cards
  parked before this gate existed, and cards a custom machine routes into
  `ready_for_test` without `git.commitBranch`. Moving such a card out of the
  review column and back in stamps the commit; a custom machine should carry
  `git.commitBranch` on every way into `ready_for_test` (it already should, for
  the commit policy above).
* The refusal is an error on the `move`, not a card field: the browser shows the
  Host's reason and the card keeps its column.

`reviewedCommit` is only a bind — the merge target, the commit that reaches
`done`, is the one the human saw in the review column.

## Rework: back to `todo` from the review

A card that did not pass the review (or whose run failed) goes back to `todo`
when the human writes the correction into the card's **own conversation**: the
Host watches those chats, fires the ordinary `ready_for_test → todo` (or
`failed → todo`) move on that human turn, and stamps the card (`reworkAt`,
`reworkCount`). No note text is stored anywhere — the transcript *is* the note,
and the send-back never starts a run. The card's next run is marked as the
rework round, continues the corrected conversation, and opens with a short
framing turn instead of the card body (see the README section *Write the
correction into the card's chat*).

## Configuration

```jsonc
{
  "initial": "backlog",
  "states": [
    { "status": "backlog" },
    { "status": "clarification" },
    { "status": "todo" },
    { "status": "running", "drop": false },
    { "status": "ready_for_test", "label": "Review" },
    { "status": "done" },
    { "status": "failed", "order": 9 }
  ],
  "transitions": [
    { "from": "backlog", "to": "clarification", "actions": ["git.openBranch", "clarify"] },
    { "from": "clarification", "to": "todo" },
    { "from": "todo", "to": "running", "actions": ["run"] },
    { "from": "todo", "to": "ready_for_test", "actions": ["git.commitBranch"] },
    { "from": "ready_for_test", "to": "done", "actions": ["git.mergeBranch"] }
  ]
}
```

* `states[].status` — one of `backlog`, `clarification`, `todo`, `running`,
  `ready_for_test`, `done`, `failed` (the ledger's closed vocabulary). `label` overrides the
  column title, `order` moves the column, `drop: false` makes it a column that
  never accepts a card.
* `transitions[]` — `from`/`to` plus optional `trigger`, `actions`, `git`
  (`false` skips the git hooks of that transition). Anything not listed is
  refused. A custom machine should put `git.commitBranch` on its own ways into
  `ready_for_test`: stored configurations are left as they are, and only the
  runner's settle commits independently of the configured transitions.
* `initial` — where new cards land; required when `backlog` is not a column.

Invalid configuration never bricks the board: the normalizer refuses the whole
document with reasons, the machine in force stays, and the settings card marks
the field invalid. The Host hands its resolved machine to the browser inside
the snapshot, so both halves always validate against the same transitions.
