import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../state'
import { EasyChat } from './EasyChat'
import { BrowserPane } from './BrowserPane'
import { FileTree } from './FileTree'
import { SkillsPanel } from './SkillsPanel'
import { RoutinesPanel } from './RoutinesPanel'
import { RoutineRunView } from './RoutineRunView'
import type { Workspace, Routine } from '../../../preload'

const EMPTY_ROUTINES: Routine[] = []

export function WorkspaceView({
  ws,
  visible = true
}: {
  ws: Workspace
  visible?: boolean
}): React.JSX.Element {
  // Browser projects open with the preview showing by default.
  const browserOpen = useStore((s) => s.browserOpen[ws.id] ?? ws.kind === 'browser')
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  const filesOpen = useStore((s) => s.filesOpen[ws.id] ?? false)
  const toggleFiles = useStore((s) => s.toggleFiles)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [routinesOpen, setRoutinesOpen] = useState(false)
  // Current git branch, for code projects only (browser projects have no repo).
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    if (ws.kind === 'browser') return
    let alive = true
    const refresh = (): void => {
      window.cove.gitBranch(ws.path).then((b) => {
        if (alive) setBranch(b)
      })
    }
    refresh()
    // Re-check after Claude finishes a turn — it may have switched branches.
    const onIdle = (e: Event): void => {
      if ((e as CustomEvent<{ workspaceId: string }>).detail?.workspaceId === ws.id) refresh()
    }
    window.addEventListener('cove:workspace-idle', onIdle)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', onIdle)
    }
  }, [ws.kind, ws.path, ws.id])
  // A routine run opened for this workspace shows in the chat column (left).
  const openRunId = useStore((s) => s.openRoutineRunId)
  const wsRoutines = useStore((s) => s.routines[ws.id] ?? EMPTY_ROUTINES)
  const activeRun = openRunId ? wsRoutines.find((r) => r.id === openRunId) : undefined

  // Only the visible workspace responds to global menu actions (all opened
  // workspaces stay mounted for keep-alive).
  useEffect(() => {
    if (!visible) return
    const onSkills = (): void => setSkillsOpen(true)
    const onRoutines = (): void => setRoutinesOpen(true)
    const onToggle = (): void => toggleBrowser(ws.id)
    window.addEventListener('cove:menu-skills', onSkills)
    window.addEventListener('cove:menu-routines', onRoutines)
    window.addEventListener('cove:menu-toggle-preview', onToggle)
    return () => {
      window.removeEventListener('cove:menu-skills', onSkills)
      window.removeEventListener('cove:menu-routines', onRoutines)
      window.removeEventListener('cove:menu-toggle-preview', onToggle)
    }
  }, [ws.id, toggleBrowser, visible])

  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => {
    const saved = localStorage.getItem(`split:${ws.id}`)
    return saved ? Math.min(0.8, Math.max(0.2, Number(saved))) : 0.55
  })
  const [dragging, setDragging] = useState(false)

  const onDividerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      setDragging(true)
      const container = containerRef.current
      if (!container) return
      const move = (ev: PointerEvent): void => {
        const rect = container.getBoundingClientRect()
        // The file tree shares this container, so measure from the end of it —
        // otherwise its width skews the split. `ratio` stays the chat's share,
        // and the chat is now the right-hand pane, hence the inversion.
        const files = container.querySelector('.files-side')
        const offset = files ? files.getBoundingClientRect().width : 0
        const usable = rect.width - offset
        if (usable <= 0) return
        const browserFrac = (ev.clientX - rect.left - offset) / usable
        setRatio(Math.min(0.8, Math.max(0.2, 1 - browserFrac)))
      }
      const up = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setRatio((r) => {
          localStorage.setItem(`split:${ws.id}`, String(r))
          return r
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [ws.id]
  )

  return (
    <div className="workspace-view">
      <div className="workspace-toolbar">
        {/* Leads the toolbar because the pane it opens is the leftmost column. */}
        {ws.kind !== 'browser' && (
          <button
            className={`toolbar-btn ${filesOpen ? 'on' : ''}`}
            onClick={() => toggleFiles(ws.id)}
            title="Project files"
          >
            📁 Files
          </button>
        )}
        <span className="workspace-title">{ws.name}</span>
        <span className="workspace-path">{ws.path}</span>
        {branch && (
          <span className="workspace-branch" title={`On git branch ${branch}`}>
            ⎇ {branch}
          </span>
        )}
        <div className="workspace-toolbar-spacer" />
        <button
          className="toolbar-btn"
          onClick={() => setRoutinesOpen(true)}
          title="Scheduled tasks"
        >
          ⏱ Routines
        </button>
        <button className="toolbar-btn" onClick={() => setSkillsOpen(true)} title="Your skills">
          ✦ Skills
        </button>
        {/* No manual toggle for code projects: the pane reveals itself when the
            agent navigates or you open a file, and closes from its own ✕. */}
        {ws.kind === 'browser' && (
          <button
            className={`toolbar-btn ${browserOpen ? 'on' : ''}`}
            onClick={() => toggleBrowser(ws.id)}
          >
            {browserOpen ? 'Hide preview' : 'Show preview'}
          </button>
        )}
      </div>
      {/* The chat stays mounted (stable position) whether or not the browser is
          open, so toggling the preview never disturbs the conversation. */}
      <div ref={containerRef} className="content-split">
        {filesOpen && ws.kind !== 'browser' && (
          <div className="files-side">
            <FileTree cwd={ws.path} workspaceId={ws.id} />
          </div>
        )}
        {/* Sits between the tree and the chat: a file you click on the left opens
            next to it, rather than across the window. Chat keeps the far side. */}
        {browserOpen && (
          <>
            <div className="split-side" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
              <BrowserPane
                paneId={ws.id}
                partition={`persist:ws-${ws.id}`}
                initialUrl={ws.browserUrl ?? undefined}
                visible={visible}
                closable={ws.kind !== 'browser'}
              />
            </div>
            <div
              className={`split-divider ${dragging ? 'dragging' : ''}`}
              onPointerDown={onDividerDown}
              role="separator"
            />
          </>
        )}
        <div
          className="split-side split-side-chat"
          style={{ flexBasis: browserOpen ? `${ratio * 100}%` : '100%' }}
        >
          <EasyChat
            cwd={ws.path}
            workspaceId={ws.id}
            initialSessionId={ws.lastSessionId}
            browserProject={ws.kind === 'browser'}
          />
          {activeRun && visible && <RoutineRunView routine={activeRun} />}
        </div>
      </div>
      {/* Gated on `visible` too: a hidden workspace must not keep a slide-over
          mounted, or its overlay lock would blank the active workspace's preview. */}
      {skillsOpen && visible && (
        <SkillsPanel
          workspaceId={ws.id}
          projectPath={ws.path}
          onClose={() => setSkillsOpen(false)}
        />
      )}
      {routinesOpen && visible && <RoutinesPanel ws={ws} onClose={() => setRoutinesOpen(false)} />}
    </div>
  )
}
