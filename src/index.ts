/**
 * Host loader entry for the task-board plugin.
 *
 * The Host owns the v2 ledger, action API, cron scheduler, session runner,
 * execution reconciliation, and optional idle-sleep inhibitor. The browser is
 * a same-origin asynchronous view over that service.
 */

import type { IncomingMessage } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { TaskBoardHostService } from './host-service.ts'
import { CLARIFICATION_ADDENDUM, COMPLETION_INSTRUCTION, COMPLETION_MARKER, type GatewayPeer } from './host-runner.ts'
import { parseTaskDraft, TaskParseError } from './host-ai.ts'
import { TASK_PERMISSIONS, DEFAULT_MAX_DONE_TASKS, type TaskPermission } from './core/tasks.ts'
import { DEFAULT_COMPOSE_FILE } from './compose-workflow.ts'
import { DEFAULT_EDITOR_COMMAND } from './review-workflow.ts'
import type { StateMachineConfig } from './core/state-machine.ts'
import { DEFAULT_SESSION_PERMISSION } from './core/handover.ts'
import { makeTaskBoardRoutes } from './host-routes.ts'
import { mountOnce } from './mount-once.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Default environment variable holding the authenticated proxy token. */
export const DEFAULT_PROXY_TOKEN_ENV = 'DSH_TASK_BOARD_PROXY_TOKEN'

export const inject = ['systemPrompt', 'typertGateway', 'workspaceRegistry', 'webServer', 'agents', 'commands', 'connection']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASK_BOARD_GUIDANCE = `本机已安装 dsh-next-task-board 插件（DSH Web GUI 的任务看板，kaiserfr/dsh-next-task-board 维护的 dsh-task-board 分支）：侧边栏「任务看板」入口；列即任务状态，底下的状态机可配置（设置命名空间 task-board 的 stateMachine，JSON：states 列、transitions 允许的转移、以及转移上的 actions：git.openBranch 开 feature 分支、git.commitBranch 提交工作区改动、git.mergeBranch 合并回基线分支、run 启动执行、clarify 启动澄清运行、stamp 写时间戳）。未声明的转移一律被 Host 拒绝，拖放也只允许已声明的转移；留空用内置状态机。Host 按工作区（WIP lane）分别执行上限（设置命名空间 task-board 的 maxConcurrentRuns，默认 1）：同一工作区内串行/限流，不同工作区可并行；同一工作区超出的运行先排队、按先来后到在名额空出后启动，排队中的卡片已显示为进行中但尚无会话；澄清列里的澄清运行（clarify）与进行中的运行完全相同：走同一条启动队列，但**不受 WIP 限制**——澄清列无 WIP 名额，拖进澄清列立即启动，即使同一工作区正有卡片在实现（不会显示「排队等待」、也不占名额），也可与进行中的卡片一样暂停/继续；卡片留在澄清列，Agent 在卡片自己的会话里向你提问，你在聊天里回答，回答完直接把卡片拖到「进行中」即可，同一会话继续实现（没有单独的待办列，也没有规格放行按钮）。看板还有 Done 列上限（设置 task-board 的 maxDoneTasks，默认 9）：卡片移入已完成且超出上限时，按进入 Done 的时间自动把最旧的卡片（FIFO）归档到归档视图（不删除，可恢复），并只在必要时归档；调低上限或 Host 启动时也会立即把超出部分归档，Done 列始终不超过上限。内置状态机的列为：待规划 → 澄清 → 进行中 → 待测试 → 已失败 → 已完成；新任务落在待规划，需人工拖到澄清列（该转移开 feature 分支与卡片自己的 git worktree，并启动澄清运行）；人回答完问题后直接把卡片拖到进行中（Host 动作 run），同一会话继续实现——没有单独的待办列，也没有规格放行步骤；执行成功后卡片停在待测试，只有人工移到已完成才会结束（合并只允许合并「审阅时看到的那次提交」，之后又提交过就拒绝，需重新停靠）。审阅列另有「放行合并」（Host 动作 approve-merge，只对「待测试」列的卡片开放）：把 feature 分支合并回基线分支，成功后卡片自动进入「已完成」、卡片上显示合并状态与时间；被拒绝（worktree 脏、分支已越过验收提交、没有验收提交）或合并失败时，卡片进入「已失败」并带上原因。出现合并冲突时 Host 不会把冲突留在你的主检出：它会在卡片自己的 worktree 里把基线分支合并进 feature 分支，由卡片自己的 agent 自动解决一次（卡片显示为「进行中」，同一个会话收到合并说明），解决成功后自动合并并进入「已完成」，否则进入「已失败」。卡片上显示合并状态（未合并 / 已合并 / 正在解冲突 / 合并失败 / 无分支）；没有分支的卡片放行即直接进入「已完成」，并注明「未合并」。设置 repoSubpath（JSON，按工作区指定仓库目录）可让「工作区目录本身不是 git 仓库」的项目同样拥有分支、worktree 与合并。工作区若是本地 git 仓库：卡片有独立 worktree（会话在其中运行，人的主检出不被切换）、卡片一进入待测试就提交改动（每个运行结算都提交，含失败与取消）、移到已完成时把分支合并回基线分支并删除该 worktree。若卡片的 worktree 里有 compose 文件（设置 task-board 的 composeFile，默认 docker-compose.yml，留空关闭），Host 会在实现运行开始前用项目名 dsh-tb-<卡片 id> 把该卡自己的容器栈拉起来（docker compose up -d），把发布端口记到卡片上；卡片离开运行/审阅列、被删除或归档时用 docker compose down -v 停掉并删卷；启动失败会让这次运行失败并把 docker 输出留在卡片上。能力：多列看板管理任务；Host 权威账本；关闭浏览器后仍由 Host 执行和结算；进行中的卡片可暂停/继续（暂停停掉该运行的会话、卡片留在进行中且不再算运行中，继续时在同一会话里写入「Weitermachen (continue)」）；任务可钉住工作区、agent 预设和权限；支持 Host 本地时区的 5 段 cron，错过的触发点不补跑；可选且默认关闭的空闲系统睡眠保护允许屏幕熄灭，但不承诺拦截合盖、手动睡眠、休眠、关机或唤醒已睡眠机器。执行消耗 API 额度。用户提到「任务看板 / 看板 / 定时任务」时即指本插件，请据此协作。若你同时用 todo_write 维护会话顶部的可见计划列表，最终回复前必须再次调用 todo_write 收尾：没有剩余工作时不要保留 in_progress，已完成的最后一步要标为 completed。 Klärungs-Regel für Tasks (verbindlich): Offene Fragen werden immer zuerst geklärt, bevor mit der Implementierung begonnen wird. Der Übergang von Backlog nach Clarification ist der Klärungsschritt und funktioniert genau wie ein Zug auf „In Progress": jede Karte startet dort ihren Klärungslauf (Aktion clarify) — ein echter Lauf über dieselbe Start-Warteschlange, aber ohne die WIP-Grenze der Spur: die Clarification-Spalte ist WIP-frei, der Lauf startet also sofort, auch wenn dieselbe Spur gerade implementiert (kein Queued), mit Session-Link und Pause/Weiter wie jeder andere Lauf. Einziger Unterschied ist der Prompt: der normale Task-Prompt plus der Klärungsblock „${CLARIFICATION_ADDENDUM.join(' / ')}“. Die offenen Fragen stellst DU (der Agent) — es gibt kein Feld, in das der Nutzer Fragen einträgt: du fragst im Chat der Karte, der Nutzer antwortet dort, und du beendest deinen Turn. Die Karte bleibt in der Clarification-Spalte (das Settlen des Laufs ändert die Spalte nicht). Der Mensch zieht sie direkt nach In Progress (Aktion run) — das ist das Startsignal: der Host schließt den offenen Klärungslauf und setzt dieselbe Session mit „Bitte jetzt implementieren." fort — es wird nie eine zweite, zusätzliche Session geöffnet. Ein direktes Ziehen von Backlog nach In Progress ist nicht möglich (kein Übergang); aus der Clarification-Spalte geht es direkt. STOPPREGEL FÜR KLÄRUNGSSESSIONS (verbindlich, gilt in JEDEM Turn, nicht nur im ersten): Enthält der erste Auftrag deiner Session die erste Zeile des Klärungsblocks („${CLARIFICATION_ADDENDUM[0]}“), dann bist du in der Klärungssession einer Board-Karte (Spalte Clarification). Dort implementierst du NICHTS — auch nicht, nachdem der Nutzer eine oder alle Fragen beantwortet hat; Teil-Ergebnisse, Code oder Dateiänderungen gehören nicht in diese Session. Pro Turn gilt: Frage stellen bzw. offene Punkte klären, dann den Turn beenden; sind noch Fragen offen, stelle im nächsten Turn die nächsten und stoppe wieder; sind alle Fragen beantwortet, stoppe mit einer kurzen Zusammenfassung. Erst der ausdrückliche Auftrag „Bitte jetzt implementieren." hebt diese Regel auf. FERTIG-MELDUNG FÜR IMPLEMENTIERUNGSLAUFS (verbindlich): Arbeitest du an einer Board-Karte in der Spalte „In Arbeit" (Status running, Aktion run), dann meldest DU dein Fertigsein selbst — deine letzte Antwort endet mit einer eigenen Zeile „${COMPLETION_MARKER} <kurze Zusammenfassung>". ${COMPLETION_INSTRUCTION} Die Zeile ist deine Fertig-Meldung im Chat der Karte, NICHT der Auslöser des Spaltenwechsels: der Host transportiert die Karte erst nach „待测试" (ready_for_test), wenn deine Session beendet ist; eine noch laufende Session blockiert den Wechsel, auch wenn die Zeile schon dasteht. Beende die Arbeit deshalb wirklich, statt nur zu melden. Für den Klärungsschritt (Karte in Clarification, Aktion clarify) gilt die Meldung NICHT: dort wird nichts implementiert und nichts gemeldet, die Karte bleibt in der Clarification-Spalte, bis der Mensch sie nach In Progress zieht und damit die Implementierung freigibt. REWORK-REGEL (verbindlich): Schreibt der Nutzer im Chat einer Karte, die in „待测试" (ready_for_test) oder „已失败" (failed) steht, so ist diese Nachricht die Korrektur nach der Prüfung — es gibt kein Korrekturfeld auf der Karte. Der Host schiebt die Karte daraufhin selbst nach Clarification zurück (Stempel reworkAt/reworkCount) und startet dabei KEINEN Lauf; der nächste Lauf der Karte wird als Rework-Runde geführt, setzt dieselbe Session fort und beginnt mit einem kurzen Rework-Rahmen statt mit dem ganzen Prompt — arbeite dann die im Chat genannten Punkte ab und melde dich wieder mit der FERTIG-Zeile. Eine Karte in „待测试"/„已失败" darf außerdem direkt auf die Laufspalte gezogen werden (Übergänge ready_for_test → running und failed → running); nur der Weg von Backlog direkt nach In Progress bleibt gesperrt. MERGE-FREIGABE (verbindlich): Eine Karte in „待测试" (ready_for_test) wird über den Knopf „Freigeben (Merge)" (Host-Aktion approve-merge) oder per Zug auf „已完成" freigegeben. Der Host merged dann den Feature-Branch in den Basis-Branch und verschiebt die Karte selbst nach „已完成"; scheitert der Merge (schmutziger Worktree, Branch über den Prüf-Commit hinaus, fehlender Prüf-Commit), landet die Karte in „已失败" mit dem Grund. Bei einem Konflikt merged der Host den Basis-Branch im Worktree der Karte und lässt den Konflikt von der Karte selbst in genau einer Runde lösen; danach wird automatisch weitergemerged, sonst geht die Karte nach „已失败". Das Ergebnis steht sichtbar auf der Karte (nicht gemergt / gemergt / Konflikt / fehlgeschlagen / kein Branch); eine Karte ohne Branch wird ohne Merge nach „已完成" verschoben. Die Einstellung repoSubpath nennt je Workspace das Repository in ihm, damit auch ein Arbeitsbereich, der selbst kein Git-Repo ist, Branch, Worktree und Merge bekommt.`

/**
 * Settings namespace of the board's announcement capability — the section the
 * web settings surface edits. Spelled here rather than imported: the browser
 * half spells the same value and must not depend on a Host package.
 */
export const TASK_BOARD_SETTINGS_NAMESPACE = 'task-board' as SettingsNamespace

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /**
   * When true (default), a system-prompt section announces the board to every
   * agent. Set false to keep the board silent in prompts; agents then learn
   * about it only when the user mentions it.
   */
  announceToAgent?: Volatile<boolean>
  /** Master switch for the plugin (browser half + host announcement). */
  enabled?: Volatile<boolean>
  /** Prevent idle system sleep while sessions run or schedules are armed. */
  preventIdleSleep?: Volatile<boolean>
  /**
   * WIP limit per workspace/lane: how many task runs of the same workspace may
   * hold a session at the same time. Runs above their lane's limit wait in a
   * FIFO queue and start as soon as a slot in that lane frees up; other
   * workspaces run in parallel. `1` (default) serialises each workspace.
   */
  maxConcurrentRuns?: Volatile<number>
  /**
   * The board's state machine: columns (task states), the transitions allowed
   * between them, and the actions fired by a transition (`git.openBranch`,
   * `git.commitBranch`, `git.mergeBranch`, `run`, `clarify`, `stamp`). Absent
   * keeps the shipped
   * machine (backlog → clarification → running → ready_for_test → failed →
   * done, where `backlog → clarification` is the clarification step: every card
   * starts its run there, its prompt asks the agent's open questions and stops,
   * and a human start on to `running` continues that same session with the
   * implementation; there is no separate To do column; every way into
   * `ready_for_test` commits the card's worktree, and `ready_for_test → done`
   * merges the branch). An invalid
   * config is refused as a whole and the machine in force stays.
   * Shape: `{ initial?, states: [{ status, label?, order?, drop? }],
   * transitions: [{ from, to, trigger?, git?, actions? }] }`.
   */
  stateMachine?: Volatile<StateMachineConfig>
  /**
   * Done-column limit (N): how many on-board cards the `done` column may hold.
   * A move into `done` that would exceed the limit archives the cards that have
   * been in `done` the longest (FIFO) until it holds again; archived cards stay
   * in the ledger and remain reachable through the board's archive view. The
   * limit applies to the `done` column only.
   */
  maxDoneTasks?: Volatile<number>
  /**
   * Compose file a card's task environment is brought up from, relative to the
   * card's worktree. Absent uses `docker-compose.yml` (with `compose.yaml` and
   * `docker-compose.yaml` as fallbacks); an empty value turns task containers
   * off. The project name is derived from the card id, so every card gets its
   * own stack, its own volumes and — as reported back from compose — its own
   * published ports.
   */
  composeFile?: Volatile<string>
  /**
   * Environment handed to every card's stack, as `KEY=VALUE` pairs (commas or
   * newlines). `{port}` is replaced by a free host port assigned to the card and
   * kept for it, `{task}` by its id — the way a compose file that publishes a
   * fixed port (`${PORT:-8092}`) gets one port per card instead of colliding
   * with the stack the human runs themselves. Example: `PORT={port}`.
   */
  composeEnv?: Volatile<string>
  /**
   * Review setups per workspace, as a JSON array. A card in `ready for test`
   * shows the controls of the entry whose `path` is the card's directory or a
   * parent of it (longest match wins):
   *
   * ```json
   * [{ "path": "/home/me/proj", "env": "PORT={port}",
   *    "start": "./start.sh", "stop": "./start.sh --stop",
   *    "logs": "tail -n 200 data/server.log",
   *    "url": "http://127.0.0.1:{port}", "dockerContext": "default" }]
   * ```
   *
   * `{port}`, `{port2}` … become free host ports assigned to the card and kept
   * for it, `{task}` is its id. The commands run in the card's directory (its
   * worktree, else its main checkout) with the configured `env` and
   * `DOCKER_CONTEXT`; a compose file in that directory wins over the configured
   * commands. Leaving the review column stops the version again through the
   * configured `stop` — but only one the board itself started.
   */
  reviewEnvironments?: Volatile<string>
  /**
   * Repository directory per workspace, as a JSON array — for workspaces that are
   * container folders rather than repositories themselves:
   *
   * ```json
   * [{ "path": "/home/me/proj", "repo": "app" }]
   * ```
   *
   * The card's git flow (feature branch, its own worktree, the merge back into
   * the base branch) needs the repository root; without an entry, a workspace
   * whose directory is not inside a git work tree stays out of that flow (the
   * card keeps working, just without a branch). `repo` is relative to `path` or an
   * absolute directory of its own; the longest matching `path` wins, so a nested
   * repository can override the workspace above it.
   */
  repoSubpath?: Volatile<string>
  /** Editor binary the worktree link launches (default `code`, opened with `-n`). */
  editorCommand?: Volatile<string>
  /** Canonical reverse-proxy Host authorities admitted with a server-side token. */
  trustedProxyHosts?: string[]
  /** Environment variable whose value the authenticated proxy injects upstream. */
  proxyTokenEnv?: string
  /**
   * The deployment's session-default permission. A card whose effective
   * permission (handover bundle or pin) is above this value requires a human
   * confirmation before it may run; cron refuses unconfirmed cards.
   */
  sessionDefaultPermission?: TaskPermission
}

export const Config = z.object({
  announceToAgent: z.boolean().default(false).volatile(),
  enabled: z.boolean().default(true).volatile(),
  preventIdleSleep: z.boolean().default(false).volatile(),
  maxConcurrentRuns: z.number().min(1).step(1).default(1).volatile(),
  // Loose on purpose: the machine is one JSON document the card edits as text
  // and `normalizeStateMachine` validates (with reasons) before it is applied.
  stateMachine: z.any().volatile(),
  maxDoneTasks: z.number().min(1).step(1).default(DEFAULT_MAX_DONE_TASKS).volatile(),
  composeFile: z.string().default(DEFAULT_COMPOSE_FILE).volatile(),
  composeEnv: z.string().default('').volatile(),
  // Loose like `stateMachine`: one JSON document the settings card edits as text
  // and `parseReviewEnvironments` validates entry by entry (with reasons).
  reviewEnvironments: z.string().default('').volatile(),
  // Loose like `reviewEnvironments`: one JSON document the settings card edits as
  // text and `parseRepoSubpaths` validates entry by entry (with reasons).
  repoSubpath: z.string().default('').volatile(),
  editorCommand: z.string().default(DEFAULT_EDITOR_COMMAND).volatile(),
  trustedProxyHosts: z.array(z.string()).default([]),
  proxyTokenEnv: z.string().min(1).default(DEFAULT_PROXY_TOKEN_ENV),
  sessionDefaultPermission: z.union(TASK_PERMISSIONS).default(DEFAULT_SESSION_PERMISSION),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a
     * remount; dispatched to the owning fiber only. Spelled here because the
     * Loader package is not a dependency of this plugin, with the Loader's own
     * shape so the two declarations merge when a Host program carries both.
     * @param paths - changed config paths as key arrays; every value is committed before dispatch.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/**
 * Read one config field's current value.
 *
 * The Loader hands schema-volatile fields as stable references it commits in
 * place, so a live value must be read at use time rather than captured when
 * the plugin activates; a plain value (a programmatic mount, or a field the
 * schema does not mark volatile) is returned as it stands.
 * @param field - the config field as the Loader handed it.
 * @param fallback - value to use when the field is absent.
 * @returns the effective field value.
 */
export function readConfigField<T>(field: Volatile<T> | T | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    return (field as Volatile<T>).get() as T
  }
  return field as T
}

/** Resolve proxy access without ever placing the token value in plugin config. */
export function resolveProxyAccess(config: Config | undefined, env: NodeJS.ProcessEnv = process.env): { trustedProxyHosts: string[]; proxyToken?: string } {
  const trustedProxyHosts = config?.trustedProxyHosts ?? []
  if (trustedProxyHosts.length === 0) return { trustedProxyHosts }
  const proxyTokenEnv = config?.proxyTokenEnv ?? DEFAULT_PROXY_TOKEN_ENV
  if (proxyTokenEnv.trim() === '') throw new Error('task-board: proxyTokenEnv must not be empty')
  const proxyToken = env[proxyTokenEnv]
  if (proxyToken === undefined || proxyToken === '') {
    throw new Error(`task-board: trustedProxyHosts requires a non-empty ${proxyTokenEnv} environment variable`)
  }
  return { trustedProxyHosts, proxyToken }
}

/** Schema default, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = false

/**
 * Read the optional `llm` service. The board deliberately does not inject it:
 * a deployment without a model must still mount the board, and the parse route
 * answers a typed failure instead of the plugin failing to load (issue #1540).
 * @param ctx - the plugin context.
 * @returns the llm service, or undefined when this deployment serves none.
 */
export function resolveLlmRuntime(ctx: Context): LlmRuntime | undefined {
  try {
    const llm = ctx.get('llm') as LlmRuntime | undefined
    return llm !== undefined && typeof (llm as { stream?: unknown }).stream === 'function' ? llm : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the board's announcement section, gated on the composition entry's
 * `announceToAgent` (and the live settings value once the web settings
 * surface is served). The section is re-registered whenever the source
 * changes, so a settings edit takes effect without a restart.
 * @param ctx - the plugin context (systemPrompt injected).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('dsh-next-task-board', applyImpl)

/**
 * Operator Peer for the board's Host-side gateway calls.
 *
 * dsh 0.2.1 makes `peer` mandatory on every gateway invocation (the in-process
 * operator fallback was removed), while 0.2.0 and older ignore the field. The
 * Connection service is the only owner of an operator Peer, so the board asks it
 * once and hands the same Peer to every call; the Peer dies with the plugin.
 * @param ctx - the plugin context (connection injected).
 * @returns the operator Peer, or undefined on a runtime without `createPeer`.
 */
function operatorPeer(ctx: Context): GatewayPeer | undefined {
  const connection = ctx.get('connection') as { createPeer?: (options: { principal: { kind: 'owner' } }) => GatewayPeer } | undefined
  if (connection === undefined || typeof connection.createPeer !== 'function') return undefined
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  ctx.effect(() => () => { void peer.dispose() })
  return peer
}

/**
 * Whether the Host's own Connection service admits this request: its
 * Host/Origin fence plus a valid browser credential.
 *
 * dsh 0.2.1 refuses the wildcard bind, so a LAN-reachable profile binds one
 * concrete address and serves no loopback socket; the browser then reaches the
 * board through that address. Asking Connection keeps the board exactly as
 * strict as the rest of the dsh API instead of inventing a second rule.
 * @param ctx - the plugin context (connection injected).
 * @param request - the incoming board request.
 * @returns true only when Connection answers without a rejection.
 */
function hostCredential(ctx: Context, request: IncomingMessage): boolean {
  const connection = ctx.get('connection') as { requestRejection?: (request: IncomingMessage) => unknown } | undefined
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  return connection.requestRejection(request) === undefined
}

function applyImpl(ctx: Context, config?: Config): void {
  const host = new TaskBoardHostService(ctx.typertGateway, {
    workspaceRegistry: ctx.workspaceRegistry,
    sessionDefaultPermission: config?.sessionDefaultPermission ?? DEFAULT_SESSION_PERMISSION,
    stateMachine: config?.stateMachine,
    peer: operatorPeer(ctx),
    commandDispatcher: {
      async execute(sessionId, line, signal) {
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) throw new Error(`execution session ${sessionId} is not available`)
        return (await ctx.commands.execute(agent, line, [], signal))?.result
      },
    },
  })
  host.setConfiguration(readConfigField(config?.enabled, true), readConfigField(config?.preventIdleSleep, false))
  host.start()
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      const routes = makeTaskBoardRoutes(host, { ...resolveProxyAccess(config), hostCredential: request => hostCredential(ctx, request) }, {
        parseTask: async (request, signal) => {
          const llm = resolveLlmRuntime(ctx)
          if (llm === undefined) throw new TaskParseError('no-model', 'this deployment serves no llm service')
          return await parseTaskDraft(llm, request, signal)
        },
      })
      for (const route of routes) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers) dispose()
      host.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      host.dispose()
    }
  }, 'task-board: host ledger, scheduler, and routes')
  // Under 0.1.7 the Host serves one configuration form per profile entry from
  // the entry's own Config schema, so this plugin owns no settings namespace of
  // its own any more: the browser card edits THIS row's config, whose fields
  // the schema marks volatile. The Loader commits a volatile edit into the
  // running fiber's references in place (no remount), so every value is read at
  // use time and `sync` re-runs on the Loader's own commit event.
  const current = (): Config => config ?? {}
  let disposeSection: (() => void) | undefined

  // Register (or drop) the announcement to match the current config. The
  // section is kept under one disposer: re-registering first tears the old
  // one down so a duplicate-name registration never throws.
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const live = current()
    const active = readConfigField(live.enabled, true)
    host.setConfiguration(active, readConfigField(live.preventIdleSleep, false))
    host.setMaxConcurrentRuns(readConfigField(live.maxConcurrentRuns, 1))
    host.setMaxDoneTasks(readConfigField(live.maxDoneTasks, DEFAULT_MAX_DONE_TASKS))
    host.setComposeFile(readConfigField(live.composeFile, DEFAULT_COMPOSE_FILE))
    host.setComposeEnv(readConfigField(live.composeEnv, ''))
    // An invalid document keeps the entries that parsed; the card surfaces the
    // refusals as the field's error text, like the state machine does.
    host.setReviewEnvironments(readConfigField(live.reviewEnvironments, ''))
    // A workspace whose directory is not a repository reaches its repository
    // through this mapping; invalid entries keep the ones that parsed.
    host.setRepoSubpaths(readConfigField(live.repoSubpath, ''))
    host.setEditorCommand(readConfigField(live.editorCommand, DEFAULT_EDITOR_COMMAND))
    // An invalid machine keeps the one in force; the ledger reports the
    // refusals, which the settings card surfaces as the field's error text.
    host.setStateMachine(readConfigField(live.stateMachine, undefined))
    if (!active) return
    if (readConfigField(live.announceToAgent, DEFAULT_ANNOUNCE) === false) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:task-board',
      order: SECTION_ORDER,
      text: TASK_BOARD_GUIDANCE,
    })
  }

  // The Loader's commit event is the only signal a volatile edit landed; the
  // disposer also releases the announcement section with this fiber.
  ctx.effect(() => {
    const off = ctx.on('loader/volatile-update', () => { sync() })
    return () => {
      off?.()
      if (disposeSection !== undefined) {
        disposeSection()
        disposeSection = undefined
      }
    }
  }, 'task-board: volatile config sync')

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSection never fires its hooks).
  sync()
}
