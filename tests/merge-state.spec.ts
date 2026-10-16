/**
 * `mergeStateOf`: the one word the board says about a card's merge. Pure, so the
 * card badge and the review block can never disagree about what the records mean.
 */
import { describe, expect, it } from 'vitest'
import { mergeStateOf } from '../src/core/merge.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

function card(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'card-1',
    title: 'Card',
    description: '',
    prompt: 'p',
    status: 'ready_for_test',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    ...overrides,
  }
}

const git = { branch: 'task/card-1', base: 'main', repoPath: '/repo' }

describe('mergeStateOf', () => {
  it('says nothing about cards that never touched the git flow', () => {
    expect(mergeStateOf(card({ status: 'backlog' }))).toBeUndefined()
    expect(mergeStateOf(card({ status: 'running' }))).toBeUndefined()
    expect(mergeStateOf(card({ status: 'failed' }))).toBeUndefined()
    // The many legacy cards in Done without a branch stay clean.
    expect(mergeStateOf(card({ status: 'done' }))).toBeUndefined()
  })

  it('names the review column\'s verdict', () => {
    expect(mergeStateOf(card({ git }))).toBe('unmerged')
    expect(mergeStateOf(card())).toBe('no-branch')
    expect(mergeStateOf(card({ status: 'done', git }))).toBe('unmerged')
  })

  it('reads the merge record over the git record', () => {
    expect(mergeStateOf(card({ git: { ...git, mergedAt: 5 } }))).toBe('merged')
    expect(mergeStateOf(card({ git, merge: { releasedAt: 9, attempts: 0, mergedAt: 5 } }))).toBe('merged')
    expect(mergeStateOf(card({ git, merge: { releasedAt: 9, attempts: 0, error: 'boom' } }))).toBe('failed')
    expect(mergeStateOf(card({ git, merge: { releasedAt: 9, attempts: 0, skipped: true } }))).toBe('no-branch')
    expect(mergeStateOf(card({ status: 'done', merge: { releasedAt: 9, attempts: 0, skipped: true } }))).toBe('no-branch')
    expect(mergeStateOf(card({ git, merge: { releasedAt: 9, attempts: 0 } }))).toBe('released')
  })

  it('reads a running card with a started resolution as resolving', () => {
    expect(mergeStateOf(card({ status: 'running', git, merge: { releasedAt: 9, attempts: 1, conflict: 'x' } }))).toBe('resolving')
    expect(mergeStateOf(card({ status: 'running', git, merge: { releasedAt: 9, attempts: 0 } }))).toBe('released')
  })
})
