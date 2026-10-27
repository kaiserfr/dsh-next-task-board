/**
 * SQLite data provisioning for a worktree review: a consistent snapshot from
 * the human's main checkout, read-only on the source, overwriting the worktree
 * copy on every start and failing loudly when the source is unusable.
 *
 * The tests use Node's built-in SQLite module (the same one the Host uses), so
 * they exercise the real backup API rather than a mock.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { seedReviewData } from '../src/review-data.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function createDb(path: string, rows: readonly string[]): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO items (name) VALUES (?)')
  for (const row of rows) insert.run(row)
  db.close()
}

function rows(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT name FROM items ORDER BY id').all().map(row => String((row as { name: unknown }).name))
  } finally {
    db.close()
  }
}

function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('seedReviewData', () => {
  it('snapshots a live WAL database without touching the original', async () => {
    const sourceRoot = tempDir('review-source-')
    const targetRoot = tempDir('review-target-')
    mkdirSync(join(sourceRoot, 'data'))
    mkdirSync(join(targetRoot, 'data'))
    const source = join(sourceRoot, 'data/app.db')

    // Keep the writer open: the last rows live in the WAL, not in the main file,
    // which is exactly the situation of a human instance running next to the board.
    const writer = new DatabaseSync(source)
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    writer.exec("INSERT INTO items (name) VALUES ('one'), ('two'), ('three')")
    writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.exec("INSERT INTO items (name) VALUES ('four'), ('five')")
    const before = hashOf(source)
    const beforeRows = rows(source)

    await seedReviewData({ sourceRoot, targetRoot, files: ['data/app.db'] })

    const target = join(targetRoot, 'data/app.db')
    expect(rows(target)).toEqual(beforeRows)
    expect(rows(source)).toEqual(beforeRows)
    // The source is opened read-only: its main file must be byte-identical.
    expect(hashOf(source)).toBe(before)
    writer.close()
  })

  it('overwrites the worktree copy and drops stale SQLite sidecars', async () => {
    const sourceRoot = tempDir('review-source-')
    const targetRoot = tempDir('review-target-')
    mkdirSync(join(sourceRoot, 'data'))
    mkdirSync(join(targetRoot, 'data'))
    const source = join(sourceRoot, 'data/app.db')
    const target = join(targetRoot, 'data/app.db')
    createDb(source, ['main'])
    createDb(target, ['old', 'copy'])
    // A stale WAL from an older copy must not be replayed into the fresh database.
    writeFileSync(`${target}-wal`, 'stale wal')
    writeFileSync(`${target}-shm`, 'stale shm')

    await seedReviewData({ sourceRoot, targetRoot, files: ['data/app.db'] })
    expect(rows(target)).toEqual(['main'])
    expect(existsSync(`${target}-wal`)).toBe(false)
    expect(existsSync(`${target}-shm`)).toBe(false)

    // The next start overwrites again (never accumulates the review's own writes).
    const db = new DatabaseSync(target)
    db.exec("DELETE FROM items; INSERT INTO items (name) VALUES ('review-write')")
    db.close()
    await seedReviewData({ sourceRoot, targetRoot, files: ['data/app.db'] })
    expect(rows(target)).toEqual(['main'])
  })

  it('fails closed when the source is missing or a symlink', async () => {
    const sourceRoot = tempDir('review-source-')
    const targetRoot = tempDir('review-target-')
    mkdirSync(join(sourceRoot, 'data'))
    mkdirSync(join(targetRoot, 'data'))

    await expect(seedReviewData({ sourceRoot, targetRoot, files: ['data/missing.db'] }))
      .rejects.toThrow(/review data .*missing\.db.*is missing/)
    expect(existsSync(join(targetRoot, 'data/missing.db'))).toBe(false)

    createDb(join(sourceRoot, 'data/real.db'), ['main'])
    symlinkSync(join(sourceRoot, 'data/real.db'), join(sourceRoot, 'data/link.db'))
    await expect(seedReviewData({ sourceRoot, targetRoot, files: ['data/link.db'] }))
      .rejects.toThrow(/is a symlink/)
  })

  it('refuses paths that are not relative SQLite files', async () => {
    const sourceRoot = tempDir('review-source-')
    const targetRoot = tempDir('review-target-')
    await expect(seedReviewData({ sourceRoot, targetRoot, files: ['data/notes.txt'] }))
      .rejects.toThrow(/must be a SQLite file/)
    await expect(seedReviewData({ sourceRoot, targetRoot, files: ['../outside.db'] }))
      .rejects.toThrow(/must not leave the repository root/)
    await expect(seedReviewData({ sourceRoot, targetRoot, files: ['/tmp/outside.db'] }))
      .rejects.toThrow(/must be relative/)
  })
})
