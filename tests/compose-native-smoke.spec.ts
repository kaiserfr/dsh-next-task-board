/**
 * Native Docker Compose smoke: drives the real `docker` binary against a real
 * daemon, which is why it is opt-in (`DSH_COMPOSE_SMOKE=1`) and skips itself
 * everywhere else — the unit tests cover the same argv with a stub, this one
 * proves the stack actually comes up, publishes a port and disappears again.
 *
 * Run it with:
 *
 * ```sh
 * DSH_COMPOSE_SMOKE=1 pnpm vitest run tests/compose-native-smoke.spec.ts
 * ```
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposeWorkflow, composeProject } from '../src/compose-workflow.ts'
import { createTask } from '../src/core/tasks.ts'

const enabled = process.env.DSH_COMPOSE_SMOKE === '1'
const hasDocker = spawnSync('docker', ['compose', 'version']).status === 0
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function docker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  return `${result.stdout}${result.stderr}`.trim()
}

describe.skipIf(!enabled || !hasDocker)('docker compose smoke', () => {
  it('brings a task stack up, reports its port and removes it again', async () => {
    const worktree = tempDir('dsh-task-board-smoke-')
    // The smallest stack that publishes a port: one container, a random host
    // port, an image that is normally already present.
    // A variable host port, exactly like the user's own files: the port comes
    // from the board's per-card environment, so two cards never collide.
    writeFileSync(join(worktree, 'docker-compose.yml'), [
      'services:',
      '  web:',
      '    image: alpine:3',
      '    command: ["sleep", "60"]',
      '    ports:',
      '      - "127.0.0.1:${WEB_PORT:-1}:80"',
      '',
    ].join('\n'))

    const task = {
      ...createTask({ title: 'Smoke', description: '', prompt: 'p' }, Date.now(), 'smoke-card'),
      git: { branch: 'task/smoke-smokecard', base: 'main', repoPath: worktree, worktreePath: worktree },
    }
    const project = composeProject(task)
    const workflow = new ComposeWorkflow({ env: 'WEB_PORT={port}' })

    let started = false
    try {
      const compose = await workflow.up(task)
      started = compose !== undefined
      expect(compose?.project).toBe(project)
      expect(compose?.ports ?? []).not.toEqual([])
      expect(compose?.ports?.[0]).toMatch(/^web \d+->80\/tcp$/)
      // The published host port is the one the board assigned (not the file's
      // fallback of 1).
      expect(compose?.env?.WEB_PORT).toBe(compose?.ports?.[0]?.split(' ')[1]?.split('->')[0])
      expect(compose?.ports?.[0]).not.toContain(' 1->')
      // The project is visible to anyone on the machine, named after the card.
      expect(docker(['compose', 'ls', '--format', 'json'])).toContain(project)
    } finally {
      if (started) await workflow.down(project, worktree)
    }
    // Torn down: the project is gone from `compose ls -a`.
    expect(docker(['compose', 'ls', '-a', '--format', 'json'])).not.toContain(project)
  }, 120_000)
})
