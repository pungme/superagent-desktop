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
  const openPreview = useStore((s) => s.openPreview)

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
          {ws.kind === 'browser' ? '🌐' : '📁'}
        </span>
        <span className="sidebar-item-name">{ws.name}</span>
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
        <span className="group-color" style={{ background: group.color }} />
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
