# AGENTS.md — dsh-task-board

dsh Web GUI 的 Host 权威多列任务看板。任务通过真实 DSH 会话执行，浏览器只负责异步展示与提交动作。

## Host 账本、执行与调度

- 权威账本固定为 `$DSH_HOME/task-board/ledger-v2.json`（文件名为历史沿用），当前 schema 为 `{ schemaVersion: 3, revision, tasks, scheduler }`；旧 v2 文档在 Host 启动时逐字段无损迁移为 v3 写回，迁移失败必须明确报错且保留原文件（不静默清零）；写入必须保持临时文件加原子 rename、损坏文件隔离和 revision 单调递增。
- 浏览器 `dsh.taskBoard.v1` 只用于一次性导入且必须保留；导入 marker 只能在 Host 确认后写。所有生产变更走 `protocol.ts` 的严格同源 action 协议，UI 不得先写未确认状态。
- 手动与 cron 统一走 `HostExecutionRunner`。钉住的 workspace、agent preset、permission 任一失效都在任务 Prompt 前 fail closed；默认每次 execution 创建独立会话，任务开启 `reuseSession` 后可复用上一次会话——复用条件由 `core/session-reuse.ts` 唯一裁定：上一执行已结算、该 session 仍在名册中且空闲（名册未知一律不复用），复用时重新应用钉住的 permission/model 再入队 Prompt，不重命名、不新建。
- 交接包三元组在执行时覆盖普通钉住字段；有效权限高于 `sessionDefaultPermission`（默认 `read-only`）的绑定必须先经 `confirm-permission` 动作人工确认（变更即重新武装），未确认卡片手动执行拒绝、cron 跳过并滚动 `nextRunAt`。
- cron 使用 Host 本地时区和标准日期/星期 OR 语义。Host 首启或长暂停后的过期出现全部跳过；同任务 running 时不排队、不并发，只滚动下一触发点。
- 重启恢复时，有 session id 的 running execution 继续观察；无 session id 的启动中断标为 cancelled（含留在待办列的澄清运行，结算它不改列），禁止自动重发。
- 暂停（`pause`/`resume`，卡片字段 `pausedAt`）不改列：暂停只停掉该运行的会话（`session/cancel`），卡片与执行记录都留在原处，`runtimeView()`/`settle()` 跳过已暂停的执行（被中止的回合不得把卡片打到 failed/todo），Host 重启也不取消它；恢复在同一会话里写入「Weitermachen (continue)」并清位，从未拿到会话的排队运行则回到启动队列，且暂停期间一律不启动。
- 返工（复核未通过）：卡片的**修正意见写在卡片自己的会话聊天里**，看板上没有任何说明输入框，账本里也没有备注字段。Host 在 `pollSessions` 里对 `ready_for_test`/`failed` 的卡片调用 `ledger.reworkWatch()`（廉价投影，热轮询路径不得 `state()` 全量克隆）并用 `runner.newestHumanTurn(sessionId, since=endedAt)` 读 `session/follow` 头部：出现 `user/message`（时间 ≥ 落位时刻）即用普通的、受状态机校验的 `move` 退回 `todo`。会话 `updatedAt` 未变不读历史；`known:false`（读不到）绝不当作「没有人工消息」，只重试。**退回动作只在卡片的会话里留话，账本里盖章**：任何 `ready_for_test`/`failed → todo` 的移动（人工拖拽/按钮与聊天触发同样）写 `reworkAt`/`reworkCount`，卡片详情显示一行；退回本身**绝不启动运行**。下一次运行由 `pendingRework(task)`（印记晚于最近一次非澄清运行）标记为返工轮（`ExecutionRecord.rework`，澄清轮不消耗印记）：强制 continue 被修正的会话（`reusableSessionId(..., { rework: true })`，无视 `reuseSession` 勾选）并且只发 `reworkPrompt()` 这段简短框架而不是整段 Prompt；会话丢失或正忙时 fail-closed 另开会话并走完整 Prompt，同时记警告。
- 完工报告（`FERTIG:`，常量 `COMPLETION_MARKER`/`COMPLETION_INSTRUCTION` 在 host-runner.ts）：实现运行由 agent 自己在最后一次回答里用独立一行 `FERTIG: <摘要>` 报告完成——这是**给聊天里的人看的报告，不是状态机输入**。`HostExecutionRunner.inspect()` 只有在运行确实结束**且其会话已终止**时才给出 `succeeded`：最新名册确认该会话不再是 running，且 `sessionEnded()` 的 live 基线（`session/control`，0.1.7 无 queues/jobs 时退回 idle 名册）确认无待处理工作；会话仍在跑（或仍被运行时记为 running）就保持 `pending`，卡片留在 running 并保留未结算的执行。**「进入 ready_for_test 必须以会话结束为前提」是硬性规则**：曾经的 `completionMarker` 捷径（读到该行立即结算，哪怕会话仍 running）已彻底删除，不得以任何形式恢复；历史结算路径（turn/end + 会话确认静止）是唯一路径。澄清运行无需开关：其会话结束也与实现无关，聊天里的 `FERTIG:` 不移动任何东西，卡片始终留在 todo 直到人工拉到运行列。暂停中的执行不参与 inspect；运行时始终不把会话记为结束时，卡片就留在 running（无超时、无例外），只能人工暂停推进，且该车道名额一直属于它。措辞只此一处：每个实现回合的 Prompt 末尾都追加该常量（`promptText`；澄清回合除外），`TASK_BOARD_GUIDANCE`（默认关闭的 `announceToAgent`）再插一份作每回合的兜底规则。
- 等待提问（question watch）：卡片的会话只要存在 agent 提出后停下等待的问题，卡片左上角就显示问号锚点，点击直接跳进该会话。判定只在 Host：`pollSessions` 对 `ledger.awaitingAnswerWatch()`（廉价投影，热轮询路径不得 `state()` 全量克隆）给出的候选——**有未结算运行的卡片**（agent 可能在运行中提问）与**留在 todo 且已跑过澄清轮的卡片**（澄清轮结算不改列，答案就在那条会话里）——调用 `runner.awaitingAnswer(sessionId, running)` 读 `session/follow` 头部，两种形状算「在等」：最新 surface 事件是未被 `tool/result` 回答的 `ask_user_question` 工具调用（阻塞模式：turn 与名册的 running 都还开着），或 agent 用自己的消息结束了一轮且名册确认该会话已静止（澄清轮与中途提问的形状）。timed 版 `ask_user_question` 的「前台等待结束但问题仍可回答」只存在于会话投影里（`session/projections` 的 `values.userQuestions.active`），因此作为第二来源读取；投影缺失（出厂预设是阻塞模式、或旧 Host）不算错误。结果以 `taskId → sessionId` 映射随快照与 SSE 帧下发（`awaitingAnswer`，与 `maxConcurrentRuns`/`maxDoneTasks` 一样随帧下发，因为它不 bump revision），**绝不写进账本**。**答案一出现符号就必须消失**：门控是会话 `updatedAt` 与名册 running 未变即沿用上次结论（等待中的卡片不产生额外 RPC），一旦有新事件就重读，最新事件不再是提问的 agent（用户回答、工具结果、新一轮）即为「不在等」；历史读不到（`undefined`）保留上次结论并在下轮重试，名册未知（`known:false`）时已发布的映射原样保留，暂停中的卡片与已归档卡片一律不是候选。卡片侧只读 `snapshot.host.awaitingAnswer[task.id]`，锚点复用既有 `#session=<id>` 深链与 `controller.openSession`。
- WIP 名额由**已附加 session 且尚未结算**的**实现**运行占据（严格 WIP=1/车道）：`pumpLaunchQueue` 按 lane 统计 `runtimeView().openExecutions`，跳过**澄清运行**（`execution.kind === 'clarify'`；Todo 列无 WIP 限制，澄清运行既不等待也不占用名额，拖进 Todo 立即启动，即使同 lane 正有运行在工作——`launchesInFlight` 同样不计它，否则后续卡片的提问会被压住）；`runtimeView()` 已隐藏暂停中的执行，因此暂停即释放名额。**不再参考 session 名册**：`idleSessionIds` 只服务会话复用（`reusableSessionId`），名册的 idle 只表示「此刻没有 turn 在跑」，不等于「运行已结束」——agent 中途提问而结束回合的运行仍然占着 worktree 与分支，若据此放行同 lane 的下一张卡，两条实现会话就会并发改同一份检出。名额只由 `settle()`（成功结算本身要求会话已结束）或 `pause` 释放；roster 每次轮询后仍必须重新 pump（`pollSessions` 末尾），因为一次结算可能刚好发生在轮询期间。

## 状态机（State Engine）

- 看板的列就是任务状态。`src/core/state-machine.ts` 是唯一权威：`DEFAULT_STATE_MACHINE`（`states` 列 / `transitions` 允许的状态转移 / 每个转移的 `actions`）是内置默认，设置命名空间 `task-board` 的 `stateMachine` 字段（JSON）可整体覆盖；配置无效时整份拒绝（`normalizeStateMachine` 给出原因）并继续沿用当前状态机，不得半套生效。
- 动作只有六种：`git.openBranch`、`git.commitBranch`、`git.mergeBranch`、`run`、`clarify`、`{ kind: "stamp", field }`。默认机器里 `git.openBranch` 只挂在 `backlog → todo` 上，`git.commitBranch` 挂在**所有**进入 `ready_for_test` 的人工转移上（`backlog →`、`todo →`、`done →`、`failed → ready_for_test`），`git.mergeBranch` 只挂在 `ready_for_test → done` 上；一个转移只执行**第一个** git 动作，`"git": false` 整体跳过。**提交策略（不许有未提交的工作）**：工作始终在 feature 分支上；进入 `ready_for_test` 即提交（`git add -A`，message `task: <标题>`，干净的 worktree 不产生空提交），Runner 自己的结算（`running → ready_for_test`）走同一个 git 助手，因为结算不触发任何可配置动作；**每个**结算都提交，不只成功——`failed`、`cancelled`（含 Host 重启时对中断启动的取消，`reconcileInterruptedStarts`）同样提交，`clarify` 不实现任何东西、不检出分支，因此**永不**提交，暂停中的运行不结算也就不提交；提交被 git 拒绝（如 hook）**不**让移动/结算失败，而是把错误追加到最新一次执行的 `error`（卡片详情页的执行历史可见；从未运行过的卡片只留 Host 警告），分支/合并动作仍然 fail-closed；`TaskGit.committedAt` 记录最后一次提交时刻（UI 不显示），`git.mergeBranch` 在合并前仍把残留一并提交作为安全网，合并仍是 `--no-ff`。自定义的已存 `stateMachine` JSON 不改动，文档说明其需自行在进入 `ready_for_test` 的转移上挂 `git.commitBranch`。`clarify` 与 `git.openBranch` 同挂 `backlog → todo`，该转移就是澄清步骤，对**每张卡片**生效：拖动即启动**澄清运行**——与「进行中」的运行完全相同的一次真实执行（同一条启动队列，但**不占 WIP 名额**：Todo 无 WIP 限制，因此立即启动、不会显示「排队等待」，拿到会话后显示 Running 并链接会话，同样可暂停/继续，Host 监视并结算它；它不检出 feature 分支，因为不实现任何东西），唯一区别是 Prompt：普通卡片 Prompt 加上澄清块「Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts.」「Stelle deine Fragen und stoppe dann.」「Wenn noch Fragen offen sind, stelle die nächsten und stoppe wieder.」「Wenn du alles geklärt hast stoppe und fasse nur kurz zusammen.」「Die Implementierung beginnt erst mit dem Auftrag „Bitte jetzt implementieren".」；为了让它也在**每个回合**生效（不只是第一回合），`TASK_BOARD_GUIDANCE` 里带一条以该块首行为触发的停止规则：判定为澄清会话时，agent 在用户回答之后也**不得实现**，只能继续提问并停下，或答完后停下；该规则直接插入 `CLARIFICATION_ADDENDUM` 常量（host-runner.ts），因此提示词与规则不可能漂移。**开放问题由 agent 在卡片自己的会话（聊天）里提出**，用户在聊天里回答，agent 回答完就停下——账本里没有让用户填写问题的字段（没有 openQuestions/questionsResolved，协议里也没有 clarify 动作），卡片**留在 todo 列**（结算不改列），同一条会话被后续实现运行复用，重复经过该步骤只是重进这条会话。`run` 挂在进入 `running` 的三个转移上：`todo → running`、`ready_for_test → running`、`failed → running`（后两个是返工/重试的直通车：从复核列或失败列直接拖回运行列，运行继续同一条会话）；`backlog → running` 依然没有转移，不允许跳过澄清步骤直接拖到「进行中」。人工启动（拖到「进行中」或点执行按钮）本身就是放行：Host 关闭该卡片尚未结算的澄清运行（`supersedeClarification`，结果 `cancelled`；尚未启动的启动会被丢弃，而正在创建会话的澄清运行会把它迟到的会话停掉、不挂到卡片上——`launch` 在 attach 前重新检查 `isOpenExecution`），并在同一会话里只发送「Bitte jetzt implementieren.」（不重复整段 Prompt，也不新建第二条会话）。新增动作种类必须同时扩展 `STATE_ACTION_KINDS` 与 Host 执行侧，不允许绕过配置在账本里硬编码转移。
- Host 是执行权威：`HostTaskLedger` 的 `move` 先用机器校验（未声明的转移一律 `invalid state transition`），再按配置顺序执行动作；`create` 落在 `initial`。浏览器不得自行推断可移动性。
- 浏览器与 Host 必须用同一份机器：`TaskBoardHostService` 把已解析的机器放进快照（`protocol.ts` 的 `stateMachine`），`client/board/TaskBoard.tsx` 据此渲染列并校验拖放；快照缺失时回退内置机器。
- 改动状态机定义后必须重跑 `node scripts/render-state-machine.mjs` 更新 `docs/state-machine.md`；`tests/state-machine.spec.ts` 会因两者不一致而失败。

## 电源保护

- `preventIdleSleep` 默认 `false`。开启后，全部 DSH running session、任一已启用 cron 或未知 session 状态都构成持锁理由；仅在已确认无运行会话且无计划时释放。
- macOS 只允许 `/usr/bin/caffeinate -i -w <pid>`；Windows 只允许从 `SystemRoot` 解析的 Windows PowerShell 固定 helper 和 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`。Linux 只允许绝对路径 `systemd-inhibit` 的 `idle`/`block` lock，不得请求 `sleep`、显示器或 lid-switch inhibitor。
- helper 必须 `shell: false`、固定参数、不依赖 PATH、失败有界退避，并在设置关闭、插件卸载和 Host 退出时清理；不得修改电源计划或要求管理员权限。无 systemd-logind 的 Linux 和其他平台只报 `unsupported` 或可见错误。

## 弹窗表单与草稿

- 任务弹窗（新建、副本、编辑内容、编辑标签）的字段状态**不得只活在弹窗组件里**：每个关闭路径（点击遮罩、Escape、取消、看板视图本身卸载）都要把整份表单交给 `BoardController` 的草稿位（`getFormDraft`/`saveFormDraft`/`discardFormDraft`，仅内存、刷新即清空），下次打开按 `new` / `duplicate:<卡片 id>` / `edit:<卡片 id>` / `tags:<卡片 id>` 恢复；从未改动的表单不留草稿，创建/保存成功后调用 `spend()` 作废（Host 确认晚于关闭时同样作废），恢复出来的表单显示「已恢复上次未完成的输入」+「丢弃草稿」，`+ 新建任务` 在有草稿时带 `data-draft="true"` 圆点。
- 「有没有东西值得保留」只比较表单值与未改动状态；不得用 `beforeunload`、localStorage 或「关闭前确认弹窗」替代这套机制。`tests/form-draft.spec.tsx` 固定该行为。

## 文件归属与测试

- Host 协议、账本、runner、scheduler 编排和 power 状态机放 `src/`；浏览器 transport 与 UI 放 `src/client/`；纯 cron 与任务转换留 `src/core/`。
- Host 功能只依赖官方 `@deepseek-ai/*` NPM SDK，不得导入 DSH 源码。`src/dsh-home.ts` 与 `src/loopback.ts` 原本由上游 `shared/host/` 经 `scripts/sync-shared.mjs` 生成；本分支已脱离 monorepo，这两个副本（以及 `build/` 里的构建预设）由本仓库直接维护。
- 变更账本、协议、runner、cron 或 power 时补对应单测；原生 helper 只在 `DSH_POWER_SMOKE=1` 且平台为 Windows/macOS/Linux 时运行 smoke，Linux 无可用 logind system bus 时显式跳过原生部分。

## 提交前检查

```sh
pnpm typecheck
pnpm test
pnpm build
```
