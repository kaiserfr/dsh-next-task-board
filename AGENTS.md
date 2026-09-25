# AGENTS.md — dsh-task-board

dsh Web GUI 的 Host 权威多列任务看板。任务通过真实 DSH 会话执行，浏览器只负责异步展示与提交动作。

## Host 账本、执行与调度

- 权威账本固定为 `$DSH_HOME/task-board/ledger-v2.json`（文件名为历史沿用），当前 schema 为 `{ schemaVersion: 3, revision, tasks, scheduler }`；旧 v2 文档在 Host 启动时逐字段无损迁移为 v3 写回，迁移失败必须明确报错且保留原文件（不静默清零）；写入必须保持临时文件加原子 rename、损坏文件隔离和 revision 单调递增。
- 浏览器 `dsh.taskBoard.v1` 只用于一次性导入且必须保留；导入 marker 只能在 Host 确认后写。所有生产变更走 `protocol.ts` 的严格同源 action 协议，UI 不得先写未确认状态。
- 手动与 cron 统一走 `HostExecutionRunner`。钉住的 workspace、agent preset、permission 任一失效都在任务 Prompt 前 fail closed；默认每次 execution 创建独立会话，任务开启 `reuseSession` 后可复用上一次会话——复用条件由 `core/session-reuse.ts` 唯一裁定：上一执行已结算、该 session 仍在名册中且空闲（名册未知一律不复用），复用时重新应用钉住的 permission/model 再入队 Prompt，不重命名、不新建。
- 交接包三元组在执行时覆盖普通钉住字段；有效权限高于 `sessionDefaultPermission`（默认 `read-only`）的绑定必须先经 `confirm-permission` 动作人工确认（变更即重新武装），未确认卡片手动执行拒绝、cron 跳过并滚动 `nextRunAt`。
- cron 使用 Host 本地时区和标准日期/星期 OR 语义。Host 首启或长暂停后的过期出现全部跳过；同任务 running 时不排队、不并发，只滚动下一触发点。
- 重启恢复时，有 session id 的 running execution 继续观察；无 session id 的启动中断标为 cancelled，禁止自动重发。

## 状态机（State Engine）

- 看板的列就是任务状态。`src/core/state-machine.ts` 是唯一权威：`DEFAULT_STATE_MACHINE`（`states` 列 / `transitions` 允许的状态转移 / 每个转移的 `actions`）是内置默认，设置命名空间 `task-board` 的 `stateMachine` 字段（JSON）可整体覆盖；配置无效时整份拒绝（`normalizeStateMachine` 给出原因）并继续沿用当前状态机，不得半套生效。
- 动作只有四种：`git.openBranch`、`git.mergeBranch`、`run`、`{ kind: "stamp", field }`。默认机器里两个 git 动作只挂在 `backlog → todo` 与 `ready_for_test → done` 上；`run` 挂在进入 `running` 的转移上（`backlog → running` 额外先开分支）。新增动作种类必须同时扩展 `STATE_ACTION_KINDS` 与 Host 执行侧，不允许绕过配置在账本里硬编码转移。
- Host 是执行权威：`HostTaskLedger` 的 `move` 先用机器校验（未声明的转移一律 `invalid state transition`），再按配置顺序执行动作；`create` 落在 `initial`。浏览器不得自行推断可移动性。
- 浏览器与 Host 必须用同一份机器：`TaskBoardHostService` 把已解析的机器放进快照（`protocol.ts` 的 `stateMachine`），`client/board/TaskBoard.tsx` 据此渲染列并校验拖放；快照缺失时回退内置机器。
- 改动状态机定义后必须重跑 `node scripts/render-state-machine.mjs` 更新 `docs/state-machine.md`；`tests/state-machine.spec.ts` 会因两者不一致而失败。

## 电源保护

- `preventIdleSleep` 默认 `false`。开启后，全部 DSH running session、任一已启用 cron 或未知 session 状态都构成持锁理由；仅在已确认无运行会话且无计划时释放。
- macOS 只允许 `/usr/bin/caffeinate -i -w <pid>`；Windows 只允许从 `SystemRoot` 解析的 Windows PowerShell 固定 helper 和 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`。Linux 只允许绝对路径 `systemd-inhibit` 的 `idle`/`block` lock，不得请求 `sleep`、显示器或 lid-switch inhibitor。
- helper 必须 `shell: false`、固定参数、不依赖 PATH、失败有界退避，并在设置关闭、插件卸载和 Host 退出时清理；不得修改电源计划或要求管理员权限。无 systemd-logind 的 Linux 和其他平台只报 `unsupported` 或可见错误。

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
