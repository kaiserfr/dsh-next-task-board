/**
 * Announcement default (issue #839): announceToAgent resolves to false so
 * agent system prompts stay clean unless the user opts in.
 */
import { describe, expect, it } from 'vitest'
import { Config, readConfigField } from '../src/index.ts'

describe('announcement default (issue #839)', () => {
  it('resolves announceToAgent to false by default', () => {
    // Schema-volatile fields are handed as live references (a plain value
    // under a programmatic mount), so they are read through the same helper
    // the host half uses.
    const value = Config({})
    expect(readConfigField(value.announceToAgent, true)).toBe(false)
    expect(readConfigField(value.enabled, false)).toBe(true)
  })

  it('keeps an explicit true override', () => {
    const value = Config({ announceToAgent: true })
    expect(readConfigField(value.announceToAgent, false)).toBe(true)
  })
})
