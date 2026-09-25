#!/usr/bin/env node
/**
 * Regenerate the task-board state-machine diagram (docs/state-machine.md) from
 * the machine definition. Run after touching `DEFAULT_STATE_MACHINE`:
 *
 *   node scripts/render-state-machine.mjs
 *
 * Node's built-in TypeScript support loads the source directly, so no build is
 * needed. `tests/state-machine.spec.ts` asserts the checked-in diagram matches
 * the definition, so a forgotten run fails the suite.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_STATE_MACHINE, renderStateMachineMermaid, StateMachine } from '../src/core/state-machine.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'docs/state-machine.md')
const diagram = renderStateMachineMermaid(new StateMachine(DEFAULT_STATE_MACHINE))
const current = readFileSync(target, 'utf8')
const block = new RegExp('(```mermaid\\n)[\\s\\S]*?(\\n```)')
if (!block.test(current)) throw new Error(`no mermaid block in ${target}`)
const next = current.replace(block, `$1${diagram}$2`)
if (next === current) {
  console.log('state-machine.md already up to date')
} else {
  writeFileSync(target, next)
  console.log('state-machine.md updated')
}
