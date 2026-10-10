/**
 * Multiline resize guard: every multiline field is a `<textarea class="input">`,
 * so the shared `.input` must keep the native vertical resizer and the textarea
 * must carry a visible, themed grip. Without the grip the corner handle falls
 * back to the browser's near-invisible default artwork on the input surface.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/board.module.css', import.meta.url), 'utf8')

describe('multiline field resize css', () => {
  it('keeps the native vertical resizer on the shared input class', () => {
    const inputBlock = css.match(/\.input\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(inputBlock).toContain('resize: vertical')
  })

  it('paints a themed grip on the textarea resizer only', () => {
    const gripBlock = css.match(/textarea\.input::-webkit-resizer\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(gripBlock).toContain('linear-gradient')
    expect(gripBlock).toContain('var(--dsw-alias-label-tertiary)')
  })
})
