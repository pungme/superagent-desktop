import { useCallback, useEffect, useRef, useState } from 'react'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useStore } from '../state'
import { DesktopWindow, WindowRect } from './DesktopWindow'
import { AppId, DESKTOP_APPS, appById } from './desktopApps'
import { DashboardPanel } from './DashboardPanel'
import { DesktopChat } from './DesktopChat'
import { DesktopBrowser } from './DesktopBrowser'
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

  const add = useCallback((paths: string[]): void => {
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => f.path))
      const fresh = paths
        .filter((p) => p && !seen.has(p))
        .map((p) => ({ path: p, name: p.split('/').pop() || p }))
      return fresh.length ? [...cur, ...fresh] : cur
    })
  }, [])

  /**
   * Tell the main process what the desktop looks like.
   *
   * The desktop chat's agent runs out there, and "which window is in front" is
   * something only this component knows. Reporting on every change keeps the
   * computer_state tool honest without it having to ask the renderer and wait.
   */
  const reportedRef = useRef('')
  useEffect(() => {
    const snapshot = {
      windows: windows.map((w) => {
        const r = clampToDesk(w.rect)
        return {
          app: w.app,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          minimized: w.minimized,
          maximized: w.maximized,
          focused: top?.id === w.id
        }
      }),
      files: files.map((f) => ({ name: f.name, path: f.path })),
      bounds,
      open: true
    }
    // Dragging a window renders on every pointer move; sending an identical
    // snapshot down the wire sixty times a second helps nobody.
    const key = JSON.stringify(snapshot)
    if (key === reportedRef.current) return
    reportedRef.current = key
    window.cove.desktopReport?.(snapshot)
  })
  // Closing the Computer takes the desktop off screen; the agent should not go
  // on describing windows that are not there.
  useEffect(() => () => window.cove.desktopGone?.(), [])

  /** The agent driving the desktop: open, close, arrange, put a file on it. */
  useEffect(() => {
    return window.cove.onDesktopCommand?.((c) => {
      const app = c.app as AppId | undefined
      if (c.kind === 'open' && app) openApp(app)
      if (c.kind === 'browser') {
        openApp('browser')
        // The Browser app has to be mounted before it can be told where to go.
        setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent('cove:desktop-browser-open', {
                detail: { url: c.url, newTab: c.newTab }
              })
            ),
          80
        )
      }
      if (c.kind === 'close' && app) setWindows((ws) => ws.filter((w) => w.app !== app))
      if (c.kind === 'add-file' && c.path) add([c.path])
      if (c.kind === 'remove-file' && c.path)
        setFiles((cur) => cur.filter((f) => f.path !== c.path))
      if (c.kind === 'arrange' && app) {
        setWindows((ws) => {
          const maxZ = Math.max(0, ...ws.map((w) => w.z))
          return ws.map((w) => {
            if (w.app !== app) return w
            const half = { w: Math.round(bounds.w / 2), h: Math.round(bounds.h / 2) }
            const preset: Record<string, WindowRect> = {
              left: { x: 0, y: 0, w: half.w, h: bounds.h },
              right: { x: half.w, y: 0, w: bounds.w - half.w, h: bounds.h },
              top: { x: 0, y: 0, w: bounds.w, h: half.h },
              bottom: { x: 0, y: half.h, w: bounds.w, h: bounds.h - half.h },
              center: {
                x: Math.round((bounds.w - w.rect.w) / 2),
                y: Math.round((bounds.h - w.rect.h) / 2),
                w: w.rect.w,
                h: w.rect.h
              }
            }
            if (c.position === 'minimize') return { ...w, minimized: true }
            if (c.position === 'full') return { ...w, minimized: false, maximized: true, z: maxZ + 1 }
            const rect =
              (c.position && preset[c.position]) ||
              // An explicit rectangle: whatever it does not say keeps its
              // current value, so "make it wider" need not restate the origin.
              ({
                x: c.x ?? w.rect.x,
                y: c.y ?? w.rect.y,
                w: c.width ?? w.rect.w,
                h: c.height ?? w.rect.h
              } as WindowRect)
            return { ...w, rect, minimized: false, maximized: false, z: maxZ + 1 }
          })
        })
      }
    })
  }, [openApp, add, bounds.w, bounds.h])

  // The sidebar's Computer row can ask for a particular app.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const app = (e as CustomEvent<{ app?: AppId }>).detail?.app
      if (app) openApp(app)
    }
    window.addEventListener('cove:open-desktop-app', onOpen)
    return () => window.removeEventListener('cove:open-desktop-app', onOpen)
  }, [openApp])

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

  /**
   * Keep a window inside the desktop it is being drawn on.
   *
   * Geometry is remembered, so a window saved on a large desktop could come
   * back onto a small one — 900x620 at (700,420) on a 421x448 desktop, with its
   * title bar off the edge and no way to drag it back. The drag itself clamps,
   * but nothing did on restore or when the app window shrank. Clamping here
   * rather than rewriting the stored rect means growing the window back returns
   * it to the size you left it at.
   */
  const clampToDesk = (r: WindowRect): WindowRect => {
    const w = Math.min(r.w, Math.max(320, bounds.w - 16))
    const h = Math.min(r.h, Math.max(220, bounds.h - 16))
    return {
      w,
      h,
      x: Math.min(Math.max(r.x, -w + 90), Math.max(0, bounds.w - 90)),
      y: Math.min(Math.max(r.y, 0), Math.max(0, bounds.h - 34))
    }
  }

  /**
   * Is anything stacked on top of this window?
   *
   * Only the Browser cares, and it cares a great deal: its page is a real
   * Chromium view, a native layer that paints above every piece of HTML in the
   * app. Stack the Chat window over it and the page carries on covering the
   * chat — the window is in front by every rule the DOM knows and behind by the
   * only one the screen obeys. So the browser is told when it is covered, and
   * stands its page down in favour of a still of itself.
   *
   * An open menu counts too: the drop-down is HTML, and the desktop's menu bar
   * sits exactly where a window's top-left corner tends to be.
   */
  const coveredBy = (win: OpenWindow): boolean => {
    if (menu) return true
    const rect = (w: OpenWindow): WindowRect =>
      w.maximized ? { x: 0, y: 0, w: bounds.w, h: bounds.h } : clampToDesk(w.rect)
    const a = rect(win)
    return windows.some((o) => {
      if (o.id === win.id || o.minimized || o.z <= win.z) return false
      const b = rect(o)
      return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    })
  }

  const renderApp = (win: OpenWindow): React.JSX.Element => {
    const app = win.app
    if (app === 'chat') {
      if (!chatHome) return <div className="desktop-app-empty">Starting…</div>
      return <DesktopChat workspaceId={chatHome.workspaceId} cwd={chatHome.cwd} />
    }
    if (app === 'browser') {
      const r = win.maximized ? { x: 0, y: 0, w: bounds.w, h: bounds.h } : clampToDesk(win.rect)
      return (
        <DesktopBrowser
          occluded={coveredBy(win)}
          // Moving a window does not resize its contents, so nothing else tells
          // the native view its coordinates changed.
          positionKey={`${r.x},${r.y},${r.w},${r.h}`}
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
        {/* The app's own mark, the same rounded square the splash uses — a
            desktop's top-left corner is where you look to know whose it is. */}
        <span className="computer-brand" title="SuperAgent">
          <span className="computer-brand-mark">
            <span className="computer-brand-inner" />
          </span>
          SuperAgent
        </span>
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
        onClick={() => {
          setMenu(null)
          setSelected(null)
        }}
      >
        <div className="computer-icons">
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
            Open an app from the dock, or drag a file in from Finder.
          </div>
        )}

        <div className="computer-windows" ref={surfaceRef}>
          {windows
            .filter((w) => !w.minimized)
            .map((w) => (
            <DesktopWindow
              key={w.id}
              title={appById(w.app).name}
              icon={<span className="dw-title-icon">{appById(w.app).icon}</span>}
              rect={clampToDesk(w.rect)}
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
              {renderApp(w)}
            </DesktopWindow>
            ))}
        </div>
      </div>

      {/* The dock: every app, always there, with a light under the ones that
          are open — the way a desktop tells you what is running without you
          having to go looking for the window. */}
      <div className="dock">
        <div className="dock-inner">
          {DESKTOP_APPS.map((a) => {
            const win = windows.find((w) => w.app === a.id)
            return (
              <button
                key={a.id}
                className={`dock-app ${win ? 'open' : ''} ${win?.minimized ? 'hidden' : ''}`}
                title={win ? (win.minimized ? `${a.name} — minimised` : a.name) : `Open ${a.name}`}
                onClick={() => openApp(a.id)}
              >
                <span className="dock-glyph">{a.icon}</span>
                <span className="dock-name">{a.name}</span>
                <span className="dock-light" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
