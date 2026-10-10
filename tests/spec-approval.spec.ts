/**
 * Specification release gate: a card is implemented only after a human released
 * its specification (`approve-spec` → `specApprovedAt`). The Host enforces it on
 * every `run` path — the drag onto the run column, the detail Run button and
 * cron — so neither a browser action nor an unattended schedule can bypass it,
 * and a content edit re-arms the gate because the approval belongs to the text
 * that was released.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTask, requiresSpecApproval } from '../src/core/tasks.ts'
import { parseLedger } from '../src/core/store.ts'
import { applyUpdateTask } from '../src/core/use-cases/task-update.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { parseActionEnvelope } from '../src/protocol.ts'

const NOW = 1_700_000_000_000
const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-spec-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function envelope(action: unknown): ReturnType<typeof parseActionEnvelope> {
  return parseActionEnvelope({ requestId: 'req-1', action })
}

/** A ledger holding one backlog card `card`, unreleased. */
function seeded(): HostTaskLedger {
  const ledger = new HostTaskLedger(tempRoot(), () => NOW)
  ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
  return ledger
}

describe('specification release: protocol', () => {
  it('parses the approve-spec action and rejects malformed variants', () => {
    expect(envelope({ kind: 'approve-spec', taskId: 't-1' })?.action).toEqual({ kind: 'approve-spec', taskId: 't-1' })
    expect(envelope({ kind: 'approve-spec' })).toBeUndefined()
    expect(envelope({ kind: 'approve-spec', taskId: '' })).toBeUndefined()
    expect(envelope({ kind: 'approve-spec', taskId: 't-1', extra: true })).toBeUndefined()
  })
})

describe('specification release: the Host gate', () => {
  it('refuses the run of an unreleased card everywhere it can start', () => {
    const ledger = seeded()
    expect(() => ledger.applyRequest('run', { kind: 'run', taskId: 'card' })).toThrow(/spec-approval-required/)
    expect(() => ledger.applyRequest('rerun', { kind: 'rerun', taskId: 'card' })).toThrow(/spec-approval-required/)
    expect(() => ledger.applyRequest('todo', { kind: 'move', taskId: 'card', status: 'todo' })).not.toThrow()
    expect(() => ledger.applyRequest('to-running', { kind: 'move', taskId: 'card', status: 'running' })).toThrow(/spec-approval-required/)
    // Only the clarification round of the todo move ran; no implementation.
    expect(ledger.state().tasks[0].executions.map(execution => execution.kind)).toEqual(['clarify'])
    expect(ledger.state().tasks[0].status).toBe('todo')
    ledger.dispose()
  })

  it('starts the card once the human released the specification', () => {
    const ledger = seeded()
    ledger.applyRequest('approve', { kind: 'approve-spec', taskId: 'card' })
    expect(ledger.state().tasks[0].specApprovedAt).toBe(NOW)
    const opened = ledger.applyRequest('run', { kind: 'run', taskId: 'card' })
    expect(opened.run).toBeDefined()
    expect(ledger.state().tasks[0].status).toBe('running')
    ledger.dispose()
  })

  it('keeps the first release instant and refuses to release an archived card', () => {
    let clock = NOW
    const ledger = new HostTaskLedger(tempRoot(), () => clock)
    ledger.applyRequest('create', { kind: 'create', id: 'card', input: { title: 'Card', description: '', prompt: 'work' } })
    ledger.applyRequest('approve', { kind: 'approve-spec', taskId: 'card' })
    clock += 5_000
    ledger.applyRequest('approve-again', { kind: 'approve-spec', taskId: 'card' })
    expect(ledger.state().tasks[0].specApprovedAt).toBe(NOW)
    ledger.applyRequest('archive', { kind: 'archive', taskId: 'card' })
    expect(() => ledger.applyRequest('approve-archived', { kind: 'approve-spec', taskId: 'card' })).toThrow('archived task is read-only')
    expect(() => ledger.applyRequest('approve-missing', { kind: 'approve-spec', taskId: 'nope' })).toThrow('task not found')
    ledger.dispose()
  })

  it('never implements an unreleased card unattended: cron rolls forward instead', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', {
      kind: 'create', id: 'card',
      input: { title: 'Card', description: '', prompt: 'work', schedule: { enabled: true, cron: '* * * * *' } },
    })
    expect(ledger.openScheduled('card', NOW + 60_000, NOW)).toBeUndefined()
    expect(ledger.state().tasks[0].executions).toEqual([])
    expect(ledger.state().tasks[0].schedule?.nextRunAt).toBe(NOW + 60_000)

    ledger.applyRequest('approve', { kind: 'approve-spec', taskId: 'card' })
    expect(ledger.openScheduled('card', NOW + 120_000, NOW + 60_000)).toBeDefined()
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
    ledger.dispose()
  })

  it('re-arms the gate when the released text changes', () => {
    const ledger = seeded()
    ledger.applyRequest('approve', { kind: 'approve-spec', taskId: 'card' })
    ledger.applyRequest('edit', { kind: 'update', taskId: 'card', patch: { prompt: 'work, but differently' } })
    expect(ledger.state().tasks[0].specApprovedAt).toBeUndefined()
    expect(() => ledger.applyRequest('run', { kind: 'run', taskId: 'card' })).toThrow(/spec-approval-required/)
    ledger.dispose()
  })

  it('does not carry the release through an import', () => {
    // The wire sanitizer whitelists the fields of an imported card, so a
    // release (like the permission confirmation) never travels with it.
    const released = { ...createTask({ title: 'Card', description: '', prompt: 'work' }, NOW, 'card'), specApprovedAt: NOW }
    const parsed = envelope({ kind: 'import', sourceId: 'browser', tasks: [released] })
    expect(parsed?.action.kind).toBe('import')
    if (parsed?.action.kind !== 'import') return

    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('import', parsed.action)
    expect(ledger.state().tasks[0].specApprovedAt).toBeUndefined()
    expect(() => ledger.applyRequest('run', { kind: 'run', taskId: 'card' })).toThrow(/spec-approval-required/)
    ledger.dispose()
  })

  it('allows the clarification round of an unreleased card', () => {
    // Asking the questions is exactly what happens before the release.
    const ledger = seeded()
    const moved = ledger.applyRequest('todo', { kind: 'move', taskId: 'card', status: 'todo' })
    expect(moved.clarification).toBeDefined()
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
    expect(ledger.state().tasks[0].executions[0].kind).toBe('clarify')
    ledger.dispose()
  })
})

describe('specification release: model and store', () => {
  it('requires the release while the stamp is absent', () => {
    expect(requiresSpecApproval({ specApprovedAt: undefined })).toBe(true)
    expect(requiresSpecApproval({ specApprovedAt: NOW })).toBe(false)
  })

  it('clears the release on a content patch in the use case', () => {
    const base = { ...createTask({ title: 't', description: '', prompt: 'p' }, NOW, 'id-1'), specApprovedAt: NOW }
    expect(applyUpdateTask([base], 'id-1', { prompt: 'other' }, NOW + 1)[0].specApprovedAt).toBeUndefined()
    // A non-content patch (execution targets) keeps it.
    expect(applyUpdateTask([base], 'id-1', { model: 'x' }, NOW + 1)[0].specApprovedAt).toBe(NOW)
  })

  it('drops a malformed stamp instead of claiming a release', () => {
    const row = JSON.stringify([{ ...createTask({ title: 't', description: '', prompt: 'p' }, NOW, 'id-1'), specApprovedAt: 'yes' }])
    expect(parseLedger(row)[0].specApprovedAt).toBeUndefined()
    const stamped = JSON.stringify([{ ...createTask({ title: 't', description: '', prompt: 'p' }, NOW, 'id-1'), specApprovedAt: NOW }])
    expect(parseLedger(stamped)[0].specApprovedAt).toBe(NOW)
  })
})
