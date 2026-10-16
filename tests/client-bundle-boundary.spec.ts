/**
 * The browser half must stay free of Node built-ins.
 *
 * The client entry is bundled into `lib/client.js` and executed by the browser;
 * a single `import … from 'node:path'` anywhere in its import graph makes the
 * bundle require a module the page cannot resolve, and the whole board half
 * disappears from the GUI (the Host half boots fine, so nothing else notices).
 * Shared rules therefore live in `src/core/` only when they are dependency-free
 * — this test walks the actual import graph instead of trusting that memory.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = resolve(fileURLToPath(new URL('../src/client/', import.meta.url)))

/** Node built-ins (both the `node:` prefix and the bare names Node still accepts). */
const BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'http2',
  'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
])

const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g

/** Resolve one relative specifier to a source file (`.ts`, `.tsx` or a directory index). */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // Try the next spelling.
    }
  }
  return undefined
}

/** Every relative module reachable from the client entries, in discovery order. */
function reachableFrom(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] as string
      if (!specifier.startsWith('.')) continue
      const resolved = resolveSpecifier(file, specifier)
      if (resolved !== undefined && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return [...seen]
}

describe('client bundle boundary', () => {
  const entries = [resolve(CLIENT_ROOT, 'index.ts'), resolve(CLIENT_ROOT, 'board-mount.tsx')]

  it('reaches the shared core modules it is supposed to use', () => {
    const graph = reachableFrom(entries)
    expect(graph.some(file => file.includes(`${'core'}/review-config.ts`))).toBe(true)
    expect(graph.some(file => file.includes(`${'core'}/state-machine.ts`))).toBe(true)
    expect(graph.length).toBeGreaterThan(10)
  })

  it('never imports a Node built-in from any module in its graph', () => {
    const offenders: string[] = []
    for (const file of reachableFrom(entries)) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
        const specifier = match[1] as string
        const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
        if (BUILTINS.has(bare)) offenders.push(`${file.replace(CLIENT_ROOT, 'src/client/')} imports ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the Host-only review workflow out of the browser half', () => {
    // `src/review-workflow.ts` spawns processes; the browser half shares only
    // the declarative half from `src/core/review-config.ts`.
    const graph = reachableFrom(entries)
    expect(graph.some(file => file.endsWith(`${'src'}/review-workflow.ts`))).toBe(false)
    expect(graph.some(file => file.endsWith(`${'src'}/compose-workflow.ts`))).toBe(false)
  })
})
