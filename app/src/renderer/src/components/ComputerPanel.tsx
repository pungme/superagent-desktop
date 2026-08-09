import { useCallback, useEffect, useRef, useState } from 'react'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useStore } from '../state'
import { DesktopWindow, WindowRect } from './DesktopWindow'
import { AppId, DESKTOP_APPS, appById } from './desktopApps'
import { DashboardPanel } from './DashboardPanel'
import { EasyChat } from './EasyChat'
import { SkillsPanel } from './SkillsPanel'
import { RoutinesPanel } from './RoutinesPanel'

interface DeskFile {
  path: string
  name: string
}

/** An open window: which app, where it sits, and where it is in the stack. */
interface OpenWindow {
  id: string
  app: AppId
  rect: WindowRect
  z: number
  minimized: boolean
  maximized: boolean
}

const KEY = 'cove.computerFiles'
const WIN_KEY = 'cove.computerWindows'

function load(): DeskFile[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as DeskFile[]) : []
  } catch {
    return []
  }
}

function loadWindows(): OpenWindow[] {
  try {
    const raw = localStorage.getItem(WIN_KEY)
    return raw ? (JSON.parse(raw) as OpenWindow[]) : []
  } catch {
    return []
  }
}

function iconFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(ext)) return '🖼'
  if (['pdf'].includes(ext)) return '📕'
  if (['md', 'txt', 'rtf'].includes(ext)) return '📝'
  if (['zip', 'tar', 'gz', 'dmg'].includes(ext)) return '🗜'
  if (['mov', 'mp4', 'm4v'].includes(ext)) return '🎬'
  if (!ext) return '📁'
  return '📄'
}

/**
 * Your computer: a desktop that holds the things you want to hand, across
 * projects — files you drop, and the app-like views that belong to no single
 * project.
 *
 * Dashboard, Skills and Routines live here as applications in windows you can
 * move, resize and stack, rather than as full-screen sections. They were
 * sections a moment ago; a window is what they actually are — you want to read
 * the dashboard *while* editing a routine, which a section can never allow.
 */
export function ComputerPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [files, setFiles] = useState<DeskFile[]>(load)
  const [over, setOver] = useState(false)
  /** Which menu-bar title is open, if any. */
  const [menu, setMenu] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'kind'>('name')
  const [windows, setWindows] = useState<OpenWindow[]>(loadWindows)
  const [selected, setSelected] = useState<string | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ w: 1200, h: 800 })
  /**
   * The desktop's own chat: a conversation that belongs to no project.
   *
   * It runs in a folder of ours rather than a project, so it starts with no
   * repository, no dev server and nothing to be careful about — a plain chat.
   */
  const [chatHome, setChatHome] = useState<{ workspaceId: string; cwd: string } | null>(null)
  const chats = useStore((s) => (chatHome ? s.chats[chatHome.workspaceId] : undefined))
  const activeChatId = useStore((s) => (chatHome ? s.activeChatId[chatHome.workspaceId] : undefined))
  const loadChats = useStore((s) => s.loadChats)
  const activeWorkspace = useStore((s) => {
    const id = s.activeWorkspaceId
    return id ? s.tree.flatMap((g) => g.workspaces).find((w) => w.id === id) : undefined
  })

  const top = windows.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]
  // Escape peels one layer at a time: a menu, then the front window, then the
  // desktop itself — never closing more than you were looking at.
  useEscapeClose(
    menu
      ? () => setMenu(null)
      : top
        ? () => setWindows((ws) => ws.filter((w) => w.id !== top.id))
        : onClose
  )

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(files))
    // What is on the desktop is what the chat can see: the files are linked
    // into its working directory, so dropping one is all it takes for Claude
    // to be able to read it — no attaching, no pasting a path.
    void window.cove.desktopSyncFiles?.(files.map((f) => f.path))
  }, [files])

  // Prepare the chat's home the first time the desktop is opened.
  useEffect(() => {
    let alive = true
    void window.cove.desktopChatHome?.().then((home) => {
      if (!alive || !home) return
      setChatHome(home)
      void loadChats(home.workspaceId)
    })
    return () => {
      alive = false
    }
  }, [loadChats])
  useEffect(() => {
    localStorage.setItem(WIN_KEY, JSON.stringify(windows))
  }, [windows])

  // The desktop's own size bounds every window, so none can be dragged out of
  // reach or left hanging off the edge when the app window changes size.
  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setBounds({ w: Math.round(r.width), h: Math.round(r.height) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const focus = useCallback((id: string): void => {
    setWindows((ws) => {
      const maxZ = Math.max(0, ...ws.map((w) => w.z))
      const w = ws.find((x) => x.id === id)
      if (!w || w.z === maxZ) return ws
      return ws.map((x) => (x.id === id ? { ...x, z: maxZ + 1 } : x))
    })
  }, [])

  const openApp = useCallback(
    (app: AppId): void => {
      setWindows((ws) => {
        const maxZ = Math.max(0, ...ws.map((w) => w.z))
        const existing = ws.find((w) => w.app === app)
        // Opening something already open brings it forward rather than piling a
        // second copy on top — the same as clicking an app in the Dock.
        if (existing) {
          return ws.map((w) =>
            w.id === existing.id ? { ...w, minimized: false, z: maxZ + 1 } : w
          )
        }
        const { w: iw, h: ih } = appById(app).initial
        const width = Math.min(iw, Math.max(360, bounds.w - 80))
        const height = Math.min(ih, Math.max(260, bounds.h - 80))
        // Cascade, so a second window never lands exactly on the first.
        const step = ws.length * 28
        return [
          ...ws,
          {
            id: `${app}-${Date.now()}`,
            app,
            rect: {
              x: Math.max(20, Math.round((bounds.w - width) / 2) - 60 + step),
              y: Math.max(16, Math.round((bounds.h - height) / 2) - 40 + step),
              w: width,
              h: height
            },
            z: maxZ + 1,
            minimized: false,
            maximized: false
          }
        ]
      })
    },
    [bounds.w, bounds.h]
  )

  // The sidebar's Computer row can ask for a particular app.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const app = (e as CustomEvent<{ app?: AppId }>).detail?.app
      if (app) openApp(app)
    }
    window.addEventListener('cove:open-desktop-app', onOpen)
    return () => window.removeEventListener('cove:open-desktop-app', onOpen)
  }, [openApp])

  const add = useCallback((paths: string[]): void => {
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => f.path))
      const fresh = paths
        .filter((p) => p && !seen.has(p))
        .map((p) => ({ path: p, name: p.split('/').pop() || p }))
      return fresh.length ? [...cur, ...fresh] : cur
    })
  }, [])

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    // Electron gives the real filesystem path via webUtils, not File.path.
    const paths = [...e.dataTransfer.files]
      .map((f) => window.cove.getPathForFile?.(f) ?? '')
      .filter(Boolean)
    add(paths)
  }

  const sorted = [...files].sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name)
      : (a.name.split('.').pop() ?? '').localeCompare(b.name.split('.').pop() ?? '') ||
        a.name.localeCompare(b.name)
  )

  const renderApp = (app: AppId): React.JSX.Element => {
    if (app === 'chat') {
      if (!chatHome || !activeChatId) return <div className="desktop-app-empty">Starting…</div>
      const chat = chats?.find((c) => c.id === activeChatId)
      return (
        <EasyChat
          key={activeChatId}
          cwd={chat?.cwd || chatHome.cwd}
          workspaceId={chatHome.workspaceId}
          chatId={activeChatId}
          initialSessionId={chat?.claudeSessionId ?? null}
        />
      )
    }
    if (app === 'dashboard') return <DashboardPanel embedded onClose={() => {}} />
    if (app === 'skills') {
      return activeWorkspace ? (
        <SkillsPanel
          embedded
          workspaceId={activeWorkspace.id}
          projectPath={activeWorkspace.path}
          onClose={() => {}}
        />
      ) : (
        <div className="desktop-app-empty">Open a project first — skills install into one.</div>
      )
    }
    return activeWorkspace ? (
      <RoutinesPanel embedded ws={activeWorkspace} onClose={() => {}} />
    ) : (
      <div className="desktop-app-empty">Open a project first — routines belong to one.</div>
    )
  }

  return (
    <div
      className={`computer-view ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {/* A menu bar, the way a desktop has one. Click a title to open it;
          clicking anywhere else puts it away. */}
      <div className="computer-menubar" onClick={(e) => e.stopPropagation()}>
        <span className="computer-menu-mark">◉</span>
        <div className="computer-menu">
          <button
            className={`computer-menu-title ${menu === 'file' ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m === 'file' ? null : 'file'))}
          >
            File
          </button>
          {menu === 'file' && (
            <div className="computer-menu-drop">
              <button
                onClick={() => {
                  setMenu(null)
                  setFiles([])
                }}
                disabled={files.length === 0}
              >
                Clear the desktop
              </button>
            </div>
          )}
        </div>
        <div className="computer-menu">
          <button
            className={`computer-menu-title ${menu === 'apps' ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m === 'apps' ? null : 'apps'))}
          >
            Apps
          </button>
          {menu === 'apps' && (
            <div className="computer-menu-drop">
              {DESKTOP_APPS.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    setMenu(null)
                    openApp(a.id)
                  }}
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="computer-menu">
          <button
            className={`computer-menu-title ${menu === 'view' ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m === 'view' ? null : 'view'))}
          >
            View
          </button>
          {menu === 'view' && (
            <div className="computer-menu-drop">
              <button onClick={() => { setSort('name'); setMenu(null) }}>
                {sort === 'name' ? '✓ ' : '  '}Sort by name
              </button>
              <button onClick={() => { setSort('kind'); setMenu(null) }}>
                {sort === 'kind' ? '✓ ' : '  '}Sort by kind
              </button>
            </div>
          )}
        </div>
        <div className="computer-head-spacer" />
        <span className="computer-sub">
          {files.length === 0 ? 'Drop files here' : `${files.length} item${files.length === 1 ? '' : 's'}`}
        </span>
        <button className="computer-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div
        className="computer-surface"
        ref={surfaceRef}
        onClick={() => {
          setMenu(null)
          setSelected(null)
        }}
      >
        <div className="computer-icons">
          {DESKTOP_APPS.map((a) => (
            <button
              key={a.id}
              className={`computer-icon ${selected === a.id ? 'selected' : ''}`}
              title={`Open ${a.name}`}
              onClick={(e) => {
                e.stopPropagation()
                setSelected(a.id)
              }}
              onDoubleClick={() => openApp(a.id)}
            >
              <span className="computer-icon-glyph">{a.icon}</span>
              <span className="computer-icon-name">{a.name}</span>
            </button>
          ))}
          {sorted.map((f) => (
            <button
              key={f.path}
              className={`computer-icon computer-file ${selected === f.path ? 'selected' : ''}`}
              title={f.path}
              onClick={(e) => {
                e.stopPropagation()
                setSelected(f.path)
              }}
              onDoubleClick={() => void window.cove.filesOpenExternal?.(f.path)}
            >
              <span className="computer-file-icon">{iconFor(f.name)}</span>
              <span className="computer-icon-name">{f.name}</span>
              <span
                className="computer-file-x"
                title="Take it off the desktop"
                onClick={(e) => {
                  e.stopPropagation()
                  setFiles((cur) => cur.filter((x) => x.path !== f.path))
                }}
              >
                ✕
              </span>
            </button>
          ))}
        </div>

        {files.length === 0 && windows.length === 0 && (
          <div className="computer-empty">
            Double-click an app to open it, or drag a file in from Finder.
          </div>
        )}

        {windows
          .filter((w) => !w.minimized)
          .map((w) => (
            <DesktopWindow
              key={w.id}
              title={appById(w.app).name}
              icon={<span className="dw-title-icon">{appById(w.app).icon}</span>}
              rect={w.rect}
              z={w.z}
              active={top?.id === w.id}
              maximized={w.maximized}
              bounds={bounds}
              onFocus={() => focus(w.id)}
              onChange={(rect) =>
                setWindows((ws) => ws.map((x) => (x.id === w.id ? { ...x, rect } : x)))
              }
              onClose={() => setWindows((ws) => ws.filter((x) => x.id !== w.id))}
              onMinimize={() =>
                setWindows((ws) => ws.map((x) => (x.id === w.id ? { ...x, minimized: true } : x)))
              }
              onToggleMaximize={() =>
                setWindows((ws) =>
                  ws.map((x) => (x.id === w.id ? { ...x, maximized: !x.maximized } : x))
                )
              }
            >
              {renderApp(w.app)}
            </DesktopWindow>
          ))}
      </div>

      {/* Minimised windows go to a strip along the bottom, which is also the
          only way back to them. */}
      {windows.some((w) => w.minimized) && (
        <div className="computer-dock">
          {windows
            .filter((w) => w.minimized)
            .map((w) => (
              <button
                key={w.id}
                className="computer-dock-item"
                title={`Restore ${appById(w.app).name}`}
                onClick={() => {
                  setWindows((ws) => {
                    const maxZ = Math.max(0, ...ws.map((x) => x.z))
                    return ws.map((x) =>
                      x.id === w.id ? { ...x, minimized: false, z: maxZ + 1 } : x
                    )
                  })
                }}
              >
                <span className="computer-dock-glyph">{appById(w.app).icon}</span>
                {appById(w.app).name}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
