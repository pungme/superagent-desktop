import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../state'
import { EasyChat } from './EasyChat'
import { BrowserPane } from './BrowserPane'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { SkillsPanel } from './SkillsPanel'
import { RoutinesPanel } from './RoutinesPanel'
import { RoutineRunView } from './RoutineRunView'
import type { Workspace, Routine } from '../../../preload'

const EMPTY_ROUTINES: Routine[] = []
const EMPTY_PORTS: number[] = []

/** Bare hostname (no www.) for a browser project's header title. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function WorkspaceView({
  ws,
  visible = true
}: {
  ws: Workspace
  visible?: boolean
}): React.JSX.Element {
  // Browser projects open with the preview showing by default.
  // A browser project auto-opens its pane — but not on a cold launch, so a fresh
  // start lands on the chat instead of a reloaded (often logged-out) live page.
  const browserOpen = useStore((s) => {
    if (s.browserOpen[ws.id] !== undefined) return s.browserOpen[ws.id]
    // An explicit remembered state — open OR closed — wins for every project
    // kind: what you (or the agent) had on screen comes back after a restart.
    const saved = localStorage.getItem(`paneOpen:${ws.id}`)
    if (saved !== null) return saved === '1'
    // No record: browser projects still default open only after first
    // interaction this run, so a cold start lands on the chat.
    return ws.kind === 'browser' ? !s.coldStart : false
  })
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  const filesOpen = useStore(
    (s) => s.filesOpen[ws.id] ?? localStorage.getItem(`filesOpen:${ws.id}`) === '1'
  )
  // A text file open in the in-app viewer takes the content pane over the browser.
  // undefined = untouched this run (fall back to what was open last run);
  // null = explicitly closed.
  const openFilePath = useStore(
    (s) =>
      s.openFile[ws.id] === undefined
        ? localStorage.getItem(`openFile:${ws.id}`)
        : s.openFile[ws.id]
  )
  const closeFile = useStore((s) => s.closeFile)
  const paneOpen = browserOpen || !!openFilePath
  // Belt-and-suspenders: when neither the browser preview nor a file viewer is
  // open, make sure the pane's native WebContentsView is detached from the window.
  // Otherwise a pane opened transiently (e.g. the agent browsing) can linger,
  // floating over the chat instead of sitting closed.
  useEffect(() => {
    if (!paneOpen) window.cove.browserHide(ws.id)
  }, [paneOpen, ws.id])
  // The project's conversations, and whichever one is on screen.
  const chats = useStore((s) => s.chats[ws.id])
  const activeChatId = useStore((s) => s.activeChatId[ws.id])
  const loadChats = useStore((s) => s.loadChats)
  const activeChat = chats?.find((c) => c.id === activeChatId)
  useEffect(() => {
    loadChats(ws.id)
  }, [ws.id, loadChats])
  const toggleFiles = useStore((s) => s.toggleFiles)
  // Dev servers the agent started (from tool output). Shown as a chip in the
  // toolbar — there's room here, unlike the cramped sidebar row.
  const ports = useStore((s) => s.ports[ws.id] ?? EMPTY_PORTS)
  const openPreview = useStore((s) => s.openPreview)
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
  // For a browser project, the header shows the site you're on, not the generic
  // name + scratch path. Track the live page title/URL.
  const [site, setSite] = useState<{ title: string; url: string }>({
    title: '',
    url: ws.browserUrl ?? ''
  })
  useEffect(() => {
    if (ws.kind !== 'browser') return
    return window.cove.onBrowserState(ws.id, (s) => setSite({ title: s.title, url: s.url }))
  }, [ws.kind, ws.id])

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
    // Cmd+R: reload the page when the browser pane is on screen; otherwise a
    // no-op rather than surprising the user with an app reload.
    const onReload = (): void => {
      if (browserOpen) window.cove.browserReload(ws.id)
    }
    window.addEventListener('cove:menu-skills', onSkills)
    window.addEventListener('cove:menu-routines', onRoutines)
    window.addEventListener('cove:menu-toggle-preview', onToggle)
    window.addEventListener('cove:menu-reload-page', onReload)
    return () => {
      window.removeEventListener('cove:menu-skills', onSkills)
      window.removeEventListener('cove:menu-routines', onRoutines)
      window.removeEventListener('cove:menu-toggle-preview', onToggle)
      window.removeEventListener('cove:menu-reload-page', onReload)
    }
  }, [ws.id, toggleBrowser, visible, browserOpen])

  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => {
    const saved = localStorage.getItem(`split:${ws.id}`)
    // A browser project is mostly the browser — the chat is a slim "tell Claude
    // what to do" column. Code projects split more evenly.
    const fallback = ws.kind === 'browser' ? 0.22 : 0.55
    return saved ? Math.min(0.8, Math.max(0.2, Number(saved))) : fallback
  })
  const [dragging, setDragging] = useState(false)
  // Where the chat sits relative to the pane: beside it (default) or below it,
  // for when a wide page matters more than a tall transcript. Per project.
  const [layout, setLayout] = useState<'side' | 'bottom'>(
    () => (localStorage.getItem(`layout:${ws.id}`) as 'side' | 'bottom') || 'side'
  )
  const toggleLayout = (): void => {
    const next = layout === 'side' ? 'bottom' : 'side'
    localStorage.setItem(`layout:${ws.id}`, next)
    setLayout(next)
    // Each orientation keeps its own split — a good side-by-side ratio makes a
    // terrible chat height and vice versa.
    const saved = localStorage.getItem(next === 'bottom' ? `splitv:${ws.id}` : `split:${ws.id}`)
    setRatio(
      saved
        ? Math.min(0.8, Math.max(0.2, Number(saved)))
        : next === 'bottom'
          ? 0.3
          : ws.kind === 'browser'
            ? 0.22
            : 0.55
    )
  }
  // Width of the file tree, draggable at its right edge and remembered per project.
  const [filesWidth, setFilesWidth] = useState(() => {
    const saved = Number(localStorage.getItem(`filesWidth:${ws.id}`))
    return saved >= 160 && saved <= 560 ? saved : 220
  })
  const onFilesDividerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = filesWidth
      const move = (ev: PointerEvent): void => {
        setFilesWidth(Math.min(560, Math.max(160, startW + (ev.clientX - startX))))
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setFilesWidth((w) => {
          localStorage.setItem(`filesWidth:${ws.id}`, String(w))
          return w
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [ws.id, filesWidth]
  )

  const onDividerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      setDragging(true)
      const container = containerRef.current
      if (!container) return
      const move = (ev: PointerEvent): void => {
        // Measure the pane+chat wrapper (the file tree lives outside it), on
        // whichever axis the layout splits. `ratio` is the chat's share; the
        // chat is the second pane, hence the inversion.
        const wrap = container.querySelector('.split-main')
        if (!wrap) return
        const rect = wrap.getBoundingClientRect()
        const frac =
          layout === 'bottom'
            ? (ev.clientY - rect.top) / rect.height
            : (ev.clientX - rect.left) / rect.width
        if (!Number.isFinite(frac)) return
        setRatio(Math.min(0.8, Math.max(0.2, 1 - frac)))
      }
      const up = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setRatio((r) => {
          localStorage.setItem(layout === 'bottom' ? `splitv:${ws.id}` : `split:${ws.id}`, String(r))
          return r
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [ws.id, layout]
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
        {ws.kind === 'browser' ? (
          <>
            <span className="workspace-title">{site.title || hostOf(site.url) || 'New tab'}</span>
            <span className="workspace-path">{site.url}</span>
          </>
        ) : (
          <>
            <span className="workspace-title">{ws.name}</span>
            <span className="workspace-path">{ws.path}</span>
            {branch && (
              <span className="workspace-branch" title={`On git branch ${branch}`}>
                ⎇ {branch}
              </span>
            )}
          </>
        )}
        {ws.kind !== 'browser' && ports.length > 0 && (
          <button
            className="workspace-server"
            title={`Open localhost:${ports[ports.length - 1]} in the preview`}
            onClick={() => openPreview(ws.id, ports[ports.length - 1])}
          >
            <span className="workspace-server-dot" />
            localhost:{ports[ports.length - 1]}
            <span className="workspace-server-open">Open preview</span>
          </button>
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
        {paneOpen && (
          <button
            className="toolbar-btn"
            onClick={toggleLayout}
            title={
              layout === 'side'
                ? 'Move the chat below the page (full-width preview)'
                : 'Move the chat beside the page'
            }
          >
            {layout === 'side' ? '⬓ Chat below' : '◨ Chat right'}
          </button>
        )}
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
          <div className="files-side" style={{ flexBasis: filesWidth }}>
            <FileTree cwd={ws.path} workspaceId={ws.id} />
            <div className="files-divider" onPointerDown={onFilesDividerDown} />
          </div>
        )}
        {/* Sits between the tree and the chat: a file you click on the left opens
            next to it, rather than across the window. Chat keeps the far side. */}
        <div className={`split-main ${layout === 'bottom' ? 'vert' : ''}`}>
        {paneOpen && (
          <>
            <div className="split-side" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
              {openFilePath ? (
                <FileViewer path={openFilePath} onClose={() => closeFile(ws.id)} />
              ) : (
                <BrowserPane
                  paneId={ws.id}
                  // Browser projects share one session so a manual login carries
                  // across all of them; code previews stay isolated per workspace.
                  partition={ws.kind === 'browser' ? 'persist:browser' : `persist:ws-${ws.id}`}
                  initialUrl={
                    ws.browserUrl ??
                    (ws.kind !== 'browser'
                      ? (localStorage.getItem(`paneUrl:${ws.id}`) ?? undefined)
                      : undefined)
                  }
                  visible={visible}
                  closable={ws.kind !== 'browser'}
                />
              )}
            </div>
            <div
              className={`split-divider ${layout === 'bottom' ? 'horiz' : ''} ${dragging ? 'dragging' : ''}`}
              onPointerDown={onDividerDown}
              role="separator"
            />
          </>
        )}
        <div
          className="split-side split-side-chat"
          style={{ flexBasis: paneOpen ? `${ratio * 100}%` : '100%' }}
        >
          {activeChat && (
            <EasyChat
              // Remount on switch so no state leaks between conversations.
              key={activeChat.id}
              cwd={activeChat.cwd ?? ws.path}
              workspaceId={ws.id}
              chatId={activeChat.id}
              initialSessionId={activeChat.claudeSessionId}
              browserProject={ws.kind === 'browser'}
              isRepo={branch !== null}
              visible={visible}
            />
          )}
          {activeRun && visible && <RoutineRunView routine={activeRun} />}
        </div>
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
