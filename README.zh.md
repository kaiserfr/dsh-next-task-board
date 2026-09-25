# dsh-task-board — DSH web GUI 任务看板插件

[English](README.md) | 中文

> **分支版本 — `kaiserfr/dsh-next-task-board`。** 上游为 [`zhu1090093659/dsh-web` 的 `packages/dsh-task-board`](https://github.com/zhu1090093659/dsh-web/tree/dev/packages/dsh-task-board)（基线 **0.3.23**，Apache-2.0）。本分支新增 Host 侧**按工作区计的 WIP 并发上限**、**把卡片拖到 running 列即启动** 与 **面向 agentic programming 的默认流程**（Ready for test 列、新任务入 Backlog、自动开 feature 分支并在完成时合并），并移除上游的安装心跳遥测——详见[本分支相对上游的增强](#本分支相对上游的增强)与 [FORK-NOTES.md](FORK-NOTES.md)。

一个可热插拔的 DeepSeek Harness (DSH) Web GUI 插件，提供 Host 权威任务账本、真实 DSH 会话执行、Host cron 调度和可选的跨平台空闲睡眠保护。插件只通过 `cordis.patch.yml` 与 profile 机制挂载，不修改 DSH 源码。

- 浏览器只是异步视图；关闭页面不会停止 Host 调度或执行结算。
- 每次运行在发送任务 Prompt 前应用钉住的工作区、agent 预设与权限；默认每次新建独立 DSH 会话，任务也可选择改为在上一会话中继续（issue #1419）。
- 可选电源保护允许显示器熄灭，同时阻止整机因空闲进入系统睡眠。

## 本分支相对上游的增强

本包是上游 `@linxin666/dsh-client-ui-task-board` 0.3.23 的**直接替换**：读写同一个账本（`$DSH_HOME/task-board/ledger-v2.json`，schema v3），已有任务不受影响；两者不可同时安装（都挂载同一 Host 路由与同一系统提示段）。

| 方面 | 上游 0.3.23 | 本分支 |
| --- | --- | --- |
| **执行并发** | 到点即启动，不限制同时持有会话的运行数。 | **Host 侧按工作区计的 WIP 上限** `maxConcurrentRuns`（默认 **1**）：同一工作区超出的运行先入 FIFO 队列，按先来后到、在某个运行结算后立刻启动；不同工作区各自成 lane，可并行。 |
| **Done 列** | 无上限增长；归档只能手动。 | **Host 侧 Done 列上限** `maxDoneTasks`（默认 **9**）：移入 Done 后若超出上限，按进入 Done 的先后自动把最早的卡片（FIFO）归档，只归档到刚好满足上限为止；不删除，可在归档视图找回。应用上限时（Host 启动或设置变更）也会立即收敛已超限的列。 |
| **从看板启动** | 拖拽只是在 `backlog` 与 `todo` 之间手动改状态。 | **把卡片拖到 running 列即启动任务**，与详情页「运行」按钮走同一个宿主动作。 |
| **多选卡片** | 一次只能拖一张；批量移动只能逐张拖。 | **多选 + 整组拖拽**：点卡片标记（Ctrl/Cmd 点击增减、Shift 点击选区间），再拖任意一张已标记的卡片，整组一起移动；双击卡片打开详情，点看板空白处或清除按钮清空选择，未标记的卡片仍然只移动自己。Host 收到的是**一个**原子动作 `move-many`——要么全部移动、要么一张都不动；状态机不允许进入目标列的卡片留在原地。 |
| **卡片直达会话** | 卡片只为最近一次执行显示一个会话符号；要查看 transcript 得先打开详情、再找到执行记录。 | **每张带会话的卡片都直接链接到该会话**：卡片角上的链接直接跳到 transcript，运行中（active）与已结束（inactive）的执行都一样，无需打开详情。链接是带 `#session=<id>` 深链的锚点，因此中键 / Ctrl 点击或复制 URL 也能打开会话——本地名录还没有该 id 时会先刷新会话名录，确实未知的会话会明确报错而不是静默失败。 |
| **运行中卡片与 WIP 顺序** | `running` 列与其他列外观一致，卡片按账本顺序排列。 | **此刻持有会话**的卡片一眼可辨（加粗警告色边框、警告色底、脉冲光环与 “Running now” 徽标）；仍在等待 WIP 名额的卡片保持细边框并标记 “Queued”。该列按队列排序：正在运行的卡片在最上，等待中的运行按到达顺序排列——最后拖入的卡片在最下面。 |
| **看板流程** | 五列；新任务落在 `todo`。 | **面向 agentic programming 的默认值**：六列，**待测试（Ready for test）** 紧邻 Done 之前；新任务落在 **Backlog**；执行成功后卡片停在 Ready for test，Done 只能手动到达。 |
| **状态机** | 列与允许的移动写死在代码里。 | **可配置状态机** `stateMachine`：列即任务状态，`transitions` 声明存在哪些转移，每个转移带自己的 `actions`（`git.openBranch`、`git.mergeBranch`、`run`、`stamp`）。未声明的 `move` 一律被 Host 拒绝，且 Host 把已解析的状态机随快照下发给浏览器，拖放校验与实际执行完全一致。详见 [`docs/state-machine.md`](docs/state-machine.md)。 |
| **Git 集成** | 无。 | 卡片钉住的工作区若是本地 git 仓库：**进入 Todo 时开 `task/<slug>-<id8>` 分支，运行时检出该分支，进入 Done 时提交改动并把分支合并回基线分支**（没有仓库时全部为 no-op）。 |
| **遥测** | 客户端每个 UTC 日向 `dsh-market.com` 发送一次匿名安装心跳。 | **已移除**：挂载时不再发送心跳；`src/client/telemetry.ts` 文件保留以备自建端点，但客户端入口不再引用。 |
| **分发方式** | 属于 `dsh-web` monorepo，从 npm 或 `web-ui-all` 聚合包安装。 | **独立仓库**：`lib/` 随仓库提交，`dsh plugin --profile web add github:kaiserfr/dsh-next-task-board` 无需构建步骤，也无需 `allowBuilds` 批准。 |
| **Agent 播报** | 播报 `dsh-task-board` 与上游聚合包。 | 播报本分支名称，并向 agent 说明 WIP 排队语义。 |

### Host 侧 WIP 并发上限（按工作区 / lane）

- 由 `TaskBoardHostService` 在 Host 侧强制，不只是浏览器里的显示效果。
- 上限**按 lane 计数**，lane 即任务的有效工作区（handover 包里的工作区覆盖普通 pin）。没有钉住工作区的卡片共用同一个 lane，因为它的真实目标要到启动时才解析。
- 各 lane 互相独立：不同工作区的运行可并行，某个 lane 满额也不会挡住队列中后面其他 lane 的条目；同一 lane 内部仍按先来后到。
- 释放名额的时机是运行**结算（settle）**，而不是会话附加；否则看板只是在启动阶段被限流，并非每个工作区真正串行。
- 排队中的运行在账本里已是 `running` 但尚无 session，因此其卡片读作进行中，不会被重复启动。
- 调低上限不会中止正在运行的任务：多余的槽位随结算自然收敛，队列拦住其余的启动。
- 队列会自愈：执行已不再处于打开状态（被删除、归档或等待期间已结算）的条目在下一次 pump 时被丢弃。
- 手动运行与 cron 运行共用同一条启动队列，因此同样受限。

### Done 列上限（FIFO 归档）

- `done` 列最多保留 `maxDoneTasks` 张卡片（默认 **9**）。移入 Done 后若会超出上限，则按**进入 Done 的时间**归档最早进入的卡片（与账本数组位置、其他字段无关）。上限只作用于 `done` 列，其他列绝不被触碰；存留卡片保持原有顺序。
- 只归档满足上限所需的张数，且是**归档而非删除**：状态与执行历史保留，卡片离开各列但仍在账本中，可在看板的归档视图找回并恢复。
- 应用上限时（Host 启动加载配置、设置变更）同样立即执行归档，因此已超限的列会马上收敛，不必等下一次移入 Done；调低 N 会立刻归档超出的部分。

### 拖到 running 列即启动

- `running` 列是拖放目标，发送与详情页「运行」按钮相同的 Host `rerun` 动作，任务真正经过 Host 队列启动，而不是仅在本地改状态。
- 排队中、运行中、已归档以及未知的卡片一律忽略；`backlog`/`todo` 仍是纯手动状态切换。

### 多选与整组拖拽

- 标记方式与文件管理器一致：普通点击选中该卡片（替换原有选择），Ctrl/Cmd 点击把该卡片加入或移出选择，Shift 点击选中从锚点卡片到被点卡片之间的区间（按看板顺序：列从左到右，列内从上到下）。点看板空白处或顶栏芯片里的清除按钮清空选择。
- 因为普通点击现在用于标记，**双击**打开任务详情；焦点卡片上按 **Enter** 同样直接打开详情，按**空格**则像普通点击一样标记（Shift 为区间、Ctrl/Cmd 为切换）——卡片自行消费该 keydown，因此既不会产生按钮的合成点击，也不会滚动页面。打开详情不会清空选择。
- 拖已标记的卡片会带上**整份可拖拽的选择**；拖未标记的卡片仍然只移动那一张，因此单卡拖拽行为不变。拖拽载荷在 `text/plain` 里保留领队卡片 id（向前兼容），并在 `application/x-dsh-taskboard-cards` 里带上完整 id 列表。
- Host 收到的是**一个**原子动作 `move-many`：写账本前先校验整组，任一条目非法则整批不变（`revision` 只涨一次）。状态机不允许进入目标列的卡片留在原地；若没有一张可移动，则什么都不发生，选择也保留。
- 被移动的卡片彼此之间的顺序保持不变（Host 保留账本顺序）。整组拖到 running 列时，每张合法卡片依次走既有的 `rerun` 路径启动，runner 的单次运行不变量依然成立。
- 反馈：已标记卡片带强调色边框与底色，正在拖拽的卡片变暗，并用计数器说明本次会移动几张。选择是纯浏览器视图状态（和筛选一样），不进账本；移动成功后选择为空。

### 运行中卡片的标记与 WIP 列顺序

- 「正在运行」的判定：最后一次执行仍处于打开状态**且**已经附加了 session——正是 Host 持有 WIP 名额的条件（`isTaskExecuting`）。只有这类卡片得到加粗警告色边框、警告色底、脉冲光环与 “Running now” 徽标。
- 已打开但**尚无 session** 的执行属于 WIP 队列：它们在同一列里保持细边框、无光环，并标记 “Queued”，因此与真正运行的卡片清晰可辨。
- runner 拥有的列按队列顺序渲染：正在运行的卡片在最上，随后是等待中的运行（按到达顺序），最后拖入的卡片落在最下面；其他列保持账本顺序。
- 排序只是浏览器侧的展示（`compareWipOrder`），账本与 Host 不变；脉冲动效遵循 `prefers-reduced-motion`。

### Agentic-programming 流程与 Git 集成

- 列顺序：`backlog → todo → running → ready_for_test → done → failed`。
- 新任务创建在 **Backlog**；把卡片拖进 **Todo** 就是人工下达的开工信号。
- 执行成功把卡片停在 **Ready for test**（失败则进入 Failed）；runner 不会产生 `done`，验收永远是人工动作。
- 这个停靠是**会话结束的结论**：Host 会等到该执行所属会话真正停下来——最新一轮 turn 已结束、名册显示会话空闲、它的 prompt 收件箱为空、且没有仍在运行的后台 job——才移动卡片。单个 turn 边界从不单独触发停靠，因为会话会把每个排队 prompt、每次 job 唤醒都当作新的一轮继续跑。只有以 `completed` 收尾的 turn 才算成功：被用户中止、撞上模型 token 上限、被 interrupt 或报错的运行会带着原因进入 Failed，未完成的运行因此永远不会显示为可测试。会话仍在工作时，卡片保持 **In progress**。
- 卡片钉住的工作区是 git worktree 时，Host 在后台把工作留在 feature 分支上：
  - Backlog → Todo 开 `task/<标题slug>-<id8>`，从当前分支切出（若 HEAD 已在看板分支上则以 `main`/`master` 为基线，避免第二张卡叠在第一张上）。
  - 每次运行前检出该分支，即「In progress」在该分支上工作；若启动跳过了 Todo（cron、直接拖到 running 或详情页运行按钮），则在启动时补开分支。
  - Ready for test → Done 提交工作区里的改动，并用 `--no-ff` 把分支合并回基线分支。git 失败（如合并冲突）会让这次移动失败，卡片留在 Ready for test。
- 边界：git 需要钉住工作区（没有 pin 就无法知道指哪个仓库）；每个工作区各有自己的 worktree，且按 lane 计数的 WIP 上限保证同一工作区的两个运行不会共用检出——不同工作区并行是安全的。

## 功能

- **任务看板 UI**：新会话按钮下方的侧边栏入口在宽栏显示图标和文字、在折叠 rail 显示图标；看板提供六列布局、搜索、任务详情、归档/恢复、执行历史和执行会话跳转。新任务落在 Backlog，卡片可在 Backlog、Todo、Ready for test、Done 之间拖拽以手动改状态；把卡片拖到 running 列会发送与详情页「运行」按钮相同的宿主动作，真正启动该任务**（本分支新增）**。最近一次执行带会话的卡片，角上还有一个直达会话的链接，对运行中与已结束的会话都可用**（本分支新增）**。归档任务除恢复、删除和查看 transcript 外保持只读，恢复前不能手动或定时执行。
- **Host 侧按工作区计的 WIP 并发上限（本分支新增）**：同一工作区同一时间最多 `maxConcurrentRuns` 个任务运行持有会话（默认 `1`）；该工作区其余手动与 cron 运行进入 FIFO 队列，在某个运行结算后按先来后到启动；不同工作区互不影响、可并行。详见[本分支相对上游的增强](#本分支相对上游的增强)。
- **Host 侧 Done 列上限（本分支新增）**：`done` 列最多 `maxDoneTasks` 张卡片（默认 `9`）；移入 Done 超出上限时按进入顺序归档最早的卡片（FIFO），只归档所需张数，不删除，可在归档视图恢复；应用上限时也会立即收敛已超限的列。详见[本分支相对上游的增强](#本分支相对上游的增强)。
- **运行中卡片标记与 WIP 列顺序（本分支新增）**：此刻真正在运行的卡片（最后一次执行仍打开且已附加 session）用加粗警告色边框、警告色底、脉冲光环与 “Running now” 徽标突出显示；同一列中仍在等待 WIP 名额的卡片保持细边框并标记 “Queued”。runner 拥有的列按队列排序：正在运行的卡片在最上，等待中的运行按到达顺序排列（最后拖入的在最下）；其他列保持账本顺序。
- **多选与整组拖拽（本分支新增）**：点卡片标记（Ctrl/Cmd 点击增减、Shift 点击选区间、焦点卡片上按空格同样标记），再拖任意一张已标记的卡片，就会以一个原子 `move-many` 宿主动作移动整组——要么全部移动、要么一张都不动，`revision` 只涨一次。状态机不允许进入目标列的卡片留在原地；整组拖到 running 列时依次启动每张合法卡片。点看板空白处或按顶栏芯片的清除按钮会清空选择，未标记的卡片仍然只移动自己。
- **续接卡片（数据面）**：新建任务时可粘贴会话输出的 `<<<FREEZE … >>>FREEZE` 冻结块，解析为「目标/进度/下一步」快照随任务持久化（v3 账本）；卡片带冻结徽标，详情页可读完整快照与冻结时间，搜索覆盖快照文本，归档/恢复与普通任务一致。快照在协议层复用冻结安全门：敏感模式自动替换为 `[REDACTED]` 并标记、以 `/` 开头的命令行整体拒绝、每字段 8 KiB 上限。
- **交接包与权限确认门**：续接卡片可附交接包——钉住三元组（工作区/agent 预设/权限）加文档与脚本引用。执行时交接包三元组覆盖普通钉住字段，引用以交接前言随 Prompt 下发。有效权限高于 `sessionDefaultPermission`（默认 `read-only`）的绑定处于待确认状态：手动执行被拒绝、cron 跳过该卡并滚动到下一触发点，任务详情中的确认按钮完成人工确认；此后任何权限或交接包变更都会重新武装确认门。
- **领卡来源声明包裹与来源审计**：执行续接卡片（带冻结快照的卡片）时，任务指令被来源声明模板强制包裹——冻结时间、来源会话与未经人工审查提示，组合在交接前言之后，使接手 Agent 对卡片文本中的存储型提示注入保持警惕。create/update 动作的发起方会话织入快照（frozenBy，快照被替换时重新盖章），run/rerun 的发起方会话连同冻结来源的捕获副本一起落在执行记录（initiatedBy）上，两者均可在任务详情查看。发起方为客户端断言的审计元数据，不构成信任边界。
- **任务标签（issue #1521）**：每个任务可带最多八个标签。标签在卡片上渲染为带色调的徽章——色调由标签名哈希得到，因此同一标签永远同色，也不需要存储颜色；看板顶栏据此提供多选标签筛选，候选项来自全账本在用的标签（含已归档任务），搜索也会匹配标签名。填了「执行提示」的标签会在每次执行前以 `标签提示` 段注入到执行 Prompt 之前；没填的标签只作展示与筛选，因此无标签任务的 Prompt 与加入该功能前逐字节一致。标签在首次执行后仍可编辑：它们给任务分类、塑造下一次运行，而不是「已经跑过什么」的凭证。
- **项目分区（issue #1536）**：看板头部新增项目下拉，选项来自当前部署的 DSH 工作区——「全部项目」加每个已注册项目。选定项目后各列只显示钉在该项目上的任务，未钉工作区的任务只在「全部项目」下可见；在某个项目下打开「新建任务」会把该项目预选为任务工作区，「新建项目…」则用与 GUI「添加项目」相同的运行时接口把宿主目录注册为项目。
- **粘贴文本 AI 解析（issue #1540）**：新建任务表单可以把从别处复制的一段话交给模型，整理成标题、描述和执行 Prompt。模型取当前部署已配置的模型（与任务「模型」下拉同一份列表，默认选中第一项），调用在宿主侧完成，走看板既有的回环与同源校验，预算 45 秒并支持取消。解析结果只填进表单：不提交就不会创建任务，解析失败也不会改动你已经输入的内容。
- **Host 权威账本**：任务、计划和执行记录存于 `$DSH_HOME/task-board/ledger-v2.json`；浏览器动作只有经 Host 确认后才成为 UI 状态。
- **有界执行历史**：每个任务只保留最近 20 条执行记录；新运行开始时截掉最旧的记录，使账本大小与每次写入成本不随任务历史无限增长。
- **真实执行**：手动运行和定时运行共用 Host runner，默认新建独立会话、重命名、应用 agent 预设和 `/permission <id>`，再以 queue 模式发送任务 Prompt。
- **可选会话复用**：任务可选择在上一执行会话中继续（issue #1419）。仅当该会话空闲且仍在运行时会话名册中才复用——Host 会重新应用钉住的权限与模型再以 queue 模式发送 Prompt，会话标题与历史保持不变；否则照旧新建会话，因此名册未知或会话正忙都不会阻塞定时运行。
- **钉子失败即关闭**：工作区缺失、预设缺失或损坏、权限命令被拒绝时，任务 Prompt 不会发送。
- **Host 调度器**：5 段 cron 支持 `*`、`*/n`、范围、逗号列表、周日 `0/7` 和标准的日期/星期 OR 语义，时间基准为 Host 本地时区。
- **确定性恢复**：已有 session id 的 running execution 在重启后继续观察；没有 session id 的启动中断会取消且不会重发。
- **实时同步**：变更返回完整 revision snapshot；SSE 只提示 revision、scheduler 与 power 变化，重连和页面恢复可见时重新拉完整 snapshot。
- **可选空闲睡眠保护**：默认关闭；开启后覆盖全部运行中的 DSH 会话、已启用且未归档的任务计划和未知会话状态。
- **系统提示词注入**：Host 通过 `SystemPrompt.section` 注册 order 200 的 `plugin:task-board` 段；任务看板设置可单独关闭声明而不关闭看板。该提示也会提醒 agent 在最终回复前收尾可见的 `todo_write` 计划列表。

## 架构与协议

看板视图在首次打开时渲染，关闭后重新打开会保留本地视图状态。Host 同步、调度和执行独立于视图持续运行。

- `src/index.ts` 通过官方 `@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh-workspace` 与 `@deepseek-ai/dsh-host-webserver` SDK 挂载 Host 服务。
- `src/host-ledger.ts` 串行动作，并用临时文件加原子 rename 持久化 `{ schemaVersion: 3, revision, tasks, scheduler, recentRequests }`。
- `src/host-service.ts` 负责 cron tick、错过触发跳过、runner 启动、重启对账和电源保护理由。
- `src/client/host-api.ts` 单次导入旧浏览器数据、提交幂等动作，并把 Host snapshot 当作唯一已确认 UI 状态。
- 同源接口为 `GET /api/task-board/state`、`GET /api/task-board/events` 和 `POST /api/task-board/action`。
- 所有接口都要求浏览器同源标记。直接访问只允许 DSH loopback origin；同机认证反向代理必须使用显式 Host 白名单和服务端注入 token。POST 还必须为 JSON。普通动作上限 64 KiB，导入上限 2 MiB。action 联合中没有命令、可执行路径、shell 文本或任意参数字段。

## 安装

安装聚合包或单独安装本包，然后重启 `dsh web`：

```sh
dsh plugin --profile web add github:kaiserfr/dsh-next-task-board
```

本地开发安装：

```sh
git clone https://github.com/kaiserfr/dsh-next-task-board.git
cd dsh-next-task-board
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)
```

## 配置

| 键 | 默认值 | 行为 |
| --- | --- | --- |
| `enabled` | `true` | 启用 Host 服务与浏览器看板。 |
| `announceToAgent` | `false` | 按需开启：开启后向 agent 系统提示加入任务看板说明。 |
| `preventIdleSleep` | `false` | 存在运行中的 DSH 会话、已启用计划或未知会话状态时，持有一个系统空闲睡眠断言。 |
| `maxConcurrentRuns` | `1` | **本分支新增。** 按工作区计的 WIP 并发上限：同一工作区同一时间允许持有会话的任务运行数。该工作区超出的运行进入 FIFO 队列，在某个运行结算、名额空出后自动启动；其他工作区并行不受影响。排队中的卡片已显示为运行中（尚无 session），若 Host 在其启动前重启则该执行记为 `cancelled`。 |
| `maxDoneTasks` | `9` | **本分支新增。** Done 列上限（N）：移入 Done 后若会超过 N 张，则按进入 Done 的时间归档最早的卡片（FIFO），只归档到刚好满足上限为止；不删除，可在归档视图找回。Host 启动或设置变更时应用上限会立即收敛已超限的列。只作用于 `done` 列。 |
| `stateMachine` | 内置状态机 | **本分支新增。** 看板状态引擎，一份 JSON：列（`states`）、允许的状态转移（`transitions`）以及转移触发的动作（`actions`：`git.openBranch`、`git.mergeBranch`、`run`、`stamp`）。未声明的 `move` 一律被 Host 拒绝；Host 把自己解析出的状态机随快照下发给浏览器，因此拖放校验与实际执行的所有转移完全一致。配置无效时整份拒绝，继续沿用当前状态机。详见 [`docs/state-machine.md`](docs/state-machine.md)。 |
| `trustedProxyHosts` | `[]` | 仅通过已认证 loopback 反向代理路径接受的规范 `host[:port]` authority 白名单。 |
| `proxyTokenEnv` | `DSH_TASK_BOARD_PROXY_TOKEN` | 保存反向代理 token 的环境变量名；token 本身不会写入插件配置。 |
| `sessionDefaultPermission` | `read-only` | 部署的会话默认权限。卡片有效权限（交接包或钉住字段）高于该值时，运行前必须经人工确认；cron 拒绝调度待确认卡片。 |

浏览器直接访问仍限制为 DSH loopback origin。若使用同机认证反向代理，应让 DSH Web 绑定 loopback，配置 `trustedProxyHosts`，在 `proxyTokenEnv` 指定的环境变量中放置高熵 token，并让代理在完成认证后替换（不能透传客户端提供的）`X-Dsh-Task-Board-Proxy-Token`。代理 Host 必须在白名单内，浏览器 `Origin` 必须与其 authority 相同。修改这些 composition 级代理设置后需重启 Host。

macOS 后端启动 `/usr/bin/caffeinate -i -w <host-pid>`，绝不请求 `-d`。Windows 后端从 `SystemRoot` 启动绝对路径的 Windows PowerShell，固定 helper 只请求 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`；不请求 `ES_DISPLAY_REQUIRED`，不修改电源计划，也不需要管理员权限。Linux 后端只从 `/usr/bin/systemd-inhibit` 或 `/bin/systemd-inhibit` 启动 systemd-logind `idle` block inhibitor，不请求 `sleep`、`handle-lid-switch` 或显示器/屏保 inhibitor；没有 systemd-logind 时显示 `unsupported` 或可见错误，不启动桌面环境专用替代命令。其他平台报告 `unsupported`。

## 数据存储与迁移

- 权威账本文件固定为 `$DSH_HOME/task-board/ledger-v2.json`（文件名为历史沿用）；当前文档 schema 为 v3，v2 文档会在下一次 Host 启动时逐字段无损迁移为 v3 并原地写回。POSIX 新文件权限为 `0600`；Windows 继承用户目录 ACL。
- v2 到 v3 迁移失败（任务行结构非法）时失败关闭并报出明确错误，原文件保持不动；绝不静默以空账本重启。损坏或未知 schema 的文件会移动到防碰撞的 `ledger-v2.json.corrupt-*` 名称，Host 以空账本和可见 scheduler 错误启动，不覆盖损坏字节。
- 每个 origin 首次加载新版页面时，按稳定 source id 和 request id 导入 `dsh.taskBoard.v1`。任务按 id 合并，浏览器端严格较新的顶层字段优先，时间戳相同时保留 Host 字段，执行记录按 execution id 合并。
- 最近 256 个 request id 与动作的 SHA-256 指纹会随账本持久化，因此 Host 重启后的变更重试仍保持幂等，且不会复制完整动作载荷。
- 任务标签是任务行上的可选 `tags` 字段（`{ name, promptPrefix? }[]`），无需 bump schema：不含该字段的 v3 文档原样加载，非法的标签列表逐条修复（丢弃空名、重复项与超长名，并封顶数量），而不是丢掉整行任务。
- 只有导入成功并经 Host 确认后，`dsh.taskBoard.v2.hostImported` 才保存当前 Host 账本 generation；新建或损坏恢复出的新 generation 会再次接收保留的 v1 数据。v1 localStorage 原值保持不变，作为只读回退备份。
- 同一时间只有一个 Host 进程能通过 `$DSH_HOME/task-board/ledger-v2.lock` 持有任务看板账本目录；第二个使用同一 DSH home 的 Host 会失败关闭，不并发写账本。

## 安全模型

- 插件仍处在 DSH Web 既有部署与网络边界内，不返回宽松 CORS 头。state、action 与 SSE 共用同一访问栅栏；裸本地命令行请求不会被当作浏览器请求接受。
- 所有变更载荷使用严格、版本化的判别联合；浏览器不能写入 scheduler 独占时间戳或 execution 结果。
- 工作区、预设、权限、cron、任务状态和导入记录都会在 Host 再校验。
- 卡片有效权限高于配置的会话默认值时进入待确认状态：人工确认该确切绑定之前，Host 拒绝手动执行与 cron 触发；变更钉住权限或交接包会清除确认（封死先确认后替换的提权路径）。
- 任务 Prompt 是发给 DSH agent 会话的数据。协议不接受 shell 命令、PowerShell 正文、可执行路径或可配置 helper 参数。
- 任务标签与 Prompt 同属客户端断言，并走同一条受门禁的动作通道：协议层拒绝空标签名、未知键、超过八个标签以及超长的标签名或执行提示。标签的执行提示会做分隔符转义（无法伪造续接卡片的来源声明标记），且注入位置在该来源声明包裹之外。
- 电源 helper 使用固定可执行路径、固定参数、`shell: false`，失败后按 1、2、5、10、30 秒有界退避。Linux helper 通过 Host stdin 生命周期退出，使 systemd inhibitor 随 Host 异常退出自动释放。

## 构建与测试

需要 Node 20 或更高版本及官方 NPM SDK 包；不使用 DSH 源码 checkout。

```sh
pnpm typecheck
pnpm test
pnpm build
```

设置 `DSH_POWER_SMOKE=1` 可在 Windows、macOS 或 Linux 上显式启用原生 helper smoke：真实启动固定 helper、等待 ready、在清理路径释放并确认进程退出，不修改系统电源计划。Linux 会先以有界超时探测 systemd-logind；没有可用 system bus 时原生部分跳过，纯逻辑测试仍可运行。

## 手工验证

1. 挂载插件并重启 `dsh web`，打开任务看板，确认 Host 时区和电源状态可见。
2. 新建并编辑任务；刷新或打开第二个同源标签页，确认两者显示同一 Host revision。
3. 执行一个钉住工作区、预设和权限的任务；确认出现新会话，且只有当该会话结束（turn 已结束、收件箱无排队、没有仍在运行的后台 job）后卡片才进入 **Ready for test**。
4. 启用一个即将到期的 cron，关闭全部浏览器页面，确认 Host 仍只创建并结算一次 execution。
5. 让 Host 停止并错过一个 cron 触发点，重启后确认该次被跳过，`nextRunAt` 从当前 Host 时间向后滚动。
6. 开启 `preventIdleSleep` 并运行长任务，让显示器自动熄灭；恢复显示后确认会话继续且 execution 已结算。
7. 对同一工作区同时触发三个运行，确认 Host 默认（WIP 上限 1）按到达顺序逐个启动；把其中一个钉到另一个工作区，确认它与该工作区并行启动。把 `maxConcurrentRuns` 调到 2 后确认同一工作区可同时启动两个。
8. 关闭设置并禁用所有计划，再停止 DSH，确认 helper 退出；macOS 可用 `pmset -g assertions` 辅助确认插件没有 display-sleep assertion。
9. Linux 可用 `systemd-inhibit --list` 确认只存在 `idle`/`block` 条目；显示器仍按桌面设置关闭，手动睡眠和合盖仍由系统策略处理。
10. 启动一个任务，再把同一工作区的第二个任务拖到 running 列：运行中的卡片应带加粗警告色边框、警告色底与 “Running now” 徽标并排在列顶，等待中的卡片保持细边框、在下方标记 “Queued”。
11. 普通点击标记一张卡片，Ctrl 点击再标记第二张（Shift 点击可选中区间；焦点卡片上按空格同样标记，按 Enter 或双击打开详情），把其中一张拖到另一列：两张一起移动，拖拽过程中计数器显示张数，顶栏芯片显示当前选择，移动完成后选择为空。再 Ctrl 点击第三张卡片并按芯片上的清除按钮——选择被清空；拖一张未标记的卡片，确认它仍然只移动自己。

## 已知限制

- Host 停止、系统睡眠或长暂停期间错过的触发点会跳过，绝不排队补跑。
- 同一任务已在运行时会跳过到期出现并滚动到下一 cron 匹配点；同一任务的两个出现绝不重叠。同一工作区的不同任务会在 WIP 上限处排队（本分支新增）；其他工作区的运行不受影响。
- DST 采用 Host 本地墙上时钟语义：春季跳时中不存在的分钟会跳过，秋季回拨中重复的分钟不会执行第二次。
- 电源保护只阻止空闲系统睡眠，明确允许显示器睡眠与锁屏。
- 合盖、手动睡眠、休眠、关机、低电量强制睡眠和企业电源策略不在保证范围内。
- 插件不创建唤醒定时器，也不能唤醒已经睡眠的机器。
- Linux 需要 systemd-logind 及允许当前用户取得 idle block lock 的策略；容器、WSL、无 system bus 或非 systemd 系统可能显示 `unsupported` 或 `error`。桌面环境是否把 logind idle lock 与显示器空闲联动属于其自身策略，插件不请求屏保或显示器 inhibitor。
- 已启用计划会从未来触发点之前持续持锁，因此可能增加电池消耗。
- 在 WIP 队列中等待的运行（本分支新增）尚无 session；若 Host 在其启动前重启，该 execution 结算为 `cancelled`，任务需要重新启动。
- 多选（本分支新增）是把卡片移**进某一列**，而不是移到某个位置：不支持拖到两张卡片*之间*，被移动的卡片按原有相对顺序落在目标列中。
- Host 执行消耗与普通 DSH agent 会话相同的 API 额度。

## 数据遥测

**本分支不发送任何遥测。** 上游 0.3.23 的浏览器半区每个 UTC 日向 `dsh-market.com` 发送一次匿名安装心跳（仅含一个 localStorage 随机 ID 与本包名）。本分支移除了该调用，看板不再发出遥测请求。`src/client/telemetry.ts` 仍留在仓库里以备自建端点，但客户端入口不再引用它；被移除的算法见上游 `docs/telemetry.md`（不属于本仓库）。
