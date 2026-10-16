/**
 * Repository discovery per workspace: the setting that tells the board where the
 * git repository of a workspace lives when the workspace directory itself is not
 * one.
 *
 * A workspace is often a container directory (`/home/me/proj` holding `app/`,
 * `infra/`, docs and the board's own scratch files) while the repository — the
 * thing that has a `main` branch to merge into — is one directory inside it. The
 * git workflow needs the repository root: it cuts the card's feature branch
 * there, creates the card's worktree there, and merges back there. Without this
 * mapping, such a card simply has no git state (the historical, silent no-op).
 *
 * Framework-free and Node-builtin-free, because the browser's settings card
 * validates exactly the document the Host executes (the convention
 * `core/review-config.ts` follows).
 */

/** One workspace's repository location. */
export interface RepoSubpathConfig {
  /** Absolute workspace directory this entry applies to (prefix match). */
  path: string
  /**
   * Repository directory: relative to {@link path} (`dsh-next-task-board`,
   * `repos/app`), or an absolute directory of its own.
   */
  repo: string
}

/** Result of parsing the setting: what parsed, and why the rest did not. */
export interface ParsedRepoSubpaths {
  entries: RepoSubpathConfig[]
  errors: string[]
}

const ENTRY_KEYS = ['path', 'repo'] as const

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Whether a path is absolute in either spelling this Host sees: a POSIX path
 * (`/…`), a Windows drive path (`C:\…`) or a UNC path (`\\server\share`).
 */
export function isAbsoluteRepoPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

/** One directory without a trailing separator (`/` stays `/`). */
export function normalizedRepoPath(value: string): string {
  const trimmedValue = value.trim()
  if (trimmedValue === '/') return trimmedValue
  return trimmedValue.replace(/[/\\]+$/, '')
}

/**
 * Parse the `repoSubpath` setting: the JSON text, or an already parsed value.
 * Invalid entries are reported with a reason and dropped, so one typo never
 * disables another workspace.
 *
 * ```json
 * [{ "path": "/home/me/proj", "repo": "app" }]
 * ```
 */
export function parseRepoSubpaths(value: unknown): ParsedRepoSubpaths {
  const errors: string[] = []
  if (value === undefined || value === null || value === '') return { entries: [], errors }
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return { entries: [], errors }
    try {
      parsed = JSON.parse(value) as unknown
    } catch (error) {
      return { entries: [], errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
    }
  }
  if (!Array.isArray(parsed)) return { entries: [], errors: ['must be a JSON array of { "path", "repo" } entries'] }
  const entries: RepoSubpathConfig[] = []
  const seen = new Set<string>()
  parsed.forEach((entry, index) => {
    const label = `entry ${index + 1}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${label}: not an object`)
      return
    }
    const row = entry as Record<string, unknown>
    const unknownKeys = Object.keys(row).filter(key => !(ENTRY_KEYS as readonly string[]).includes(key))
    if (unknownKeys.length > 0) {
      errors.push(`${label}: unknown field(s) ${unknownKeys.map(key => JSON.stringify(key)).join(', ')}`)
      return
    }
    const path = trimmed(row.path)
    if (path === undefined || !isAbsoluteRepoPath(path)) {
      errors.push(`${label}: "path" must be an absolute workspace directory`)
      return
    }
    const repo = trimmed(row.repo)
    if (repo === undefined) {
      errors.push(`${label}: "repo" must be a non-empty relative or absolute directory`)
      return
    }
    const normalized = normalizedRepoPath(path)
    if (seen.has(normalized)) {
      errors.push(`${label}: duplicate "path" ${JSON.stringify(path)}`)
      return
    }
    seen.add(normalized)
    entries.push({ path: normalized, repo })
  })
  return { entries, errors }
}

/**
 * Absolute repository directory of one entry: an absolute `repo` stands for
 * itself, a relative one is appended to the workspace path. Written out instead
 * of using `node:path` so the browser can use the same function.
 */
export function resolveRepoDirectory(entry: RepoSubpathConfig): string {
  const repo = entry.repo.trim()
  if (isAbsoluteRepoPath(repo)) return normalizedRepoPath(repo)
  const relative = repo.replace(/^[.][/\\]/, '').replace(/[/\\]+$/, '')
  const workspace = normalizedRepoPath(entry.path)
  return workspace === '/' ? `/${relative}` : `${workspace}/${relative}`
}

/**
 * The entry governing one workspace directory: the longest configured path that
 * is the directory itself or a parent of it (a nested project can override the
 * workspace above it).
 */
export function findRepoSubpath(entries: readonly RepoSubpathConfig[], workspacePath: string): RepoSubpathConfig | undefined {
  const target = normalizedRepoPath(workspacePath)
  let best: RepoSubpathConfig | undefined
  for (const entry of entries) {
    const path = normalizedRepoPath(entry.path)
    if (target !== path && !target.startsWith(`${path}/`) && !target.startsWith(`${path}\\`)) continue
    if (best === undefined || normalizedRepoPath(best.path).length < path.length) best = entry
  }
  return best
}
