import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../state'
import { EasyChat } from './EasyChat'
import { BrowserPane } from './BrowserPane'
import { SnipOverlay } from './SnipOverlay'
import { SimulatorPane } from './SimulatorPane'
import { BoardPanel } from './BoardPanel'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
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
  // Which surface is open is remembered per CONVERSATION, so two chats in one
  // project can have different setups (one on a webpage, another on nothing).
  // `deskKey` is the workspace's active chat, falling back to the workspace id
  // before a chat is selected. The native browser view + its login session stay
  // keyed by ws.id, so switching chats swaps what's shown, not who you're as.
  const activeChatId = useStore((s) => s.activeChatId[ws.id])
  const deskKey = activeChatId ?? ws.id
  // The native browser view is per CHAT (workspace::chat), so two conversations
  // in one project don't share one pane — chat A can sit on a PDF while chat B is
  // on a website. The partition (login/cookies) stays per workspace, so switching
  // chats swaps the view, not who you're logged in as. workspaceIdFromPane strips
  // the ::chat suffix wherever the workspace is what matters.
  const browserPaneId = activeChatId ? `${ws.id}::${activeChatId}` : ws.id
  // Browser projects open with the preview showing by default.
  // A browser project auto-opens its pane — but not on a cold launch, so a fresh
  // start lands on the chat instead of a reloaded (often logged-out) live page.
  const browserOpen = useStore((s) => {
    if (s.browserOpen[deskKey] !== undefined) return s.browserOpen[deskKey]
    // An explicit remembered state — open OR closed — wins for every project
    // kind: what you (or the agent) had on screen comes back after a restart.
    const saved = localStorage.getItem(`paneOpen:${deskKey}`)
    if (saved !== null) return saved === '1'
    // No record: browser projects still default open only after first
    // interaction this run, so a cold start lands on the chat.
    return ws.kind === 'browser' ? !s.coldStart : false
  })
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  const filesOpen = useStore(
    (s) => s.filesOpen[deskKey] ?? localStorage.getItem(`filesOpen:${deskKey}`) === '1'
  )
  // A text file open in the in-app viewer takes the content pane over the browser.
  // undefined = untouched this run (fall back to what was open last run);
  // null = explicitly closed.
  const openFilePath = useStore((s) =>
    s.openFile[deskKey] === undefined
      ? localStorage.getItem(`openFile:${deskKey}`)
      : s.openFile[deskKey]
  )
  const closeFile = useStore((s) => s.closeFile)
  // The simulator is a card on the desk, not a replacement for what's already
  // there: open it next to the page or the file you're working on, which is how
  // you actually build an iOS app. Remembered per project.
  const [simOpen, setSimOpen] = useState(() => localStorage.getItem(`simOpen:${deskKey}`) === '1')
  /** The working surface's share of the desk when the simulator sits beside it. */
  const [deskRatio, setDeskRatio] = useState(() => {
    const saved = Number(localStorage.getItem(`desk:${ws.id}`))
    return Number.isFinite(saved) && saved > 0.2 && saved < 0.85 ? saved : 0.62
  })
  // Remembered like the other surfaces: leaving the board up and restarting
  // should put you back on the board, not silently on the chat.
  const [boardOpen, setBoardOpen] = useState(
    () => localStorage.getItem(`boardOpen:${deskKey}`) === '1'
  )
  // WorkspaceView stays mounted while you switch chats, so the local surface
  // state (sim/board) has to be re-seeded from the chat you moved to — otherwise
  // it would keep showing the previous conversation's setup. React's "adjust
  // state during render when a key changes" pattern: no effect, no flash.
  const [seededKey, setSeededKey] = useState(deskKey)
  if (seededKey !== deskKey) {
    // The agent can open the sim (or board) before activeChatId has resolved, so
    // it lands keyed to the workspace id; a beat later the key becomes the chat
    // id and this re-seed ran — reading an empty value and closing it, so it
    // flashed open then vanished. Carry an open pane across THAT first
    // workspace→chat resolution only. A real chat→chat switch still reads the new
    // chat's own state (per-chat isolation preserved), and an explicit saved
    // value for the new key always wins.
    const fromWorkspace = seededKey === ws.id
    const reseed = (kind: 'simOpen' | 'boardOpen', cur: boolean): boolean => {
      const saved = localStorage.getItem(`${kind}:${deskKey}`)
      if (saved !== null) return saved === '1'
      if (fromWorkspace && cur) {
        localStorage.setItem(`${kind}:${deskKey}`, '1')
        return true
      }
      return false
    }
    setSeededKey(deskKey)
    setSimOpen(reseed('simOpen', simOpen))
    setBoardOpen(reseed('boardOpen', boardOpen))
  }
  /**
   * Four columns need about 620px to be worth looking at, and the pane half is
   * usually narrower than that. Opening the board widens it just enough —
   * never narrows it, and never past two thirds, so the chat stays usable and
   * the divider you drag afterwards wins.
   */

  // The desk's working surface: a file you opened wins over the page, and a
  // code project with neither simply has no surface — the simulator gets the
  // whole desk.
  const surface = boardOpen ? (
    <BoardPanel
      workspaceId={ws.id}
      onClose={() => {
        localStorage.setItem(`boardOpen:${deskKey}`, '0')
        setBoardOpen(false)
      }}
    />
  ) : openFilePath ? (
    <FileViewer path={openFilePath} cwd={ws.path} onClose={() => closeFile(ws.id)} />
  ) : browserOpen ? (
    <BrowserPane
      paneId={browserPaneId}
      workspaceId={ws.id}
      // Browser projects share one session so a manual login carries across all
      // of them; code previews stay isolated per workspace (but per-chat views).
      partition={ws.kind === 'browser' ? 'persist:browser' : `persist:ws-${ws.id}`}
      initialUrl={
        ws.browserUrl ??
        (ws.kind !== 'browser'
          ? // Per-chat view, so restore THIS chat's last page (the pane writes
            // paneUrl:<workspace::chat>); falls back to undefined for a fresh chat.
            (localStorage.getItem(`paneUrl:${browserPaneId}`) ?? undefined)
          : undefined)
      }
      visible={visible}
      closable={ws.kind !== 'browser'}
    />
  ) : null

  const paneOpen = browserOpen || !!openFilePath || simOpen || boardOpen

  // Snip-to-attach: freeze the current pane surface to a still, let the user drag
  // a region out of it, and drop that crop straight into the chat composer.
  const enterOverlay = useStore((s) => s.enterOverlay)
  const exitOverlay = useStore((s) => s.exitOverlay)
  const [snipStill, setSnipStill] = useState<string | null>(null)
  const snipObjectUrl = useRef<string | null>(null)
  // Snippable surfaces: the (native) browser page or the simulator. A board or
  // text file is plain HTML — an ordinary screenshot already works there.
  const canSnip = (browserOpen && !boardOpen && !openFilePath) || simOpen
  const startSnip = async (): Promise<void> => {
    let still: string | null = null
    if (browserOpen && !boardOpen && !openFilePath) {
      const bytes = await window.cove.browserFreeze(browserPaneId)
      if (bytes && bytes.length) {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
        snipObjectUrl.current = url
        still = url
      }
    } else if (simOpen) {
      const udid = localStorage.getItem(`cove.simDevice:${ws.id}`)
      if (udid) still = await window.cove.simScreenshot(udid)
    }
    if (!still) return
    // Detach the native browser view so the HTML snip overlay shows over it (the
    // simulator is HTML already). exitOverlay in finishSnip re-attaches it.
    enterOverlay()
    setSnipStill(still)
  }
  const finishSnip = (): void => {
    setSnipStill(null)
    exitOverlay()
    if (snipObjectUrl.current) {
      URL.revokeObjectURL(snipObjectUrl.current)
      snipObjectUrl.current = null
    }
  }

  // The board and a file preview share the one working surface, and the board
  // was drawn on top — so clicking a file while the board was open did nothing
  // visible until you closed the board. Opening a *new* file now steps the board
  // aside so the file shows straight away. Keyed on the path changing, not on
  // boardOpen, so opening the board over an already-open file doesn't instantly
  // dismiss itself.
  const lastFile = useRef(openFilePath)
  useEffect(() => {
    if (openFilePath && openFilePath !== lastFile.current && boardOpen) {
      localStorage.setItem(`boardOpen:${deskKey}`, '0')
      setBoardOpen(false)
    }
    lastFile.current = openFilePath
  }, [openFilePath, boardOpen, deskKey])

  // No manual toggle, same as the browser: the pane appears when the agent
  // boots or launches something on a simulator, and closes from its own ✕.
  useEffect(() => {
    return window.cove.onOpenSimulator?.((p) => {
      if (p.workspaceId !== ws.id) return
      // Claim the device the agent just launched onto BEFORE opening the pane.
      // SimulatorPane mounts in response to this open and only then subscribes to
      // onOpenSimulator — too late to catch this very event — so it relies on the
      // stored claim. Without it, its mount check finds nothing booted for this
      // project and calls onNothingToShow(), closing the pane it just opened:
      // the "flash then vanish".
      if (p.udid) localStorage.setItem(`cove.simDevice:${ws.id}`, p.udid)
      // deskKey in deps so an agent reveal lands on the chat you're actually on,
      // not the one that was active when this listener first subscribed.
      localStorage.setItem(`simOpen:${deskKey}`, '1')
      setSimOpen(true)
    })
  }, [ws.id, deskKey])
  // Belt-and-suspenders: when neither the browser preview nor a file viewer is
  // open, make sure the pane's native WebContentsView is detached from the window.
  // Otherwise a pane opened transiently (e.g. the agent browsing) can linger,
  // floating over the chat instead of sitting closed.
  useEffect(() => {
    if (!paneOpen) window.cove.browserHide(browserPaneId)
  }, [paneOpen, browserPaneId])
  // The project's conversations, and whichever one is on screen (activeChatId is
  // read up top, where it drives deskKey).
  const chats = useStore((s) => s.chats[ws.id])
  const loadChats = useStore((s) => s.loadChats)
  // A chat with a turn (or a background command) in flight has to keep its
  // `claude` process alive even when you switch to a sibling — its agent lives
  // inside the mounted <EasyChat>, so unmounting it on switch would kill the
  // work mid-stream. Keep the on-screen chat mounted plus any that's still busy.
  const busy = useStore((s) => s.busy)
  // Keep the last few chats you were in mounted, not just the active one. The
  // agent can leave background work running (builders, a long shell) that the app
  // can't always see as "busy" — and unmounting a chat kills its claude process
  // (and that work) instantly. Holding a small window of recent chats means
  // switching away doesn't nuke a session the moment you look elsewhere. Bounded
  // to a few, so this can't leak sessions. (React's adjust-state-in-render idiom
  // — no effect.)
  const [recentChats, setRecentChats] = useState<string[]>(() =>
    activeChatId ? [activeChatId] : []
  )
  if (activeChatId && recentChats[0] !== activeChatId) {
    setRecentChats([activeChatId, ...recentChats.filter((id) => id !== activeChatId)].slice(0, 3))
  }
  const mountedChats = (chats ?? []).filter(
    (c) =>
      c.id === activeChatId ||
      recentChats.includes(c.id) ||
      busy[c.id]?.generating ||
      (busy[c.id]?.background ?? 0) > 0
  )
  useEffect(() => {
    loadChats(ws.id)
  }, [ws.id, loadChats])
  const toggleFiles = useStore((s) => s.toggleFiles)
  // Dev servers the agent started (from tool output). Shown as a chip in the
  // toolbar — there's room here, unlike the cramped sidebar row.
  const ports = useStore((s) => s.ports[ws.id] ?? EMPTY_PORTS)
  const openPreview = useStore((s) => s.openPreview)
  /** The page this project currently has on its pane, whoever opened it. */
  const attachedUrl = useStore((s) => s.pageUrl[ws.id] ?? '')
  // The URL we last asked the pane to load — synchronous, so it's right even
  // before the pane reports back. Used to tell a document (a PDF/image opened
  // from the tree, file://) apart from a live web/localhost preview.
  const paneUrl = useStore((s) => s.previewUrls[browserPaneId] ?? '')
  // When the pane is showing a local document (a PDF/image opened from the tree),
  // its file name — so the toolbar names what you're looking at instead of a bare
  // "page". Empty for a real web/localhost page.
  const docName = ((): string => {
    const u = attachedUrl || paneUrl
    if (!u.startsWith('file:')) return ''
    try {
      return decodeURIComponent(u.split(/[?#]/)[0].split('/').pop() || '')
    } catch {
      return ''
    }
  })()
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
    // These are full sections now, owned by the app rather than this project.
    const onSkills = (): void => {
      window.dispatchEvent(new CustomEvent('cove:open-skills'))
    }
    const onRoutines = (): void => {
      window.dispatchEvent(new CustomEvent('cove:open-routines'))
    }
    const onToggle = (): void => toggleBrowser(ws.id, browserOpen)
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

  const widenForBoard = useCallback((): void => {
    const wrap = containerRef.current?.querySelector('.split-main')
    const total = wrap?.getBoundingClientRect().width ?? 0
    if (!total) return
    setRatio((r) => {
      const paneNow = total * (1 - r)
      if (paneNow >= 620) return r
      const next = Math.max(0.2, Math.min(r, 1 - Math.min(620, total * 0.66) / total))
      localStorage.setItem(`split:${ws.id}`, String(next))
      return next
    })
  }, [ws.id])
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

  const onDeskDividerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      setDragging(true)
      const move = (ev: PointerEvent): void => {
        const desk = containerRef.current?.querySelector('.desk')
        if (!desk) return
        const rect = desk.getBoundingClientRect()
        const frac = (ev.clientX - rect.left) / rect.width
        if (!Number.isFinite(frac)) return
        setDeskRatio(Math.min(0.85, Math.max(0.25, frac)))
      }
      const up = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setDeskRatio((r) => {
          localStorage.setItem(`desk:${ws.id}`, String(r))
          return r
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [ws.id]
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
          localStorage.setItem(
            layout === 'bottom' ? `splitv:${ws.id}` : `split:${ws.id}`,
            String(r)
          )
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
        {/* Sits next to Files, top-left: both open a left-hand surface for this
            project, so they read as a pair. */}
        <button
          className={`toolbar-btn ${boardOpen ? 'on' : ''}`}
          onClick={() =>
            setBoardOpen((v) => {
              if (!v) widenForBoard()
              localStorage.setItem(`boardOpen:${deskKey}`, v ? '0' : '1')
              return !v
            })
          }
          title="This project's to-do — what's left, and what Claude finished"
        >
          ▤ Todo
        </button>
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
        {/* A site attached to this project that is not one of our dev servers —
            the chip was only ever about localhost, so a project sitting on a
            real site said nothing at all up here. */}
        {/* Showing a local document (PDF/image): name the file so you know what's
            in the pane, not a bare "page". Shown regardless of a dev server. */}
        {ws.kind !== 'browser' && docName && (
          <span className="workspace-server attached workspace-doc" title={docName}>
            <span className="workspace-doc-icon">📄</span>
            <span className="workspace-doc-name">{docName}</span>
          </span>
        )}
        {ws.kind !== 'browser' && !docName && ports.length === 0 && attachedUrl && (
          <span className="workspace-server attached" title={attachedUrl}>
            <span className="workspace-server-dot" />
            {hostOf(attachedUrl) || 'page'}
          </span>
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
        {/* Snip a region of the page/simulator straight into the composer. Lives
            in the toolbar, not floating over the pane, because the native view
            paints above HTML and would cover (and swallow the click on) anything
            floating on top of it. */}
        {canSnip && (
          <button
            className="toolbar-btn workspace-snip"
            onClick={startSnip}
            title="Snip a region into your message"
          >
            ✂ Snip
          </button>
        )}
        {/* A code project's preview reveals itself when the agent navigates, and
            normally closes from the pane's own ✕. But the native page paints
            ABOVE all HTML, so a mis-bounded agent-opened view can cover its own
            toolbar — leaving no way to close it. This close lives up here in the
            workspace toolbar, which the native view can never reach, so there is
            always a way out. Shown only when the browser is the visible surface. */}
        {ws.kind !== 'browser' &&
          browserOpen &&
          !openFilePath &&
          !boardOpen &&
          (() => {
            // A PDF or image opened from the file tree shows in this same pane
            // (file://), but Chromium's document viewer has no close of its own —
            // so the only way out is this button. "Hide preview" read as dev-
            // server language and nobody connected it to their open document, so
            // for a local file it says "Close" with an ✕ instead.
            const isDoc = (attachedUrl || paneUrl).startsWith('file:')
            return (
              <button
                className="toolbar-btn on"
                onClick={() => toggleBrowser(ws.id, true)}
                title={isDoc ? 'Close this document' : 'Close the preview pane'}
              >
                {isDoc ? '✕ Close' : 'Hide preview'}
              </button>
            )
          })()}
        {ws.kind === 'browser' && (
          <button
            className={`toolbar-btn ${browserOpen ? 'on' : ''}`}
            onClick={() => toggleBrowser(ws.id, browserOpen)}
          >
            {browserOpen ? 'Hide preview' : 'Show preview'}
          </button>
        )}
        {/* Where the chat sits is a view control, so it belongs here with the
            others rather than among the New chat pills. The glyph shows the
            arrangement you would move to; no label, it is not worth a word. */}
        {paneOpen && (
          <button
            className="toolbar-btn toolbar-icon"
            onClick={toggleLayout}
            title={
              layout === 'side'
                ? 'Move the chat below the page (full-width preview)'
                : 'Move the chat beside the page'
            }
          >
            {layout === 'side' ? '⬓' : '◨'}
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
              {/* The desk. One card is the working surface — the page you're on or
                the file you opened — and the simulator is a second card beside
                it rather than something that pushes the first one out. The
                painting behind them shows wherever a card doesn't reach. */}
              <div className="split-side desk" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
                {surface && (
                  <div
                    className="desk-card"
                    style={{ flexBasis: simOpen && !boardOpen ? `${deskRatio * 100}%` : '100%' }}
                  >
                    {surface}
                  </div>
                )}
                {surface && simOpen && !boardOpen && (
                  <div
                    className={`desk-divider ${dragging ? 'dragging' : ''}`}
                    onPointerDown={onDeskDividerDown}
                    role="separator"
                  />
                )}
                {/* The list takes the whole desk while it's open. Sharing it with
                  the simulator squeezed the list to ~200px, which is too narrow
                  to read an item in, let alone open one. */}
                {simOpen && !boardOpen && (
                  <div
                    className="desk-card desk-card-sim"
                    style={{ flexBasis: surface ? `${(1 - deskRatio) * 100}%` : '100%' }}
                  >
                    <SimulatorPane
                      visible={visible}
                      workspaceId={ws.id}
                      onClose={() => {
                        localStorage.setItem(`simOpen:${deskKey}`, '0')
                        setSimOpen(false)
                      }}
                      // No simulator of this project's own: forget that it ever
                      // had a pane rather than reopening it on every visit.
                      onNothingToShow={() => {
                        localStorage.setItem(`simOpen:${deskKey}`, '0')
                        setSimOpen(false)
                      }}
                    />
                  </div>
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
            {/* Each chat keeps its own mounted <EasyChat> (and its agent). Only the
              active one is shown; busy siblings stay mounted but hidden so their
              turn keeps streaming. Stable key per chat → switching never remounts,
              so it never tears down a running session. */}
            {mountedChats.map((c) => {
              const onScreen = c.id === activeChatId
              return (
                <div
                  key={c.id}
                  className="chat-mount"
                  style={{ display: onScreen ? 'flex' : 'none' }}
                >
                  <EasyChat
                    cwd={c.cwd ?? ws.path}
                    workspaceId={ws.id}
                    chatId={c.id}
                    initialSessionId={c.claudeSessionId}
                    browserProject={ws.kind === 'browser'}
                    isRepo={branch !== null}
                    visible={visible && onScreen}
                  />
                </div>
              )
            })}
            {activeRun && visible && <RoutineRunView routine={activeRun} />}
          </div>
        </div>
      </div>
      {/* Gated on `visible` too: a hidden workspace must not keep a slide-over
          mounted, or its overlay lock would blank the active workspace's preview. */}
      {snipStill && (
        <SnipOverlay
          still={snipStill}
          onCancel={finishSnip}
          onCapture={(dataUrl) => {
            // Hand the crop to the active chat's composer (it listens and focuses).
            window.dispatchEvent(new CustomEvent('cove:attach-image', { detail: { url: dataUrl } }))
            finishSnip()
          }}
        />
      )}
    </div>
  )
}
