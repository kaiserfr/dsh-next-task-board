/**
 * Review setups (the declarative half): the settings document, the longest-prefix
 * match onto a card's directory, and the URL/port derivation the panel renders.
 * These are the rules the settings card validates with and the Host executes, so
 * they are pinned here once.
 */
import { describe, expect, it } from 'vitest'
import {
  findReviewEnvironment,
  hasCommands,
  isBelow,
  parseReviewEnvironments,
  type ReviewEnvironmentConfig,
} from '../src/core/review-config.ts'
import { publishedPorts, resolveReviewUrl, reviewLinks } from '../src/review-workflow.ts'

const JOBMINER = '/home/frank/develop/workspaces/jobminer'

function environment(overrides: Partial<ReviewEnvironmentConfig> = {}): ReviewEnvironmentConfig {
  return { path: JOBMINER, start: './start.sh', ...overrides }
}

describe('parseReviewEnvironments', () => {
  it('accepts an empty setting and a parsed array alike', () => {
    expect(parseReviewEnvironments('')).toEqual({ environments: [], errors: [] })
    expect(parseReviewEnvironments(undefined)).toEqual({ environments: [], errors: [] })
    const parsed = parseReviewEnvironments([{ path: JOBMINER, start: './start.sh', stop: './start.sh --stop' }])
    expect(parsed.errors).toEqual([])
    expect(parsed.environments).toHaveLength(1)
    expect(parsed.environments[0]).toMatchObject({ path: JOBMINER, start: './start.sh', stop: './start.sh --stop' })
  })

  it('keeps the valid entries and reports the broken one', () => {
    const { environments, errors } = parseReviewEnvironments(JSON.stringify([
      { path: JOBMINER, start: './start.sh', env: 'PORT={port}', url: 'http://127.0.0.1:{port}' },
      { path: 'relative/path', start: './start.sh' },
      { path: '/tmp/x', start: '   ' },
      { path: '/tmp/y' },
      { path: '/tmp/z', start: './start.sh', star: './typo' },
    ]))
    expect(environments.map(entry => entry.path)).toEqual([JOBMINER])
    expect(errors).toHaveLength(4)
    expect(errors[0]).toContain('absolute directory')
    expect(errors[1]).toContain('"start" must be a non-empty string')
    expect(errors[2]).toContain('needs at least one of')
    expect(errors[3]).toContain('unknown field')
  })

  it('refuses a duplicate path and a document that is not JSON', () => {
    const duplicate = parseReviewEnvironments(`[{"path":"${JOBMINER}","start":"a"},{"path":"${JOBMINER}/","start":"b"}]`)
    expect(duplicate.environments).toHaveLength(1)
    expect(duplicate.errors[0]).toContain('duplicate')
    expect(parseReviewEnvironments('{oops').errors[0]).toContain('not valid JSON')
    expect(parseReviewEnvironments('{"path":"/"}\n').errors[0]).toContain('must be a JSON array')
  })

  it('accepts relative SQLite data files and normalizes their separators', () => {
    const { environments, errors } = parseReviewEnvironments([
      {
        path: JOBMINER,
        start: './start.sh',
        data: ['data/jobminer.db', './data/other.sqlite', 'data\\windows.db3', 'data/jobminer.db'],
      },
    ])
    expect(errors).toEqual([])
    expect(environments[0]?.data).toEqual(['data/jobminer.db', 'data/other.sqlite', 'data/windows.db3'])
    // An empty list means "no data configured", not an empty field.
    const empty = parseReviewEnvironments([{ path: JOBMINER, start: './start.sh', data: [] }])
    expect(empty.errors).toEqual([])
    expect(empty.environments[0]?.data).toBeUndefined()
  })

  it('refuses unsafe or non-SQLite data entries as a whole entry', () => {
    const { environments, errors } = parseReviewEnvironments([
      { path: JOBMINER, start: './start.sh', data: ['data/app.db'] },
      { path: '/tmp/data-not-array', start: './start.sh', data: 'data/app.db' },
      { path: '/tmp/data-absolute', start: './start.sh', data: ['/etc/app.db'] },
      { path: '/tmp/data-outside', start: './start.sh', data: ['../app.db'] },
      { path: '/tmp/data-text', start: './start.sh', data: ['data/app.txt'] },
      { path: '/tmp/data-git', start: './start.sh', data: ['data/.git/app.db'] },
      { path: '/tmp/data-directory', start: './start.sh', data: ['data/'] },
    ])
    expect(environments.map(entry => entry.path)).toEqual([JOBMINER])
    expect(errors).toHaveLength(6)
    expect(errors[0]).toContain('"data" must be an array')
    expect(errors[1]).toContain('must be relative')
    expect(errors[2]).toContain('must not leave the repository root')
    expect(errors[3]).toContain('must be a SQLite file')
    expect(errors[4]).toContain('must not point into .git')
    expect(errors[5]).toContain('must name a file, not a directory')
  })
})

describe('findReviewEnvironment', () => {
  it('matches the directory itself and a directory below it, longest path first', () => {
    const outer = environment({ path: '/home/frank/develop/workspaces', start: 'outer' })
    const inner = environment({ path: JOBMINER, start: 'inner' })
    expect(findReviewEnvironment([outer, inner], `${JOBMINER}/jobsuche`)?.start).toBe('inner')
    expect(findReviewEnvironment([outer, inner], '/home/frank/develop/workspaces/career-advisor')?.start).toBe('outer')
    expect(findReviewEnvironment([outer, inner], '/home/frank/develop/elsewhere')).toBeUndefined()
  })

  it('does not match a sibling that merely shares the prefix', () => {
    expect(findReviewEnvironment([environment()], `${JOBMINER}-old`)).toBeUndefined()
    expect(findReviewEnvironment([environment()], `${JOBMINER}/`)).toBeDefined()
    expect(isBelow(`${JOBMINER}/app`, JOBMINER)).toBe(true)
    expect(isBelow(`${JOBMINER}-old`, JOBMINER)).toBe(false)
  })

  it('needs a start command to offer the container controls', () => {
    expect(hasCommands(environment())).toBe(true)
    expect(hasCommands(environment({ start: undefined, stop: './start.sh --stop' }))).toBe(false)
    expect(hasCommands(undefined)).toBe(false)
  })
})

describe('review links', () => {
  it('resolves the template from the assigned ports and the card id', () => {
    expect(resolveReviewUrl('http://127.0.0.1:{port}', { DSH_COMPOSE_PORT: '8107' })).toBe('http://127.0.0.1:8107')
    expect(resolveReviewUrl('http://127.0.0.1:{port2}/{task}', { DSH_COMPOSE_PORT2: '8108' }, 'card-1')).toBe('http://127.0.0.1:8108/card-1')
    // An unresolved placeholder or a non-URL is no link at all.
    expect(resolveReviewUrl('http://127.0.0.1:{port}', {})).toBeUndefined()
    expect(resolveReviewUrl('file:///{port}', { DSH_COMPOSE_PORT: '8107' })).toBeUndefined()
  })

  it('adds one link per published compose port and de-duplicates', () => {
    expect(publishedPorts(['web 8100->80/tcp', 'db 5432->5432/udp', 'web 8101->81/tcp'])).toEqual([8100, 8101])
    const links = reviewLinks('http://127.0.0.1:{port}', { DSH_COMPOSE_PORT: '8100' }, [8100, 8101])
    expect(links).toEqual(['http://127.0.0.1:8100', 'http://127.0.0.1:8101'])
    expect(reviewLinks('http://127.0.0.1:{port}', {}, [])).toEqual([])
  })
})
