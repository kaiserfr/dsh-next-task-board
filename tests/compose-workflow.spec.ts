/**
 * Task-scoped Docker Compose environments: which file is used, how the project
 * is named, what `up`/`down` run, how the published ports are read back and how
 * a failure surfaces. The docker binary is a stub script, so the tests assert
 * the real argv and the real working directory without needing a daemon.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposeWorkflow, DEFAULT_COMPOSE_FILE, composeDir, composeProject, parsePublishedPorts, resolveComposeEnv } from '../src/compose-workflow.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

const NOW = 1_700_000_000_000
const roots: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A stub `docker` that appends one `cwd :: argv` line per call to `log`, prints
 * `psOutput` for `ps` and exits with `upCode` for `up`.
 */
function stubDocker(options: { log: string; psOutput?: string; upCode?: number; upStderr?: string }): string {
  const bin = tempDir('dsh-task-board-bin-')
  const script = join(bin, 'docker')
  writeFileSync(script, `#!/bin/sh
echo "$PWD :: $*" >> "${options.log}"
case "$*" in
  *"ps --format json"*) printf '%s' '${(options.psOutput ?? '').replace(/'/g, "'\\''")}'; exit 0 ;;
  *"up -d"*) echo "${(options.upStderr ?? '').replace(/"/g, '\\"')}" >&2; exit ${options.upCode ?? 0} ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 })
  chmodSync(script, 0o755)
  return script
}

/** A card with a worktree (and optionally its own checkout directory). */
function card(worktree?: string): TaskRecord {
  const base = createTask({ title: 'Card', description: '', prompt: 'p' }, NOW, 'card-1')
  if (worktree === undefined) return base
  return { ...base, git: { branch: 'task/card-card1', base: 'main', repoPath: worktree, worktreePath: worktree } }
}

describe('compose naming and discovery', () => {
  it('names the project after the card id', () => {
    expect(composeProject({ id: 'abc-123-DEF' })).toBe('dsh-tb-abc123def')
    expect(composeProject({ id: '!!!' })).toBe('dsh-tb-task')
  })

  it('finds the card directory and its compose file, with the documented fallbacks', () => {
    const worktree = tempDir('dsh-task-board-wt-')
    const workflow = new ComposeWorkflow({ dockerCommand: '/bin/true' })
    // No worktree at all: nothing to run.
    expect(workflow.fileFor(card())).toBeUndefined()
    expect(composeDir(card())).toBeUndefined()
    // A worktree without any compose file is the normal case, not an error.
    expect(workflow.fileFor(card(worktree))).toBeUndefined()

    writeFileSync(join(worktree, DEFAULT_COMPOSE_FILE), 'services: {}\n')
    expect(workflow.fileFor(card(worktree))).toEqual({ dir: worktree, file: join(worktree, DEFAULT_COMPOSE_FILE) })

    // The other two names compose itself accepts are used when the configured
    // one is missing.
    rmSync(join(worktree, DEFAULT_COMPOSE_FILE))
    writeFileSync(join(worktree, 'compose.yaml'), 'services: {}\n')
    expect(workflow.fileFor(card(worktree))?.file).toBe(join(worktree, 'compose.yaml'))

    // A configured name (and an empty one) decides on its own.
    writeFileSync(join(worktree, 'stack.yml'), 'services: {}\n')
    expect(new ComposeWorkflow({ file: 'stack.yml' }).fileFor(card(worktree))?.file).toBe(join(worktree, 'stack.yml'))
    expect(new ComposeWorkflow({ file: '' }).fileFor(card(worktree))).toBeUndefined()
    expect(composeDir(card(worktree))).toBe(worktree)
  })
})

describe('compose up and down', () => {
  it('brings the card project up in its worktree and reports the published ports', async () => {
    const worktree = tempDir('dsh-task-board-wt-')
    const log = join(tempDir('dsh-task-board-log-'), 'calls.log')
    writeFileSync(join(worktree, DEFAULT_COMPOSE_FILE), 'services: {}\n')
    const psRows = [
      '{"Service":"web","Publishers":[{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"}]}',
      '{"Service":"db","Publishers":[{"PublishedPort":5432,"TargetPort":5432,"Protocol":"tcp"},{"PublishedPort":0,"TargetPort":99,"Protocol":"tcp"}]}',
    ].join('\n')
    const workflow = new ComposeWorkflow({ dockerCommand: stubDocker({ log, psOutput: psRows }) })

    const task = card(worktree)
    const compose = await workflow.up(task)
    expect(compose).toMatchObject({
      project: 'dsh-tb-card1',
      file: join(worktree, DEFAULT_COMPOSE_FILE),
      ports: ['db 5432->5432/tcp', 'web 8080->80/tcp'],
    })
    expect(compose?.startedAt).toBeTypeOf('number')

    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toBe(`${worktree} :: compose -p dsh-tb-card1 -f ${join(worktree, DEFAULT_COMPOSE_FILE)} up -d`)
    expect(calls[1]).toBe(`${worktree} :: compose -p dsh-tb-card1 ps --format json`)
  })

  it('leaves no environment behind when the card has no compose file', async () => {
    const worktree = tempDir('dsh-task-board-wt-')
    const log = join(tempDir('dsh-task-board-log-'), 'calls.log')
    const workflow = new ComposeWorkflow({ dockerCommand: stubDocker({ log }) })
    expect(await workflow.up(card(worktree))).toBeUndefined()
    expect(existsSync(log)).toBe(false)
  })

  it('fails with docker own output when the stack cannot start', async () => {
    const worktree = tempDir('dsh-task-board-wt-')
    const log = join(tempDir('dsh-task-board-log-'), 'calls.log')
    writeFileSync(join(worktree, DEFAULT_COMPOSE_FILE), 'services: {}\n')
    const workflow = new ComposeWorkflow({ dockerCommand: stubDocker({ log, upCode: 1, upStderr: 'port is already allocated' }) })
    await expect(workflow.up(card(worktree))).rejects.toThrow(/port is already allocated/)
  })

  it('tears the project down with its volumes, and only logs a refusal', async () => {
    const worktree = tempDir('dsh-task-board-wt-')
    const log = join(tempDir('dsh-task-board-log-'), 'calls.log')
    const workflow = new ComposeWorkflow({ dockerCommand: stubDocker({ log }) })
    await workflow.down('dsh-tb-card1', worktree)
    expect(readFileSync(log, 'utf8').trim()).toBe(`${worktree} :: compose -p dsh-tb-card1 down -v --remove-orphans`)

    // A directory that is gone (the worktree was removed) is not an error.
    rmSync(worktree, { recursive: true, force: true })
    await expect(workflow.down('dsh-tb-card1', worktree)).resolves.toBeUndefined()
    // A refusing docker only warns: a teardown never fails a board action.
    const failing = new ComposeWorkflow({ dockerCommand: stubDocker({ log, upCode: 1 }) })
    await expect(failing.down('dsh-tb-card1', tempDir('dsh-task-board-wt-'))).resolves.toBeUndefined()
  })
})

describe('published port parsing', () => {
  it('accepts jsonl and array output and skips unpublished ports', () => {
    const jsonl = [
      '{"Service":"web","Publishers":[{"PublishedPort":3000,"TargetPort":3000,"Protocol":"tcp"}]}',
      '{"Service":"api","Publishers":[]}',
      'not json at all',
    ].join('\n')
    expect(parsePublishedPorts(jsonl)).toEqual(['web 3000->3000/tcp'])
    expect(parsePublishedPorts('[{"Service":"web","Publishers":[{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"}]}]'))
      .toEqual(['web 8080->80/tcp'])
    // A missing protocol defaults to tcp, a zero published port is not a port.
    expect(parsePublishedPorts('{"Service":"w","Publishers":[{"PublishedPort":9000,"TargetPort":9000},{"PublishedPort":0,"TargetPort":1}]}'))
      .toEqual(['w 9000->9000/tcp'])
    expect(parsePublishedPorts('')).toEqual([])
    expect(parsePublishedPorts('warning: something')).toEqual([])
  })
})

describe('compose workflow options', () => {
  it('points at another file at runtime and disables itself with an empty one', () => {
    const worktree = tempDir('dsh-task-board-wt-')
    mkdirSync(join(worktree, 'ops'), { recursive: true })
    writeFileSync(join(worktree, 'ops', 'stack.yml'), 'services: {}\n')
    const workflow = new ComposeWorkflow({ dockerCommand: '/bin/true', file: 'docker-compose.yml' })
    expect(workflow.configuredFile).toBe('docker-compose.yml')
    expect(workflow.fileFor(card(worktree))).toBeUndefined()
    workflow.setFile('ops/stack.yml')
    expect(workflow.fileFor(card(worktree))?.file).toBe(join(worktree, 'ops', 'stack.yml'))
    workflow.setFile('')
    expect(workflow.fileFor(card(worktree))).toBeUndefined()
  })
})

describe('per-card environment and ports', () => {
  it('substitutes {task} and a free {port} into the configured variables', async () => {
    const probes: number[] = []
    const env = await resolveComposeEnv('PORT={port},LABEL=card-{task},BROKEN', { id: 'card-7' }, {
      base: 8100,
      // The first probe reports the port as taken, the second one as free.
      probe: async (port) => { probes.push(port); return probes.length > 1 },
    })
    // Two ports were probed (the first was reported as taken) and the second one
    // won; both live inside the configured range.
    expect(probes).toHaveLength(2)
    expect(probes[1]).toBe(probes[0] + 1)
    expect(probes[0]).toBeGreaterThanOrEqual(8100)
    expect(env.DSH_COMPOSE_PORT).toBe(String(probes[1]))
    expect(env.PORT).toBe(String(probes[1]))
    expect(env.LABEL).toBe('card-card-7')
    expect(env.BROKEN).toBeUndefined()
    // The same card probes the same first port: the assignment is stable.
    const again: number[] = []
    await resolveComposeEnv('PORT={port}', { id: 'card-7' }, { base: 8100, probe: async (port) => { again.push(port); return true } })
    expect(again).toEqual([probes[0]])
  })

  it('keeps the port a card already had and injects nothing without a template', async () => {
    const kept = await resolveComposeEnv('PORT={port}', { id: 'card-7' }, {
      base: 8100,
      previous: { DSH_COMPOSE_PORT: '8123', PORT: '8123' },
      probe: async () => { throw new Error('must not probe a remembered port') },
    })
    expect(kept.PORT).toBe('8123')
    expect(await resolveComposeEnv('', { id: 'card-7' })).toEqual({})
    expect(await resolveComposeEnv('   ', { id: 'card-7' })).toEqual({})
  })

  it('passes the resolved variables to docker and remembers them on the card', async () => {
    const worktree = tempDir('dsh-task-board-wt-')
    const log = join(tempDir('dsh-task-board-log-'), 'calls.log')
    writeFileSync(join(worktree, DEFAULT_COMPOSE_FILE), 'services: {}\n')
    // The stub echoes the environment it was called with, so the test can see
    // what docker would have received.
    const bin = tempDir('dsh-task-board-bin-')
    const script = join(bin, 'docker')
    writeFileSync(script, `#!/bin/sh
echo "$PWD :: $* :: PORT=$PORT TASK=$DSH_TASK_ID PROJECT=$COMPOSE_PROJECT_NAME" >> "${log}"
case "$*" in *"ps --format json"*) exit 0 ;; esac
exit 0
`, { mode: 0o755 })
    chmodSync(script, 0o755)

    const workflow = new ComposeWorkflow({ dockerCommand: script, env: 'PORT={port}', portBase: 8200 })
    const compose = await workflow.up(card(worktree))
    expect(compose?.env?.PORT).toBe(compose?.env?.DSH_COMPOSE_PORT)
    expect(Number(compose?.env?.PORT)).toBeGreaterThanOrEqual(8200)
    const call = readFileSync(log, 'utf8').trim().split('\n')[0]
    expect(call).toContain(`PORT=${compose?.env?.PORT}`)
    expect(call).toContain('TASK=card-1')
    expect(call).toContain('PROJECT=dsh-tb-card1')
  })
})
