import { useEffect, useState } from 'react'
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable
} from '@dnd-kit/core'
import { useStore, WorkspaceStatus } from '../state'
import type { Workspace, Routine } from '../../../preload'

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  idle: 'Idle',
  working: 'Working…',
  'needs-you': 'Needs you'
}

// Stable reference so the zustand selector doesn't return a fresh array each render.
const EMPTY_PORTS: number[] = []

// Stable empty routine list so the selector doesn't return a fresh array each render.
const EMPTY_ROUTINES: Routine[] = []

function StatusDot({ status }: { status: WorkspaceStatus }): React.JSX.Element {
  return <span className={`status-dot status-${status}`} title={STATUS_LABEL[status]} />
}

// Crisp monochrome line icons (currentColor) — cleaner than emoji for project kind.
function KindIcon({ kind, size = 15 }: { kind: string; size?: number }): React.JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  return kind === 'browser' ? (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4" />
      <ellipse cx="8" cy="8" rx="3" ry="6.2" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M2 4.6c0-.6.4-1 1-1h2.9l1.4 1.6H13c.6 0 1 .4 1 1v5.2c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.6z" />
    </svg>
  )
}

function cadenceLabel(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

// While a routine runs, the current activity (its latest streamed step) so you
// can see what it's doing live from the sidebar.
function currentActivity(routine: Routine): string | null {
  if (routine.lastRunStatus !== 'running') return null
  try {
    const steps = JSON.parse(routine.lastRunTranscript || '[]') as Array<{
      kind: string
      name?: string
      text?: string
    }>
    const last = steps[steps.length - 1]
    if (!last) return 'starting…'
    if (last.kind === 'tool') return (last.name ?? 'working').replace(/^browser_/, '') + '…'
    if (last.text) return last.text.slice(0, 40)
    return 'working…'
  } catch {
    return 'running…'
  }
}

/** A routine shown nested under its project in the sidebar tree. */
function RoutineRow({ routine }: { routine: Routine }): React.JSX.Element {
  const openRoutineRun = useStore((s) => s.openRoutineRun)
  const status = routine.lastRunStatus
  const activity = currentActivity(routine)
  const dotTitle =
    status === 'running'
      ? 'Running now…'
      : status === 'error'
        ? 'Last run failed'
        : status === 'ok'
          ? 'Last run ok'
          : 'Not run yet'
  return (
    <div
      className={`routine-tree-row ${routine.enabled ? '' : 'disabled'}`}
      title={routine.prompt}
      // Open the run transcript — what the routine actually thought/did last run.
      onClick={() => openRoutineRun(routine.id)}
    >
      <span className={`routine-tree-dot routine-dot-${status ?? 'none'}`} title={dotTitle} />
      <span className="routine-tree-cadence">{cadenceLabel(routine.intervalMs)}</span>
      {activity ? (
        <span className="routine-tree-prompt routine-tree-activity">{activity}</span>
      ) : (
        <span className="routine-tree-prompt">{routine.prompt}</span>
      )}
      <button
        className="routine-tree-run"
        title="Run now"
        onClick={(e) => {
          e.stopPropagation()
          window.cove.routinesRunNow(routine.id)
          openRoutineRun(routine.id) // open the viewer so the run is visible live
        }}
      >
        ▶
      </button>
    </div>
  )
}

function WorkspaceRow({ ws, index }: { ws: Workspace; index: number }): React.JSX.Element {
  const active = useStore((s) => s.activeWorkspaceId === ws.id)
  const status = useStore((s) => s.statuses[ws.id] ?? 'idle')
  const ports = useStore((s) => s.ports[ws.id] ?? EMPTY_PORTS)
  const routines = useStore((s) => s.routines[ws.id] ?? EMPTY_ROUTINES)
  const setActive = useStore((s) => s.setActive)
  const removeWorkspace = useStore((s) => s.removeWorkspace)
  const renameWorkspace = useStore((s) => s.renameWorkspace)
  const openPreview = useStore((s) => s.openPreview)
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(ws.name)

  // Git repos nested inside a code project's folder (a folder-of-repos), shown
  // tree-style under it. Refreshed after Claude's turns (branches/repos change).
  const [subrepos, setSubrepos] = useState<
    { name: string; path: string; branch: string | null }[]
  >([])
  const [reposOpen, setReposOpen] = useState(false) // collapsed by default
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null) // step 1 of 2
  const openFolderAsProject = useStore((s) => s.openFolderAsProject)
  useEffect(() => {
    if (ws.kind === 'browser') return
    let alive = true
    const refresh = (): void => {
      window.cove.gitSubrepos(ws.path).then((s) => {
        if (alive) setSubrepos(s)
      })
    }
    refresh()
    const onIdle = (e: Event): void => {
      if ((e as CustomEvent<{ workspaceId: string }>).detail?.workspaceId === ws.id) refresh()
    }
    window.addEventListener('cove:workspace-idle', onIdle)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', onIdle)
    }
  }, [ws.kind, ws.path, ws.id])

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: ws.id,
    data: { index, groupId: ws.groupId }
  })
  // Also a drop target, so dragging over a row lets us reorder relative to it
  // (not just append to the group).
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: ws.id })
  const setRefs = (node: HTMLElement | null): void => {
    setNodeRef(node)
    setDropRef(node)
  }

  return (
    <div className="sidebar-item-wrap">
      <div
        ref={setRefs}
        className={`sidebar-item ${active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isOver ? 'drop-before' : ''}`}
        onClick={() => setActive(ws.id)}
        {...attributes}
        {...listeners}
      >
        <StatusDot status={status} />
        <span
          className="sidebar-item-kind"
          title={ws.kind === 'browser' ? 'Browser project' : 'Code project'}
        >
          <KindIcon kind={ws.kind} />
        </span>
        {editing ? (
          <input
            className="sidebar-item-rename"
            value={draftName}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => {
              const n = draftName.trim()
              if (n && n !== ws.name) renameWorkspace(ws.id, n)
              else setDraftName(ws.name)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setDraftName(ws.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <span
            className="sidebar-item-name"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setDraftName(ws.name)
              setEditing(true)
            }}
            title="Double-click to rename"
          >
            {ws.name}
          </span>
        )}
        {ports.length > 0 && (
          <span
            className="port-chip"
            title={`Open localhost:${ports[ports.length - 1]} in the preview`}
            onClick={(e) => {
              e.stopPropagation()
              openPreview(ws.id, ports[ports.length - 1])
            }}
          >
            :{ports[ports.length - 1]}
          </span>
        )}
        <button
          className="sidebar-item-remove"
          title="Remove from SuperAgent"
          onClick={(e) => {
            e.stopPropagation()
            removeWorkspace(ws.id)
          }}
        >
          ×
        </button>
      </div>
      {subrepos.length > 0 && (
        <div className="routine-tree">
          <button
            className="repo-tree-toggle"
            onClick={() => setReposOpen((v) => !v)}
            aria-expanded={reposOpen}
          >
            <span
              className="repo-tree-caret"
              style={{ transform: reposOpen ? 'none' : 'rotate(-90deg)' }}
            >
              ▾
            </span>
            {subrepos.length} repos
          </button>
          {reposOpen &&
            subrepos.map((r) => (
              <div
                key={r.path}
                className={`routine-tree-row repo-tree-row ${selectedRepo === r.path ? 'selected' : ''}`}
                title={r.path}
                // Step 1: select. Step 2: the revealed "Start session" button opens it.
                onClick={() => setSelectedRepo((cur) => (cur === r.path ? null : r.path))}
              >
                <span className="repo-tree-icon">
                  <KindIcon kind="code" size={12} />
                </span>
                <span className="routine-tree-prompt">{r.name}</span>
                {r.branch && selectedRepo !== r.path && (
                  <span className="repo-tree-branch">⎇ {r.branch}</span>
                )}
                {selectedRepo === r.path && (
                  <button
                    className="repo-tree-open"
                    onClick={(e) => {
                      e.stopPropagation()
                      openFolderAsProject(ws.groupId, r.name, r.path)
                      setSelectedRepo(null)
                    }}
                  >
                    Start session →
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
      {routines.length > 0 && (
        <div className="routine-tree">
          {routines.map((r) => (
            <RoutineRow key={r.id} routine={r} />
          ))}
        </div>
      )}
    </div>
  )
}

function GroupSection({
  group
}: {
  group: ReturnType<typeof useStore.getState>['tree'][number]
}): React.JSX.Element {
  const toggleCollapse = useStore((s) => s.toggleCollapse)
  const renameGroup = useStore((s) => s.renameGroup)
  const addWorkspace = useStore((s) => s.addWorkspace)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.id}` })
  const collapsed = group.collapsed === 1

  return (
    <div className={`sidebar-group ${isOver ? 'drop-target' : ''}`} ref={setNodeRef}>
      <div className="sidebar-group-header">
        <button
          className="group-caret"
          onClick={() => toggleCollapse(group.id, !collapsed)}
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
          aria-label={collapsed ? 'Expand group' : 'Collapse group'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          ▾
        </button>
        {editing ? (
          <input
            className="group-name-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              renameGroup(group.id, name || group.name)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                renameGroup(group.id, name || group.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <span className="sidebar-group-title" onDoubleClick={() => setEditing(true)}>
            {group.name}
          </span>
        )}
        <button
          className="group-add"
          title="New project"
          aria-label="New project"
          onClick={() => addWorkspace(group.id)}
        >
          +
        </button>
      </div>
      {!collapsed && (
        <div className="sidebar-group-items">
          {group.workspaces.map((ws, i) => (
            <WorkspaceRow key={ws.id} ws={ws} index={i} />
          ))}
          {group.workspaces.length === 0 && (
            <button className="group-empty" onClick={() => addWorkspace(group.id)}>
              Add a project…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const refresh = useStore((s) => s.refresh)
  const addGroup = useStore((s) => s.addGroup)
  const moveWorkspace = useStore((s) => s.moveWorkspace)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => {
    refresh()
  }, [refresh])

  const onDragEnd = (e: DragEndEvent): void => {
    const activeId = String(e.active.id)
    const overId = e.over?.id ? String(e.over.id) : null
    if (!overId || overId === activeId) return

    const locate = (id: string): { groupId: string; index: number } | null => {
      for (const g of tree) {
        const index = g.workspaces.findIndex((w) => w.id === id)
        if (index >= 0) return { groupId: g.id, index }
      }
      return null
    }
    const src = locate(activeId)
    if (!src) return

    // Dropped on a group's empty area → append to that group.
    if (overId.startsWith('group:')) {
      const toGroupId = overId.slice('group:'.length)
      const group = tree.find((g) => g.id === toGroupId)
      moveWorkspace(activeId, toGroupId, group?.workspaces.length ?? 0)
      return
    }

    // Dropped on a specific row → insert before it. When reordering down within
    // the same group, removing the item first shifts the target left by one.
    const dst = locate(overId)
    if (!dst) return
    const sameGroup = dst.groupId === src.groupId
    const toIndex = sameGroup && src.index < dst.index ? dst.index - 1 : dst.index
    moveWorkspace(activeId, dst.groupId, toIndex)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-drag-region" />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="sidebar-scroll">
          {tree.map((group) => (
            <GroupSection key={group.id} group={group} />
          ))}
        </div>
      </DndContext>
      <div className="sidebar-footer">
        <button className="sidebar-add-group" onClick={() => addGroup()}>
          + New group
        </button>
        <button
          className="sidebar-settings"
          title="Settings"
          onClick={() => window.dispatchEvent(new CustomEvent('cove:open-settings'))}
        >
          ⚙
        </button>
      </div>
    </aside>
  )
}
