/**
 * `repoSubpath`: the setting that points a workspace at the repository inside it.
 * Pure parsing/matching rules — the browser's settings card runs exactly these,
 * so a typo is reported where it is typed and never reaches the Host half-done.
 */
import { describe, expect, it } from 'vitest'
import { findRepoSubpath, normalizedRepoPath, parseRepoSubpaths, resolveRepoDirectory } from '../src/core/repo-config.ts'

describe('parseRepoSubpaths', () => {
  it('parses a JSON document into entries', () => {
    const parsed = parseRepoSubpaths('[{"path":"/home/me/proj/","repo":"app"}]')
    expect(parsed.errors).toEqual([])
    expect(parsed.entries).toEqual([{ path: '/home/me/proj', repo: 'app' }])
  })

  it('accepts an already parsed value and an empty setting', () => {
    expect(parseRepoSubpaths([{ path: '/home/me/proj', repo: 'app' }]).entries).toHaveLength(1)
    expect(parseRepoSubpaths('')).toEqual({ entries: [], errors: [] })
    expect(parseRepoSubpaths(undefined)).toEqual({ entries: [], errors: [] })
  })

  it('reports every malformed entry with its reason and keeps the rest', () => {
    const parsed = parseRepoSubpaths(JSON.stringify([
      { path: 'relative/proj', repo: 'app' },
      { path: '/home/me/proj', repo: '' },
      { path: '/home/me/other', repo: 'app', extra: 1 },
      { path: '/home/me/good', repo: 'app' },
      { path: '/home/me/good/', repo: 'app' },
    ]))
    expect(parsed.entries).toEqual([{ path: '/home/me/good', repo: 'app' }])
    expect(parsed.errors).toHaveLength(4)
    expect(parsed.errors[0]).toMatch(/absolute/)
    expect(parsed.errors[1]).toMatch(/"repo"/)
    expect(parsed.errors[2]).toMatch(/unknown field/)
    expect(parsed.errors[3]).toMatch(/duplicate/)
  })

  it('rejects a document that is not an array or not JSON at all', () => {
    expect(parseRepoSubpaths('{"path":"/x","repo":"y"}').errors[0]).toMatch(/must be a JSON array/)
    expect(parseRepoSubpaths('{oops').errors[0]).toMatch(/not valid JSON/)
  })
})

describe('resolveRepoDirectory', () => {
  it('joins a relative repository onto the workspace path', () => {
    expect(resolveRepoDirectory({ path: '/home/me/proj', repo: 'dsh-next-task-board' }))
      .toBe('/home/me/proj/dsh-next-task-board')
    expect(resolveRepoDirectory({ path: '/home/me/proj', repo: './app/' })).toBe('/home/me/proj/app')
    expect(resolveRepoDirectory({ path: '/', repo: 'app' })).toBe('/app')
  })

  it('takes an absolute repository as it is', () => {
    expect(resolveRepoDirectory({ path: '/home/me/proj', repo: '/srv/repo/' })).toBe('/srv/repo')
    expect(normalizedRepoPath('/')).toBe('/')
  })
})

describe('findRepoSubpath', () => {
  it('matches the workspace itself or a parent, longest path wins', () => {
    const entries = [
      { path: '/home/me', repo: 'outer' },
      { path: '/home/me/proj', repo: 'inner' },
    ]
    expect(findRepoSubpath(entries, '/home/me/proj')?.repo).toBe('inner')
    expect(findRepoSubpath(entries, '/home/me/proj/deeper')?.repo).toBe('inner')
    expect(findRepoSubpath(entries, '/home/me/other')?.repo).toBe('outer')
    expect(findRepoSubpath(entries, '/home/other')).toBeUndefined()
  })

  it('does not match a sibling that merely shares the prefix', () => {
    const entries = [{ path: '/home/me/proj', repo: 'app' }]
    expect(findRepoSubpath(entries, '/home/me/project')).toBeUndefined()
  })
})
