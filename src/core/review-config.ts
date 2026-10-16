/**
 * Review setups of the workspaces: the declarative half of the review block,
 * framework-free and dependency-free so both halves share exactly one rule —
 * the browser's settings card validates the document the Host later executes
 * (the same convention `core/state-machine.ts` follows).
 *
 * One entry per workspace directory:
 *
 * ```json
 * [{ "path": "/home/me/proj", "env": "PORT={port}",
 *    "start": "./start.sh", "stop": "./start.sh --stop",
 *    "restart": "./start.sh --restart", "logs": "tail -n 200 data/server.log",
 *    "url": "http://127.0.0.1:{port}", "dockerContext": "default" }]
 * ```
 *
 * `path` is the repository root; a card matches the longest entry that is its
 * directory or a parent of it, so a nested repository can override the entry of
 * the workspace above it. Commands run in the card's directory — its own
 * worktree, else its main checkout — which is what makes every action
 * card-scoped rather than global.
 */
/** One workspace's review setup. */
export interface ReviewEnvironmentConfig {
  /** Absolute directory (repository root) this entry applies to, prefix match. */
  path: string
  /** Command that starts the version in the card's directory. */
  start?: string
  /** Command that stops it again; also used by the automatic cleanup. */
  stop?: string
  /** Command that restarts it; without one, stop + start is used. */
  restart?: string
  /** Command whose output the logs modal shows. */
  logs?: string
  /** URL template of the running version; `{port}`, `{port2}` … `{task}`. */
  url?: string
  /** Docker context exported as `DOCKER_CONTEXT` for the commands. */
  dockerContext?: string
  /** Extra environment, `KEY=VALUE` pairs separated by commas or newlines. */
  env?: string
}

const ENVIRONMENT_KEYS = ['path', 'start', 'stop', 'restart', 'logs', 'url', 'dockerContext', 'env'] as const
const COMMAND_KEYS = ['start', 'stop', 'restart', 'logs'] as const

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Whether a path is absolute in either spelling this Host sees: a POSIX path
 * (`/…`), a Windows drive path (`C:\…`) or a UNC path (`\\server\share`). The
 * check is spelled out instead of using `node:path` because this module is
 * shared with the browser's settings card, which must never pull in a Node
 * built-in.
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

/** One directory entry without a trailing separator (`/` stays `/`). */
export function normalizedReviewPath(value: string): string {
  const trimmedValue = value.trim()
  if (trimmedValue === '/') return trimmedValue
  return trimmedValue.replace(/[/\\]+$/, '')
}

/**
 * Whether `dir` is `prefix` itself or lives below it. Both separators are
 * accepted, so a POSIX Host and a Windows Host agree on the boundary without
 * this module importing `node:path`.
 */
export function isBelow(dir: string, prefix: string): boolean {
  if (dir === prefix) return true
  return dir.startsWith(`${prefix}/`) || dir.startsWith(`${prefix}\\`)
}

/**
 * Parse the `reviewEnvironments` setting: the JSON text, or an already parsed
 * value. Invalid entries are reported with a reason and dropped, so one typo
 * never silently disables another workspace — the settings card shows the
 * reasons and the valid entries keep working.
 */
export function parseReviewEnvironments(value: unknown): { environments: ReviewEnvironmentConfig[]; errors: string[] } {
  const errors: string[] = []
  if (value === undefined || value === null || value === '') return { environments: [], errors }
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return { environments: [], errors }
    try {
      parsed = JSON.parse(value) as unknown
    } catch (error) {
      return { environments: [], errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
    }
  }
  if (!Array.isArray(parsed)) return { environments: [], errors: ['must be a JSON array of { "path", "start", "stop", … } entries'] }
  const environments: ReviewEnvironmentConfig[] = []
  const seen = new Set<string>()
  parsed.forEach((entry, index) => {
    const label = `entry ${index + 1}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${label}: not an object`)
      return
    }
    const row = entry as Record<string, unknown>
    const unknownKeys = Object.keys(row).filter(key => !(ENVIRONMENT_KEYS as readonly string[]).includes(key))
    if (unknownKeys.length > 0) {
      errors.push(`${label}: unknown field(s) ${unknownKeys.map(key => JSON.stringify(key)).join(', ')}`)
      return
    }
    const path = trimmed(row.path)
    if (path === undefined || !isAbsolutePath(path)) {
      errors.push(`${label}: "path" must be an absolute directory`)
      return
    }
    const normalized = normalizedReviewPath(path)
    if (seen.has(normalized)) {
      errors.push(`${label}: duplicate "path" ${JSON.stringify(path)}`)
      return
    }
    const commands: Partial<Record<typeof COMMAND_KEYS[number], string>> = {}
    let malformed = false
    for (const key of COMMAND_KEYS) {
      const command = trimmed(row[key])
      if (row[key] !== undefined && command === undefined) {
        errors.push(`${label}: "${key}" must be a non-empty string`)
        malformed = true
      } else if (command !== undefined) {
        commands[key] = command
      }
    }
    if (malformed) return
    if (Object.keys(commands).length === 0) {
      errors.push(`${label} (${path}): needs at least one of "start", "stop", "restart", "logs"`)
      return
    }
    const url = trimmed(row.url)
    const dockerContext = trimmed(row.dockerContext)
    const env = trimmed(row.env)
    seen.add(normalized)
    environments.push({
      path: normalized,
      ...commands,
      ...(url === undefined ? {} : { url }),
      ...(dockerContext === undefined ? {} : { dockerContext }),
      ...(env === undefined ? {} : { env }),
    })
  })
  return { environments, errors }
}

/**
 * The workspace entry that governs `dir`: the longest configured path that is
 * `dir` itself or a parent of it. Longest wins so a nested repository overrides
 * the entry of the workspace above it.
 */
export function findReviewEnvironment(environments: readonly ReviewEnvironmentConfig[], dir: string): ReviewEnvironmentConfig | undefined {
  const target = normalizedReviewPath(dir)
  let best: ReviewEnvironmentConfig | undefined
  for (const entry of environments) {
    if (!isBelow(target, normalizedReviewPath(entry.path))) continue
    if (best === undefined || normalizedReviewPath(entry.path).length > normalizedReviewPath(best.path).length) best = entry
  }
  return best
}

/** Whether an entry can start anything at all. */
export function hasCommands(environment: ReviewEnvironmentConfig | undefined): environment is ReviewEnvironmentConfig {
  return environment?.start !== undefined
}
