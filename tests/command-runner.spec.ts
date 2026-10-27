/**
 * The command runner: one child-process surface for git, docker and the review
 * commands. What matters here is that a card's cancellation really kills the
 * child (instead of waiting for the command's timeout) and that the deadline
 * stays the runner's safety net.
 */
import { describe, expect, it } from 'vitest'
import { LocalCommandRunner } from '../src/command-runner.ts'

const node = process.execPath

describe('LocalCommandRunner', () => {
  it('runs one command and captures its output', async () => {
    const runner = new LocalCommandRunner()
    try {
      const result = await runner.run({ command: node, args: ['-e', 'process.stdout.write("hi")'], cwd: process.cwd(), timeoutMs: 5_000 })
      expect(result).toMatchObject({ code: 0, stdout: 'hi', timedOut: false, aborted: false })
    } finally {
      runner.dispose()
    }
  })

  it('kills every command of a cancelled card scope', async () => {
    const runner = new LocalCommandRunner()
    try {
      const running = runner.run({ command: node, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: process.cwd(), timeoutMs: 60_000, scope: 'card-a' })
      const other = runner.run({ command: node, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: process.cwd(), timeoutMs: 60_000, scope: 'card-b' })
      await new Promise(resolve => { setTimeout(resolve, 150) })
      expect(runner.busyScopes().sort()).toEqual(['card-a', 'card-b'])
      expect(runner.cancelScope('card-a')).toBe(1)
      const aborted = await running
      expect(aborted.aborted).toBe(true)
      expect(runner.cancelScope('card-b')).toBe(1)
      expect((await other).aborted).toBe(true)
    } finally {
      runner.dispose()
    }
  })

  it('kills a command at its deadline and reports the timeout', async () => {
    const runner = new LocalCommandRunner()
    try {
      const result = await runner.run({ command: node, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: process.cwd(), timeoutMs: 120 })
      expect(result.timedOut).toBe(true)
      expect(result.code).not.toBe(0)
    } finally {
      runner.dispose()
    }
  })
})
