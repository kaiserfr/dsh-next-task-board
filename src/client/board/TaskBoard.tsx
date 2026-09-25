/**
 * Board view: the multi-column kanban that replaces the middle column while
 * active. A card click marks it (Ctrl/Cmd adds one, Shift marks the range up to
 * the anchor), a double click opens the task detail (never executes directly);
 * the header offers filter, new-task, and a back-to-chat escape.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { selectedTaskOf, type BoardController } from '../../core/controller.ts'
import { collectKnownTags, compareWipOrder, tagTone, type TaskRecord, type TaskStatus } from '../../core/tasks.ts'
import { resolveStateMachine } from '../../core/state-machine.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { NewTaskModal } from './NewTaskModal.tsx'
import { isCardDraggable, TaskCard } from './TaskCard.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import type { TaskBoardKey } from '../locales.ts'

/** Sentinel option value of the project row's "register a new project" entry. */
export const NEW_PROJECT_VALUE = '__dsh_new_project__'

/**
 * Drag payload MIME type carrying the whole group: a JSON array of card ids in
 * board (display) order. `text/plain` keeps the lead card's id so an external
 * drop target, an older board, or a plain single-card drag still works.
 */
export const BATCH_DRAG_MIME = 'application/x-dsh-taskboard-cards'

/** Stable empty set, so clearing the drag marker keeps the same reference. */
const NO_IDS: ReadonlySet<string> = new Set<string>()

type BoardMachine = ReturnType<typeof resolveStateMachine>['machine']

/**
 * Dropping onto a column whose transition carries the `run` action starts the
 * task (the same Host action as the detail view's Run button): the machine
 * declares that entry, the runner owns it. Such a column accepts the drop even
 * with `"drop": false` (the shipped `running` column does).
 */
function isRunColumn(machine: BoardMachine, status: TaskStatus): boolean {
  return machine.config.transitions.some(item => item.to === status && (item.actions ?? []).includes('run'))
}

/**
 * The cards of one column in the order the board renders them. The
 * runner-owned column reads as a work queue — the card being executed now sits
 * on top, the runs still waiting for a WIP slot follow in arrival order (the
 * card dragged in last sits at the bottom) — every other column keeps the
 * ledger's order. Rendering and the Shift-click range share this, so the two
 * never disagree about what "between two cards" means.
 */
function columnTasks(machine: BoardMachine, visible: readonly TaskRecord[], status: TaskStatus): TaskRecord[] {
  const tasks = visible.filter(task => task.status === status)
  if (isRunColumn(machine, status)) tasks.sort(compareWipOrder)
  return tasks
}

/**
 * The dragged card ids: the batch payload when present and well-formed, else
 * the lead id from `text/plain` (single-card drags and older writers).
 */
export function readDragIds(dataTransfer: DataTransfer, lead: string): string[] {
  const raw = typeof dataTransfer.getData === 'function' ? dataTransfer.getData(BATCH_DRAG_MIME) : ''
  if (raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(id => typeof id === 'string' && id !== '')) {
        return parsed
      }
    } catch {
      // Malformed payload: fall back to the lead id below.
    }
  }
  return lead === '' ? [] : [lead]
}

/** Case-insensitive title/description/tag/freeze-snapshot match. */
export function matchesFilter(task: TaskRecord, filter: string): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  const haystacks = [task.title, task.description, ...(task.tags ?? []).map(tag => tag.name)]
  if (task.freeze !== undefined) haystacks.push(task.freeze.goal, task.freeze.progress, task.freeze.next)
  return haystacks.some(text => text.toLowerCase().includes(needle))
}

/**
 * Whether a task carries every selected label (issue #1521). Multi-select is
 * conjunctive: adding a label narrows the board instead of widening it, which
 * is the only reading that keeps "工作" selected from dragging unrelated cards
 * back in when a second label is added.
 */
export function matchesTagFilter(task: TaskRecord, selected: readonly string[]): boolean {
  if (selected.length === 0) return true
  const names = new Set((task.tags ?? []).map(tag => tag.name))
  return selected.every(name => names.has(name))
}

/**
 * Memoized per-card adapter: with a stable `onOpen` from the board and an
 * immutable task record (only the changed card gets a new object ref), a card
 * re-renders only when its own task changes — not when a sibling card status,
 * the filter, or the selection moves.
 */
const MemoTaskCard = memo(function MemoTaskCard({ task, pending, timeZone, selected, dragging, onSelect, onKeySelect, onOpen, onDragStart, onDragEnd, onOpenSession }: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  selected: boolean
  dragging: boolean
  onSelect: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void
  onKeySelect: (id: string, event: ReactKeyboardEvent<HTMLButtonElement>) => void
  onOpen: (id: string) => void
  onDragStart: (id: string, event: ReactDragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
  onOpenSession: (sessionId: string) => void
}) {
  const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => { onSelect(task.id, event) }, [task.id, onSelect])
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => { onKeySelect(task.id, event) }, [task.id, onKeySelect])
  const onDoubleClick = useCallback(() => { onOpen(task.id) }, [task.id, onOpen])
  const onStart = useCallback((event: ReactDragEvent<HTMLButtonElement>) => { onDragStart(task.id, event) }, [task.id, onDragStart])
  return (
    <TaskCard
      task={task}
      pending={pending}
      timeZone={timeZone}
      selected={selected}
      dragging={dragging}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      onDragStart={onStart}
      onDragEnd={onDragEnd}
      onOpenSession={onOpenSession}
    />
  )
})

/** Board component; subscribes to the controller snapshot. */
export function TaskBoard({ controller }: { controller: BoardController }) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [showNew, setShowNew] = useState(false)
  // Project partition (#1536): '' means "all projects". A selected project
  // narrows the board and becomes the new-task form's default workspace.
  const [projectId, setProjectId] = useState('')
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectPath, setNewProjectPath] = useState('')
  const [newProjectError, setNewProjectError] = useState<string | undefined>(undefined)
  const [newProjectPending, setNewProjectPending] = useState(false)
  // Multi-selection (a browser-only view state, like the filter): the cards a
  // group drag carries. `dragIds` marks the set currently under the cursor so
  // the board can render the moved cards and the counter while dragging.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(NO_IDS)
  const [dragIds, setDragIds] = useState<ReadonlySet<string>>(NO_IDS)
  // The Shift range starts at the anchor: the card the last plain or Ctrl click
  // landed on. A ref, not state, so marking a card never changes the memoized
  // cards' props — only the cards whose `selected` flag flips re-render.
  const anchorRef = useRef<string | undefined>(undefined)
  const selected = selectedTaskOf(snapshot)
  const archiveView = snapshot.archiveView
  // The Host sends the machine it enforces; without one (older Host, tests)
  // the shipped machine applies. Columns, their labels, and which drops are
  // allowed all come from here — the board's columns *are* the task states.
  const machine = resolveStateMachine(snapshot.host?.stateMachine).machine
  // Every label in use across the ledger (board and archive alike), so the
  // filter never loses an option just because its task was archived.
  const knownTags = collectKnownTags(snapshot.tasks)
  const pendingSet = useMemo(() => new Set(snapshot.pendingTaskIds), [snapshot.pendingTaskIds])
  // Archived tasks leave the columns; the archive view shows them instead.
  // Memoized so the memoized cards keep their memo boundary across renders.
  const visible = useMemo(() => snapshot.tasks.filter(task =>
    (archiveView ? task.archivedAt !== undefined : task.archivedAt === undefined)
    && (projectId === '' || task.workspaceId === projectId)
    && matchesFilter(task, filter)
    && matchesTagFilter(task, tagFilter),
  ), [snapshot.tasks, archiveView, projectId, filter, tagFilter])
  // The selection as it can actually be dragged: cards still on the board and
  // not owned by the runner. A card that left the board (archived/deleted) or
  // started running drops out here without a second source of truth.
  const selectableIds = useMemo(
    () => visible.filter(task => selectedIds.has(task.id) && isCardDraggable(task, pendingSet.has(task.id))).map(task => task.id),
    [visible, selectedIds, pendingSet],
  )
  // The rendered card order — columns left to right, cards top to bottom within
  // a column — which is the reference order a Shift click walks. Empty in the
  // archive view: archived cards are read-only and never selectable.
  const boardOrderIds = useMemo(
    () => (archiveView ? [] : machine.states.flatMap(column => columnTasks(machine, visible, column.status).map(task => task.id))),
    [archiveView, machine, visible],
  )
  const projects = snapshot.executionOptions.workspaces
  const canCreateProject = snapshot.canCreateWorkspace === true
  const submitNewProject = async (): Promise<void> => {
    const path = newProjectPath.trim()
    if (path === '') return
    setNewProjectPending(true)
    setNewProjectError(undefined)
    try {
      const created = await controller.createWorkspace(path)
      setProjectId(created.workspaceId)
      setShowNewProject(false)
      setNewProjectPath('')
    } catch (error) {
      setNewProjectError(error instanceof Error ? error.message : String(error))
    } finally {
      setNewProjectPending(false)
    }
  }
  const toggleTag = useCallback((name: string): void => {
    setTagFilter(current => current.includes(name)
      ? current.filter(entry => entry !== name)
      : [...current, name])
  }, [])
  const clearSelection = useCallback((): void => {
    anchorRef.current = undefined
    setSelectedIds(current => current.size === 0 ? current : NO_IDS)
  }, [])
  // The card mark, the way a file manager does it:
  //   click        → this card alone becomes the selection (and the new anchor)
  //   Ctrl/Cmd     → toggles this card in or out of the selection
  //   Shift        → the range from the anchor to this card, in board order
  //   Space        → the same three marks from the keyboard (selectCardByKey)
  //   double click → open the detail (below); Enter does the same, because the
  //                  browser turns it into the button's own click
  // Archived cards are read-only: they always open, never select.
  //
  // Marking is shared by the mouse and the keyboard; the two entry points only
  // differ in how they read the modifiers off their event.
  const markCard = useCallback((id: string, modifiers: { shift: boolean; toggle: boolean }): void => {
    const to = boardOrderIds.indexOf(id)
    if (to < 0) return
    if (modifiers.shift) {
      const from = anchorRef.current === undefined ? -1 : boardOrderIds.indexOf(anchorRef.current)
      // Without a (still visible) anchor there is no range to walk: the clicked
      // card becomes the anchor itself.
      if (from < 0) {
        anchorRef.current = id
        setSelectedIds(new Set([id]))
        return
      }
      setSelectedIds(new Set(boardOrderIds.slice(Math.min(from, to), Math.max(from, to) + 1)))
      return
    }
    if (modifiers.toggle) {
      anchorRef.current = id
      setSelectedIds(current => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    anchorRef.current = id
    setSelectedIds(new Set([id]))
  }, [boardOrderIds])
  const selectCard = useCallback((id: string, event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (archiveView) { controller.openTask(id); return }
    // A click carrying no mouse position is a keyboard/AT activation of the
    // button, not a click on a spot; it keeps the direct route to the detail.
    if (event.detail === 0) { controller.openTask(id); return }
    markCard(id, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })
  }, [archiveView, controller, markCard])
  // Space is the keyboard's plain click: it marks the focused card with the
  // same Shift/Ctrl semantics, so a keyboard has the whole marking vocabulary
  // too. Enter is deliberately left alone — the browser's own click opens the
  // detail through `selectCard` above. `preventDefault` suppresses both that
  // synthetic click and the page scroll Space would otherwise start.
  const selectCardByKey = useCallback((id: string, event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== ' ') return
    event.preventDefault()
    if (archiveView) { controller.openTask(id); return }
    markCard(id, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })
  }, [archiveView, controller, markCard])
  // The detail keeps the selection: marking cards and inspecting one of them
  // are separate intentions.
  const openDetail = useCallback((id: string): void => { controller.openTask(id) }, [controller])
  // Direct card → session jump (active and inactive sessions alike). The
  // controller refreshes a stale roster before it reports a failed jump.
  const openSession = useCallback((sessionId: string): void => { controller.openSession?.(sessionId) }, [controller])
  const endDrag = useCallback((): void => { setDragIds(NO_IDS) }, [])
  // Drag start on a card: a selected card carries the whole draggable
  // selection, any other card drags alone — the single-card behavior is
  // untouched (requirement 3).
  const startDrag = useCallback((id: string, event: ReactDragEvent<HTMLButtonElement>): void => {
    const task = snapshot.tasks.find(item => item.id === id)
    if (task === undefined || !isCardDraggable(task, pendingSet.has(id))) return
    const ids = selectedIds.has(id) && selectableIds.includes(id) ? selectableIds : [id]
    event.dataTransfer.setData('text/plain', id)
    event.dataTransfer.setData(BATCH_DRAG_MIME, JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'move'
    setDragIds(new Set(ids))
  }, [pendingSet, selectableIds, selectedIds, snapshot.tasks])
  // One drop handler for every column. It takes the movable subset of the
  // dragged cards: a card the machine does not allow into this column stays
  // where it is, and a drop with nothing movable changes nothing at all.
  const dropOnColumn = useCallback((columnStatus: TaskStatus, isRunTarget: boolean, event: ReactDragEvent<HTMLElement>): void => {
    event.preventDefault()
    const ids = readDragIds(event.dataTransfer, event.dataTransfer.getData('text/plain'))
    setDragIds(NO_IDS)
    const dragged = ids
      .map(id => snapshot.tasks.find(task => task.id === id))
      .filter((task): task is TaskRecord => task !== undefined)
      .filter(task => isCardDraggable(task, pendingSet.has(task.id)))
    const movable = dragged.filter(task => isRunTarget
      ? task.status !== columnStatus && machine.actionsFor(task.status, columnStatus).includes('run')
      : machine.canTransition(task.status, columnStatus))
    if (movable.length === 0) return
    // The runner owns the run entry; start each card in drag order so the
    // queue keeps that order (the WIP limit still gates the launches).
    if (isRunTarget) {
      void (async () => {
        for (const task of movable) await controller.rerunTask(task.id)
      })()
      clearSelection()
      return
    }
    const moving = movable.map(task => task.id)
    if (moving.length === 1) {
      controller.moveTask(moving[0]!, columnStatus)
      clearSelection()
      return
    }
    void controller.moveTasks(moving, columnStatus).then(moved => { if (moved) clearSelection() })
  }, [clearSelection, controller, machine, pendingSet, snapshot.tasks])

  return (
    <div
      className={css.board}
      data-dsh-taskboard-board=""
      data-dsh-plugin="task-board"
      // A click on free board space drops the selection; a click inside a card
      // (or its session link) belongs to that card and is ignored.
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('[data-dsh-part="card-box"]') !== null) return
        clearSelection()
      }}
    >
      <header className={css.boardHeader}>
        {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          data-dsh-center-view-back=""
          aria-label={t('board.close')}
          onClick={() => { controller.closeBoard() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{t('board.close')}</span>
        </button>
        <h2 className={css.boardTitle}>{t('board.title')}</h2>
        {snapshot.host !== undefined && (
          <span className={css.detailMeta}>
            {t('board.hostMeta', {
              revision: String(snapshot.host.revision),
              timeZone: snapshot.host.scheduler.timeZone,
            })}
          </span>
        )}
        {selectedIds.size > 0 && (
          <span className={css.selectionBar} data-dsh-part="selection-bar" role="status">
            {t('board.selectedCount', { count: String(selectedIds.size) })}
            <button type="button" className={css.linkButton} onClick={clearSelection}>
              {t('board.selectionClear')}
            </button>
          </span>
        )}
        {(projects.length > 0 || canCreateProject) && (
          <label className={css.projectFilter}>
            <span className={css.projectFilterLabel}>{t('board.project')}</span>
            <select
              className={css.select}
              data-dsh-part="project-filter"
              value={projectId}
              aria-label={t('board.project')}
              onChange={event => {
                const value = event.target.value
                if (value === NEW_PROJECT_VALUE) {
                  setNewProjectError(undefined)
                  setShowNewProject(true)
                  return
                }
                setProjectId(value)
              }}
            >
              <option value="">{t('board.projectAll')}</option>
              {projects.map(project => (
                <option key={project.workspaceId} value={project.workspaceId}>{project.title}</option>
              ))}
              {canCreateProject && <option value={NEW_PROJECT_VALUE}>{t('board.projectNew')}</option>}
            </select>
          </label>
        )}
        <input
          className={css.search}
          type="search"
          placeholder={t('board.search')}
          value={filter}
          onChange={event => { setFilter(event.target.value) }}
          aria-label={t('board.search')}
        />
        <button
          type="button"
          className={archiveView ? css.primaryButton : css.ghostButton}
          onClick={() => { clearSelection(); controller.toggleArchiveView() }}
        >
          {archiveView
            ? t('board.backToBoard')
            : t('board.archiveView', { count: String(snapshot.tasks.filter(task => task.archivedAt !== undefined).length) })}
        </button>
        <button
          type="button"
          className={css.primaryButton}
          onClick={() => { setShowNew(true) }}
        >
          + {t('board.new')}
        </button>
      </header>

      {showNewProject && (
        <div className={css.projectDialog} data-dsh-part="project-dialog">
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('board.projectNewPath')}</span>
            <input
              className={css.input}
              value={newProjectPath}
              placeholder={t('board.projectNewPathPlaceholder')}
              spellCheck={false}
              onChange={event => { setNewProjectPath(event.target.value); setNewProjectError(undefined) }}
            />
          </label>
          {newProjectError !== undefined && <p className={css.formError}>{t('board.projectCreateFailed', { error: newProjectError })}</p>}
          <div className={css.projectDialogActions}>
            <button
              type="button"
              className={css.ghostButton}
              onClick={() => { setShowNewProject(false); setNewProjectError(undefined) }}
            >
              {t('new.cancel')}
            </button>
            <button
              type="button"
              className={css.primaryButton}
              disabled={newProjectPending || newProjectPath.trim() === ''}
              onClick={() => { void submitNewProject() }}
            >
              {t('board.projectCreate')}
            </button>
          </div>
        </div>
      )}

      {!archiveView && knownTags.length > 0 && (
        <div className={css.tagFilter} data-dsh-part="tag-filter">
          <span className={css.tagFilterLabel}>{t('board.tagFilter')}</span>
          {knownTags.map(tag => {
            const active = tagFilter.includes(tag.name)
            return (
              <button
                key={tag.name}
                type="button"
                className={css.tagChip}
                data-dsh-part="tag-chip"
                data-tag-tone={tagTone(tag.name)}
                data-active={active ? 'true' : undefined}
                aria-pressed={active}
                title={tag.promptPrefix === undefined ? tag.name : tag.promptPrefix}
                onClick={() => { toggleTag(tag.name) }}
              >
                {tag.name}
              </button>
            )
          })}
          {tagFilter.length > 0 && (
            <button type="button" className={css.linkButton} onClick={() => { setTagFilter([]) }}>
              {t('board.tagFilterClear')}
            </button>
          )}
        </div>
      )}

      {snapshot.transportError !== undefined && (
        <div className={css.formError}>
          {t('board.hostError', { error: snapshot.transportError })}{' '}
          <button type="button" className={css.linkButton} onClick={() => { void controller.retryHostSync() }}>
            {t('board.retryHost')}
          </button>
        </div>
      )}

      {snapshot.sessionOpenError !== undefined && (
        <div className={css.formError} data-dsh-part="session-error">
          {t('board.sessionOpenError', { error: snapshot.sessionOpenError })}{' '}
          <button type="button" className={css.linkButton} onClick={() => { controller.dismissSessionOpenError?.() }}>
            {t('board.dismiss')}
          </button>
        </div>
      )}

      {dragIds.size > 1 && (
        <div className={css.dragBadge} data-dsh-part="drag-count" role="status">
          {t('board.dragCount', { count: String(dragIds.size) })}
        </div>
      )}

      <div className={css.columns}>
        {archiveView ? (
          <section className={css.column} data-status="archived" data-dsh-part="column">
            <header className={css.columnHeader}>
              <h3 className={css.columnTitle}>{t('board.archive')}</h3>
              <span className={css.columnCount}>{visible.length}</span>
            </header>
            <div className={css.cards}>
              {visible.map(task => (
                <MemoTaskCard key={task.id} task={task} pending={pendingSet.has(task.id)} timeZone={snapshot.host?.scheduler.timeZone} selected={false} dragging={false} onSelect={selectCard} onKeySelect={selectCardByKey} onOpen={openDetail} onDragStart={startDrag} onDragEnd={endDrag} onOpenSession={openSession} />
              ))}
              {visible.length === 0 && (
                <div className={css.columnEmpty}>{tagFilter.length > 0 ? t('board.tagEmpty') : t('archive.empty')}</div>
              )}
            </div>
          </section>
        ) : (
          machine.states.map(column => {
            const tasks = columnTasks(machine, visible, column.status)
            const isRunDropTarget = isRunColumn(machine, column.status)
            const isDropTarget = machine.acceptsDrop(column.status) || isRunDropTarget
            return (
              <section
                key={column.status}
                className={css.column}
                data-status={column.status}
                data-dsh-part="column"
                onDragOver={isDropTarget ? (event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                } : undefined}
                onDrop={isDropTarget ? (event) => { dropOnColumn(column.status, isRunDropTarget, event) } : undefined}
              >
                <header className={css.columnHeader}>
                  <span className={css.statusDot} data-status={column.status} aria-hidden="true" />
                  <h3 className={css.columnTitle}>{column.label ?? t(`board.status.${column.status}` as TaskBoardKey)}</h3>
                  <span className={css.columnCount}>{tasks.length}</span>
                </header>
                <div className={css.cards}>
                  {tasks.map(task => (
                    <MemoTaskCard key={task.id} task={task} pending={pendingSet.has(task.id)} timeZone={snapshot.host?.scheduler.timeZone} selected={selectedIds.has(task.id)} dragging={dragIds.has(task.id)} onSelect={selectCard} onKeySelect={selectCardByKey} onOpen={openDetail} onDragStart={startDrag} onDragEnd={endDrag} onOpenSession={openSession} />
                  ))}
                  {tasks.length === 0 && (
                    <div className={css.columnEmpty}>{tagFilter.length > 0 ? t('board.tagEmpty') : t('board.empty')}</div>
                  )}
                </div>
              </section>
            )
          })
        )}
      </div>

      {selected !== undefined && (
        <TaskDetail controller={controller} task={selected} />
      )}
      {showNew && (
        <NewTaskModal
          controller={controller}
          {...(projectId === '' ? {} : { defaultWorkspaceId: projectId })}
          onClose={() => { setShowNew(false) }}
        />
      )}
    </div>
  )
}
