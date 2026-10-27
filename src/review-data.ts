/**
 * Seed a worktree review with the human's SQLite data.
 *
 * A card's own worktree is a fresh checkout: everything gitignored — most
 * importantly the application database (`data/app.db` in the usual case) — is
 * absent there, so starting the reviewed version shows an empty application.
 * The review environment can therefore name SQLite files (`data`) that are
 * snapshotted from the **main checkout** into the card's worktree before the
 * start command runs.
 *
 * The original is never modified: it is opened `readOnly` and copied through
 * SQLite's online backup API, which produces a consistent snapshot even while
 * the human's own instance is running in WAL mode. The target is replaced
 * atomically (write a temporary file next to it, remove stale `-wal`/`-shm`
 * sidecars, rename) and overwritten on every start, so a review always starts
 * from the current main-checkout data rather than from last week's copy.
 *
 * The workflow is deliberately fail-closed: a configured file that is missing or
 * cannot be snapshotted fails the start with the reason, instead of silently
 * starting the version with an empty database.
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalizeReviewDataPath } from './core/review-config.ts'

/** How long one SQLite snapshot may take before the start is failed. */
export const REVIEW_DATA_SNAPSHOT_TIMEOUT_MS = 60_000

/** Source and target of one review start's data provisioning. */
export interface SeedReviewDataOptions {
  /** The human's main checkout (read-only source). */
  sourceRoot: string
  /** The card's own worktree (destination). */
  targetRoot: string
  /** SQLite files relative to both roots, as validated by the settings parser. */
  files: readonly string[]
  /** Snapshot timeout; defaults to {@link REVIEW_DATA_SNAPSHOT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** Suffixes SQLite may leave next to a database file and that must not survive a seed. */
const SIDECARS = ['-wal', '-shm', '-journal'] as const

/**
 * Snapshot every configured SQLite file from `sourceRoot` into `targetRoot`.
 * Rejects with a human-readable reason naming the file; the caller fails the
 * review start on it. The sources are only read.
 */
export async function seedReviewData(options: SeedReviewDataOptions): Promise<void> {
  if (options.files.length === 0) return
  const timeoutMs = options.timeoutMs ?? REVIEW_DATA_SNAPSHOT_TIMEOUT_MS
  const seen = new Set<string>()
  for (const file of options.files) {
    const normalized = normalizeReviewDataPath(file)
    if ('error' in normalized) throw dataError(file, normalized.error)
    if (seen.has(normalized.path)) continue
    seen.add(normalized.path)
    await seedOne(options.sourceRoot, options.targetRoot, normalized.path, timeoutMs)
  }
}

/** Snapshot exactly one already-validated relative path. */
async function seedOne(sourceRoot: string, targetRoot: string, file: string, timeoutMs: number): Promise<void> {
  const source = resolve(sourceRoot, file)
  const target = resolve(targetRoot, file)
  if (!isStrictlyInside(sourceRoot, source)) throw dataError(file, `source ${source} leaves ${sourceRoot}`)
  if (!isStrictlyInside(targetRoot, target)) throw dataError(file, `target ${target} leaves ${targetRoot}`)

  const sourceStats = await lstat(source).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw dataError(file, `is missing in ${sourceRoot}`)
    throw dataError(file, `cannot read ${source}: ${messageOf(error)}`)
  })
  if (sourceStats.isSymbolicLink()) throw dataError(file, `is a symlink (${source}); only a regular file is read`)
  if (!sourceStats.isFile()) throw dataError(file, `is not a regular file (${source})`)

  const targetExists = await lstat(target).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw dataError(file, `cannot inspect ${target}: ${messageOf(error)}`)
  })
  if (targetExists) {
    const targetStats = await lstat(target)
    if (targetStats.isSymbolicLink()) throw dataError(file, `target ${target} is a symlink; refusing to replace it`)
    if (!targetStats.isFile()) throw dataError(file, `target ${target} is not a regular file`)
  }

  await mkdir(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)

  const sqlite = await loadSqlite()
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined
  try {
    database = new sqlite.DatabaseSync(source, { readOnly: true })
    await withTimeout(sqlite.backup(database, temporary), timeoutMs, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error instanceof Error && error.message.startsWith('review data ') ? error : dataError(file, `snapshot failed: ${messageOf(error)}`)
  } finally {
    if (database !== undefined) {
      try {
        database.close()
      } catch {
        // A backup that timed out may already have closed the handle.
      }
    }
  }

  await removeSidecars(temporary)
  try {
    // A stale WAL/SHM pair from an older copy must not be replayed into the new
    // database. Only touch the old copy once the fresh snapshot is complete.
    await removeSidecars(target)
    await rm(target, { force: true })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw dataError(file, `cannot replace ${target}: ${messageOf(error)}`)
  }
}

/**
 * Load Node's built-in SQLite module on demand: the board is importable on a
 * Node version that predates it (and must not fail at module load there), while
 * the seed itself needs the backup API.
 */
async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  try {
    return await import('node:sqlite')
  } catch (error) {
    throw new Error(
      `review data: this Host cannot snapshot SQLite (Node.js without "node:sqlite"; ${messageOf(error)})`,
    )
  }
}

/** Race the backup against a budget, so a locked database cannot hang the start. */
async function withTimeout(backup: Promise<number>, timeoutMs: number, file: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(dataError(file, `snapshot timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    await Promise.race([backup.then(() => undefined), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Delete the SQLite sidecar files of one database path (missing ones are fine). */
async function removeSidecars(path: string): Promise<void> {
  for (const suffix of SIDECARS) await rm(`${path}${suffix}`, { force: true }).catch(() => {})
}

/** Whether `candidate` is a genuine child of `root` (not the root itself, not a sibling). */
function isStrictlyInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function dataError(file: string, reason: string): Error {
  return new Error(`review data ${JSON.stringify(file)}: ${reason}`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
