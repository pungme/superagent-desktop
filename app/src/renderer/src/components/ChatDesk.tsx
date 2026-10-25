import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useStore } from '../state'
import { EasyChat } from './EasyChat'
import { BrowserTabs } from './BrowserTabs'
import { ExternalBrowserPane } from './ExternalBrowserPane'
import { useChatBrowser } from '../hooks/useChatBrowser'
import { SimulatorPane } from './SimulatorPane'
import { BoardPanel } from './BoardPanel'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { RoutineRunView } from './RoutineRunView'
import { BranchMenu } from './BranchMenu'
import type { Workspace, Routine } from '../../../preload'
import { onGripPointerDown } from '../lib/split-drag'
import { ProjectIcon } from './ProjectIcon'
import { useProjectIcon } from '../hooks/useProjectIcon'

const EXTERNAL_NAMES: Record<string, string> = { brave: 'Brave', chrome: 'Chrome', edge: 'Edge' }

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

/** Where a desk sits when several conversations share the window (split view). */
export interface DeskTile {
  index: number
  count: number
  rect: { x: number; y: number; w: number; h: number }
  focused: boolean
  zoomed: boolean
  orient: 'row' | 'col'
}

/**
 * One conversation's desk: its toolbar, its chat, and the panes beside it (the
 * page, a file, the simulator, the board). The project view keeps one of these
 * per mounted conversation in a stable keyed list, so a chat — and the agent
 * living inside its <EasyChat> — is never remounted when it moves on screen,
 * off screen, or between the windows of a split.
 *
 * `visible`: on screen. `focused`: the one keys and menu actions go to (the
 * focused window of a split; the only one otherwise). `hidden`: mounted but not
 * shown — a busy or recent conversation keeping its agent alive.
 */
export function ChatDesk({
  ws,
  chatId,
  visible = true,
  focused = visible,
  hidden = false,
  tile,
  plain = false
}: {
  ws: Workspace
  chatId?: string
  visible?: boolean
  focused?: boolean
  hidden?: boolean
  tile?: DeskTile
  /** A conversation that belongs to no project (Chats): no project toolbar when it fills the page. */
  plain?: boolean
}): React.JSX.Element {
  // Which surface is open is remembered per CONVERSATION, so two chats in one
  // project can have different setups (one on a webpage, another on nothing).
  // `deskKey` is the workspace's active chat, falling back to the workspace id
  // before a chat is selected. The native browser view + its login session stay
  // keyed by ws.id, so switching chats swaps what's shown, not who you're as.
  const activeChatId = chatId
  // Where the conversation on screen actually works. A chat on its own worktree
  // writes there and nowhere else, so Files rooted on the project showed main
  // and hid everything the agent had just made.
  const chatCwd = useStore((s) => {
    const id = chatId
    if (!id) return null
    return s.chats[ws.id]?.find((c) => c.id === id)?.cwd ?? null
  })
  const filesRoot = chatCwd ?? ws.path
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
  // The localStorage fallbacks are read ONCE per desk, not inside the selectors:
  // selectors run on every store update, and a synchronous storage read per
  // update per mounted workspace added up. The fallback only matters while the
  // store has no entry ("untouched this run"), which is exactly when the stored
  // value can't have changed either.
  const savedDesk = useMemo(
    () => ({
      paneOpen: localStorage.getItem(`paneOpen:${deskKey}`),
      filesOpen: localStorage.getItem(`filesOpen:${deskKey}`) === '1',
      openFile: localStorage.getItem(`openFile:${deskKey}`)
    }),
    [deskKey]
  )
  const browserOpen = useStore((s) => {
    if (s.browserOpen[deskKey] !== undefined) return s.browserOpen[deskKey]
    // An explicit remembered state — open OR closed — wins for every project
    // kind: what you (or the agent) had on screen comes back after a restart.
    if (savedDesk.paneOpen !== null) return savedDesk.paneOpen === '1'
    // No record: browser projects still default open only after first
    // interaction this run, so a cold start lands on the chat.
    return ws.kind === 'browser' ? !s.coldStart : false
  })
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  // The agent may browse in the user's real browser for this project; the pane
  // then streams that tab instead of hosting a page itself.
  // The browser of the conversation on screen, not the project's.
  const projectBrowser = useChatBrowser(ws.id, activeChatId)
  const external = ws.kind !== 'browser' && projectBrowser !== 'builtin'
  const filesOpen = useStore((s) => s.filesOpen[deskKey] ?? savedDesk.filesOpen)
  // A text file open in the in-app viewer takes the content pane over the browser.
  // undefined = untouched this run (fall back to what was open last run);
  // null = explicitly closed.
  const openFilePath = useStore((s) =>
    s.openFile[deskKey] === undefined ? savedDesk.openFile : s.openFile[deskKey]
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
  // A window of a split too narrow for a pane beside the chat (see MiniPane).
  const miniWanted = !!tile && tile.count > 1 && tile.rect.w < MINI_BELOW && !hidden
  const surface = boardOpen ? (
    <BoardPanel
      workspaceId={ws.id}
      onClose={() => {
        localStorage.setItem(`boardOpen:${deskKey}`, '0')
        setBoardOpen(false)
      }}
    />
  ) : openFilePath ? (
    <FileViewer path={openFilePath} cwd={filesRoot} onClose={() => closeFile(ws.id, chatId)} />
  ) : browserOpen && external ? (
    <ExternalBrowserPane
      paneId={browserPaneId}
      browserName={EXTERNAL_NAMES[projectBrowser] ?? projectBrowser}
      visible={visible}
      onClose={() => toggleBrowser(ws.id, true, chatId)}
    />
  ) : browserOpen ? (
    <BrowserTabs
      basePaneId={browserPaneId}
      workspaceId={ws.id}
      // One session for the whole app, so a manual login carries everywhere —
      // main derives the same constant in partitionFor (util.ts). This used to
      // branch on ws.kind and had to agree with main's copy of the rule exactly.
      partition="persist:browser"
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
      mini={miniWanted}
    />
  ) : null

  const paneOpen = browserOpen || !!openFilePath || simOpen || boardOpen
  // A window of a split too narrow for the pane beside the chat: the page or
  // simulator becomes a mini inside this window instead (MiniPane), the page
  // scaled from desktop width. ⤢ makes the window full size, where it docks.
  const mini = miniWanted && paneOpen
  const [miniShows, setMiniShows] = useState<'surface' | 'sim'>('sim')

  // Snip-to-attach lives on the panes themselves now: the browser and the
  // simulator each freeze in place and draw the selection right on their own
  // picture (BrowserPane / SimulatorPane), then hand the crop to the composer.
  // The ✂ button on each pane dispatches cove:start-snip with its source; ⌘⇧S
  // does the same for whichever pane is on screen.
  const enterOverlay = useStore((s) => s.enterOverlay)
  const exitOverlay = useStore((s) => s.exitOverlay)
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey && e.key.toLowerCase() === 's') {
        const source: 'browser' | 'sim' | null =
          // Snip draws on the built-in pane; a live view of an external browser has none.
          browserOpen && !external && !boardOpen && !openFilePath
            ? 'browser'
            : simOpen
              ? 'sim'
              : null
        if (!source) return
        e.preventDefault()
        window.dispatchEvent(
          new CustomEvent('cove:start-snip', { detail: { workspaceId: ws.id, source } })
        )
        return
      }
      // The command palette's two "current chat" actions, given real chords
      // too — the palette is how you discover these, not the only way to
      // reach them. Undecorated (no Shift), so they can't collide with ⌘⇧S.
      if (e.shiftKey) return
      if (e.key.toLowerCase() === 'j') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('cove:command-focus-composer'))
      } else if (e.key === '.') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('cove:command-stop-agent'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, browserOpen, external, boardOpen, openFilePath, simOpen, ws.id])

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
      // Open on the chat that ASKED (p.chatId), not whichever chat is on screen
      // when this async reveal lands — a background chat booting a simulator used
      // to pop it open over the conversation you'd switched to. Fall back to the
      // active desk for the desktop agent / legacy events with no chat.
      const targetDesk = p.chatId ?? deskKey
      // Claim the device the agent just launched onto BEFORE opening the pane.
      // SimulatorPane mounts in response to this open and only then subscribes to
      // onOpenSimulator — too late to catch this very event — so it relies on the
      // stored claim. Kept for the conversation that asked, the key the pane
      // reads: a claim per project handed one conversation's simulator to every
      // other conversation in the project.
      if (p.udid)
        localStorage.setItem(
          p.chatId ? `cove.simDevice:${ws.id}:${p.chatId}` : `cove.simDevice:${ws.id}`,
          p.udid
        )
      localStorage.setItem(`simOpen:${targetDesk}`, '1')
      // Only flip the visible pane if the requesting chat is the one on screen;
      // otherwise it's persisted above and appears when you switch to that chat.
      if (targetDesk === deskKey) setSimOpen(true)
    })
  }, [ws.id, deskKey])
  // Belt-and-suspenders: when neither the browser preview nor a file viewer is
  // open, make sure the pane's native WebContentsView is detached from the window.
  // Otherwise a pane opened transiently (e.g. the agent browsing) can linger,
  // floating over the chat instead of sitting closed.
  useEffect(() => {
    if (!paneOpen || hidden) window.cove.browserHide(browserPaneId)
  }, [paneOpen, hidden, browserPaneId])

  /**
   * Take down the pane we just stopped using.
   *
   * The id is `ws.id` while a project has no conversation and `ws.id::chat`
   * once it has one, so the id CHANGES underneath a mounted workspace — and a
   * native view nobody hid stays on screen. Two pages then draw over each other
   * and over the app, which is what a project that gained its first chat looked
   * like: the old workspace-level pane and the new per-chat one, both attached.
   *
   * Switching between two chats moves the same way and had the same hole; it
   * only showed up rarely because both panes usually sat in the same rectangle.
   */
  useEffect(() => {
    const stale = browserPaneId
    return () => window.cove.browserHide(stale)
  }, [browserPaneId])
  // The project's conversations, and whichever one is on screen (activeChatId is
  // read up top, where it drives deskKey).
  const chats = useStore((s) => s.chats[ws.id])
  const activeChat = chatId ? chats?.find((c) => c.id === chatId) : undefined

  const newChat = useStore((s) => s.newChat)
  const toggleFiles = useStore((s) => s.toggleFiles)
  // Dev servers the agent started (from tool output). Shown as a chip in the
  // toolbar — there's room here, unlike the cramped sidebar row.
  const ports = useStore((s) => s.ports[ws.id] ?? EMPTY_PORTS)
  const openPreview = useStore((s) => s.openPreview)
  const openUrl = useStore((s) => s.openUrl)
  /** The page this project currently has on its pane, whoever opened it. */
  const attachedUrl = useStore((s) => s.pageUrl[ws.id] ?? '')
  // The URL we last asked the pane to load — synchronous, so it's right even
  // before the pane reports back. Used to tell a document (a PDF/image opened
  // from the tree, file://) apart from a live web/localhost preview.
  const paneUrl = useStore((s) => s.previewUrls[browserPaneId] ?? '')
  // When the pane is showing a local document (a PDF/image opened from the tree),
  // its file name — so the toolbar names what you're looking at instead of a bare
  // "page". Empty for a real web/localhost page.
  // The file:// document currently bound to this project's pane, if any. Its URL
  // and display name come from the same source so the chip and what it opens can
  // never disagree (the bug where the chip named a PDF but opened localhost).
  const docUrl = ((): string => {
    const u = attachedUrl || paneUrl
    return u.startsWith('file:') ? u : ''
  })()
  const docName = ((): string => {
    if (!docUrl) return ''
    try {
      return decodeURIComponent(docUrl.split(/[?#]/)[0].split('/').pop() || '')
    } catch {
      return ''
    }
  })()
  // Current git branch, for code projects only (browser projects have no repo).
  const [branch, setBranch] = useState<string | null>(null)
  const [branchMenu, setBranchMenu] = useState(false)
  const [branchErr, setBranchErr] = useState<string | null>(null)
  const branchChipRef = useRef<HTMLButtonElement>(null)
  const refreshBranch = useCallback(() => {
    window.cove.gitBranch(ws.path).then((b) => setBranch(b))
  }, [ws.path])
  // The branch dropdown opens over the desk, where the native browser/PDF view
  // paints above ALL html — so it appeared BEHIND the page. Take the same overlay
  // lock the snip uses: it freezes and detaches the native view while the menu is
  // open, so the dropdown is on top; closing it re-attaches the pane.
  useEffect(() => {
    if (!branchMenu) return
    enterOverlay()
    return () => exitOverlay()
  }, [branchMenu, enterOverlay, exitOverlay])
  useEffect(() => {
    if (ws.kind === 'browser' || !visible) return
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
  }, [ws.kind, ws.path, ws.id, visible])
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

  // Only the focused desk responds to global menu actions (all opened
  // workspaces, and several chats of one, stay mounted for keep-alive).
  useEffect(() => {
    if (!focused) return
    // These are full sections now, owned by the app rather than this project.
    const onSkills = (): void => {
      window.dispatchEvent(new CustomEvent('cove:open-skills'))
    }
    const onRoutines = (): void => {
      window.dispatchEvent(new CustomEvent('cove:open-routines'))
    }
    const onToggle = (): void => toggleBrowser(ws.id, browserOpen, chatId)
    // Cmd+R: reload the page when the browser pane is on screen; otherwise a
    // no-op rather than surprising the user with an app reload. The pane is
    // per chat (workspace::chat), so it has to be browserPaneId — reloading
    // ws.id reached nothing in any chat with its own pane. Always bypasses the
    // cache (browserReload does), so ⇧⌘R is bound to the same handler — there
    // is no meaningfully different "harder" reload to offer here.
    const onReload = (): void => {
      if (!browserOpen) return
      window.cove.browserReload(browserPaneId)
      window.dispatchEvent(
        new CustomEvent('cove:browser-reload-feedback', { detail: { paneId: browserPaneId } })
      )
    }
    // The command palette's "Open simulator" / "Toggle todo board": both
    // toggle local surface state (simOpen/boardOpen live here, not in the
    // store — see their declarations above), so they need a listener here
    // rather than a direct store call from the palette.
    const onOpenSimulator = (): void => {
      if (simOpen) return
      localStorage.setItem(`simOpen:${deskKey}`, '1')
      setSimOpen(true)
    }
    const onToggleBoard = (): void => {
      const next = !boardOpen
      localStorage.setItem(`boardOpen:${deskKey}`, next ? '1' : '0')
      setBoardOpen(next)
    }
    // Asked for by an agent (app_open_view): open one of this project's panes.
    // Opening only: asked to show the board twice, it stays shown.
    const onPane = (e: Event): void => {
      const pane = (e as CustomEvent<{ pane: string }>).detail?.pane
      if (pane === 'board' && !boardOpen) onToggleBoard()
      else if (pane === 'simulator') onOpenSimulator()
      else if (pane === 'browser' && !browserOpen) toggleBrowser(ws.id, browserOpen, chatId)
      else if (pane === 'files' && !filesOpen) toggleFiles(ws.id, chatId)
    }
    window.addEventListener('cove:app-pane', onPane)
    window.addEventListener('cove:menu-skills', onSkills)
    window.addEventListener('cove:menu-routines', onRoutines)
    window.addEventListener('cove:menu-toggle-preview', onToggle)
    window.addEventListener('cove:menu-reload-page', onReload)
    window.addEventListener('cove:menu-reload-page-hard', onReload)
    window.addEventListener('cove:command-open-simulator', onOpenSimulator)
    window.addEventListener('cove:command-toggle-board', onToggleBoard)
    return () => {
      window.removeEventListener('cove:app-pane', onPane)
      window.removeEventListener('cove:menu-skills', onSkills)
      window.removeEventListener('cove:menu-routines', onRoutines)
      window.removeEventListener('cove:menu-toggle-preview', onToggle)
      window.removeEventListener('cove:menu-reload-page', onReload)
      window.removeEventListener('cove:menu-reload-page-hard', onReload)
      window.removeEventListener('cove:command-open-simulator', onOpenSimulator)
      window.removeEventListener('cove:command-toggle-board', onToggleBoard)
    }
  }, [
    ws.id,
    chatId,
    browserPaneId,
    toggleBrowser,
    toggleFiles,
    focused,
    browserOpen,
    filesOpen,
    simOpen,
    boardOpen,
    deskKey
  ])

  const containerRef = useRef<HTMLDivElement>(null)
  const focusTile = useStore((s) => s.focusTile)
  const closeTile = useStore((s) => s.closeTile)
  const zoomTile = useStore((s) => s.zoomTile)
  const setSplitOrient = useStore((s) => s.setSplitOrient)
  const inSplit = !!tile && tile.count > 1
  const projectIcon = useProjectIcon(ws.id, ws.path, ws.kind)
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
    <div
      className={`workspace-view${tile ? ' in-tile' : ''}${tile?.focused ? ' tile-focused' : ''}`}
      data-desk={chatId ?? ws.id}
      style={
        hidden
          ? { display: 'none' }
          : tile
            ? {
                position: 'absolute',
                left: tile.rect.x,
                top: tile.rect.y,
                width: tile.rect.w,
                height: tile.rect.h
              }
            : undefined
      }
      onPointerDownCapture={tile && !tile.focused ? () => focusTile(tile.index) : undefined}
    >
      {inSplit && tile ? (
        // A window of a split: minimal and unmistakable — its number, the
        // project's logo, and the session's name as the headline. The tools
        // show on hover (or while one is on), so four or eight windows read as
        // four or eight conversations, not as rows of buttons.
        <div className="workspace-toolbar tile-head">
          <span
            className="tile-grip"
            title="Drag to move this window"
            onPointerDown={(e) => chatId && onGripPointerDown(e, { ws: ws.id, chat: chatId })}
          >
            <svg viewBox="0 0 8 14" aria-hidden="true">
              <circle cx="2" cy="2" r="1.1" />
              <circle cx="6" cy="2" r="1.1" />
              <circle cx="2" cy="7" r="1.1" />
              <circle cx="6" cy="7" r="1.1" />
              <circle cx="2" cy="12" r="1.1" />
              <circle cx="6" cy="12" r="1.1" />
            </svg>
          </span>
          <span className="tile-num" title={`⌘${tile.index + 1}`}>
            {tile.index + 1}
          </span>
          <span className="tile-project-icon" title={ws.name}>
            <ProjectIcon icon={projectIcon} kind={ws.kind} size={18} />
          </span>
          <span
            className="tile-name"
            title={`${ws.name} › ${activeChat?.title || 'New chat'} · Drag to move this window`}
            onPointerDown={(e) => chatId && onGripPointerDown(e, { ws: ws.id, chat: chatId })}
          >
            <span className="tile-chat">{activeChat?.title || 'New chat'}</span>
            <span className="tile-project">{ws.name}</span>
          </span>
          {/* Holding ⌘: which key goes here. */}
          <span className="tile-hint" aria-hidden="true">
            ⌘{tile.index + 1}
          </span>
          <span className="tile-tools">
            {/* The chat's own ⋯ menu lands here (EasyChat, through a portal). */}
            <span className="toolbar-chat-slot" data-chat-slot={chatId ?? ws.id} />
            {ws.kind !== 'browser' && (
              <button
                className={`toolbar-btn toolbar-icon ${filesOpen ? 'on' : ''}`}
                onClick={() => toggleFiles(ws.id, chatId)}
                title="Files"
                aria-label="Files"
              >
                <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
                </svg>
              </button>
            )}
            <button
              className={`toolbar-btn toolbar-icon ${boardOpen ? 'on' : ''}`}
              onClick={() =>
                setBoardOpen((v) => {
                  localStorage.setItem(`boardOpen:${deskKey}`, v ? '0' : '1')
                  return !v
                })
              }
              title="Todo"
              aria-label="Todo"
            >
              <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.2 4.3l1.3 1.3 2.2-2.4M8 4.5h5.8M2.2 10.3l1.3 1.3 2.2-2.4M8 10.5h5.8" />
              </svg>
            </button>
            <button
              className={`toolbar-btn toolbar-icon ${browserOpen ? 'on' : ''}`}
              onClick={() => toggleBrowser(ws.id, browserOpen, chatId)}
              title={browserOpen ? 'Hide the browser' : 'Browser'}
              aria-label="Browser"
            >
              <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" />
                <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.7 3.8 2.7 6.2S9.8 12.5 8 14.2C6.2 12.5 5.3 10.4 5.3 8S6.2 3.5 8 1.8z" />
              </svg>
            </button>
            {tile.count <= 3 && !tile.zoomed && (
              <button
                className="toolbar-btn toolbar-icon"
                title={tile.orient === 'col' ? 'Side by side' : 'Stack'}
                aria-label={tile.orient === 'col' ? 'Put the windows side by side' : 'Stack the windows'}
                onClick={() => setSplitOrient(tile.orient === 'col' ? 'row' : 'col')}
              >
                <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2" y="2.5" width="12" height="11" rx="1.6" />
                  {tile.orient === 'col' ? <path d="M8 2.5v11" /> : <path d="M2 8h12" />}
                </svg>
              </button>
            )}
            <button
              className="toolbar-btn toolbar-icon"
              title={tile.zoomed ? 'Back to the split (⌘⇧↩)' : 'Full size (⌘⇧↩)'}
              aria-label={tile.zoomed ? 'Back to the split' : 'Full size'}
              onClick={() => zoomTile(tile.zoomed ? null : tile.index)}
            >
              <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
                {tile.zoomed ? (
                  <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
                ) : (
                  <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
                )}
              </svg>
            </button>
          </span>
          <button
            className="toolbar-btn toolbar-icon tile-close"
            title="Take off screen (⌘W) — it keeps running"
            aria-label="Take this window off screen"
            onClick={() => closeTile(tile.index)}
          >
            <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ) : plain ? null : (
      <div className="workspace-toolbar">
        {/* Leads the toolbar because the pane it opens is the leftmost column. */}
        {ws.kind !== 'browser' && (
          <button
            className={`toolbar-btn toolbar-icon tile-files-btn ${filesOpen ? 'on' : ''}`}
            onClick={() => toggleFiles(ws.id, chatId)}
            title="Files"
          >
            <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
            </svg>
            <span className="toolbar-label">Files</span>
          </button>
        )}
        {/* Sits next to Files, top-left: both open a left-hand surface for this
            project, so they read as a pair. */}
        <button
          className={`toolbar-btn toolbar-icon tile-todo-btn ${boardOpen ? 'on' : ''}`}
          onClick={() =>
            setBoardOpen((v) => {
              if (!v) widenForBoard()
              localStorage.setItem(`boardOpen:${deskKey}`, v ? '0' : '1')
              return !v
            })
          }
          title="Todo: what's left, and what the agent finished"
        >
          <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.2 4.3l1.3 1.3 2.2-2.4M8 4.5h5.8M2.2 10.3l1.3 1.3 2.2-2.4M8 10.5h5.8" />
          </svg>
          <span className="toolbar-label">Todo</span>
        </button>
        {/* The third of the pair: the browser, without waiting for the agent to
            open a page. A browser project's own toggle is on the right. */}
        {ws.kind !== 'browser' && (
          <button
            className={`toolbar-btn toolbar-icon ${browserOpen ? 'on' : ''}`}
            onClick={() => toggleBrowser(ws.id, browserOpen, chatId)}
            title={browserOpen ? 'Hide the browser' : 'Browser'}
          >
            <svg className="toolbar-ic" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" />
              <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.7 3.8 2.7 6.2S9.8 12.5 8 14.2C6.2 12.5 5.3 10.4 5.3 8S6.2 3.5 8 1.8z" />
            </svg>
            <span className="toolbar-label">Browser</span>
          </button>
        )}
        {ws.kind === 'browser' ? (
          <>
            <span className="workspace-title">{site.title || hostOf(site.url) || 'New tab'}</span>
            <span className="workspace-path">{site.url}</span>
          </>
        ) : (
          <>
            {/* Whose desk this is, at a glance — the project's own icon. */}
            <span className="tile-project-icon" title={ws.name}>
              <ProjectIcon icon={projectIcon} kind={ws.kind} size={18} />
            </span>
            <span className="workspace-title">{ws.name}</span>
            {/* Which conversation is on screen, so a glance at the top says
                where you are, not only which project. */}
            {activeChat && (
              <>
                <span className="workspace-crumb" aria-hidden="true">
                  ›
                </span>
                <span className="workspace-chat" title={activeChat.title || 'New chat'}>
                  {activeChat.title || 'New chat'}
                </span>
              </>
            )}
            <span className="workspace-path" title={ws.path}>
              {ws.path}
            </span>
            {branch && (
              <span className="workspace-branch-wrap">
                <button
                  ref={branchChipRef}
                  className="workspace-branch"
                  title={`On git branch ${branch} — click to switch`}
                  onClick={() => {
                    setBranchErr(null)
                    setBranchMenu((v) => !v)
                  }}
                >
                  ⎇ {branch}
                  <span className="workspace-branch-caret">▾</span>
                </button>
                {branchMenu && (
                  <BranchMenu
                    cwd={ws.path}
                    anchor={branchChipRef.current}
                    pickDisabledInWorktree
                    onClose={() => setBranchMenu(false)}
                    onPick={async (b) => {
                      const r = await window.cove.gitCheckout(ws.path, b)
                      if (r.ok) {
                        setBranchMenu(false)
                        setBranchErr(null)
                        refreshBranch()
                      } else {
                        setBranchErr(r.error || 'Could not switch branch')
                      }
                    }}
                  />
                )}
                {branchErr && <span className="workspace-branch-err">{branchErr}</span>}
              </span>
            )}
          </>
        )}
        {/* A site attached to this project that is not one of our dev servers —
            the chip was only ever about localhost, so a project sitting on a
            real site said nothing at all up here. */}
        {/* Showing a local document (PDF/image): name the file so you know what's
            in the pane, not a bare "page". Shown regardless of a dev server. */}
        {/* An opened PDF/image is a file:// page in the native pane, which paints
            OVER the pane's own ✕ — so the doc chip in the toolbar (which the native
            view can never cover) is the reliable control. The NAME opens the pane
            AND navigates it to this document (never "whatever the pane last
            showed" — that opened localhost while the chip named a PDF); the ✕
            closes the pane. */}
        {ws.kind !== 'browser' && docName && (
          <span className="workspace-server attached workspace-doc">
            <button
              className="workspace-doc-open"
              title={`Show ${docName}`}
              onClick={() => openUrl(ws.id, docUrl, false, chatId)}
            >
              <span className="workspace-doc-icon">📄</span>
              <span className="workspace-doc-name">{docName}</span>
            </button>
            {browserOpen && (
              <button
                className="workspace-doc-close"
                title={`Close ${docName}`}
                onClick={() => toggleBrowser(ws.id, browserOpen, chatId)}
              >
                ✕
              </button>
            )}
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
            onClick={() => openPreview(ws.id, ports[ports.length - 1], chatId)}
          >
            <span className="workspace-server-dot" />
            localhost:{ports[ports.length - 1]}
            <span className="workspace-server-open">Open preview</span>
          </button>
        )}
        <div className="workspace-toolbar-spacer" />
        {/* What the conversation on screen puts up here: its Images button
            (EasyChat fills this through a portal). */}
        <div className="toolbar-chat-slot" data-chat-slot={chatId ?? ws.id} />
        {/* ✂ Snip lives ON the pane now (browser omnibar / simulator chrome), not
            here — closer to what you're snipping and more intuitive. */}
        {/* A code project's preview reveals itself when the agent navigates, and
            normally closes from the pane's own ✕. But the native page paints
            ABOVE all HTML, so a mis-bounded agent-opened view can cover its own
            toolbar — leaving no way to close it. This close lives up here in the
            workspace toolbar, which the native view can never reach, so there is
            always a way out. Shown only when the browser is the visible surface. */}
        {/* The preview pane's close ✕ lives ON the pane, in its own omnibar
            (BrowserPane) — where a close belongs and where you look for it. No
            duplicate up here. The omnibar always renders (web pages and PDFs
            alike), and the settle re-sync keeps the native view from ever painting
            over it, so that ✕ is always present and clickable. */}
        {ws.kind === 'browser' && (
          <button
            className={`toolbar-btn ${browserOpen ? 'on' : ''}`}
            onClick={() => toggleBrowser(ws.id, browserOpen, chatId)}
          >
            {browserOpen ? 'Hide preview' : 'Show preview'}
          </button>
        )}
        {/* Where the chat sits is a view control, so it belongs here with the
            others rather than among the New chat pills. The glyph shows the
            arrangement you would move to; no label, it is not worth a word. */}
        {paneOpen && !mini && (
          <button
            className="toolbar-btn toolbar-icon tile-layout-toggle"
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
      )}
      {/* The chat stays mounted (stable position) whether or not the browser is
          open, so toggling the preview never disturbs the conversation. */}
      <div ref={containerRef} className="content-split">
        {filesOpen && ws.kind !== 'browser' && (
          <div className="files-side" style={{ flexBasis: filesWidth }}>
            <FileTree cwd={filesRoot} workspaceId={ws.id} />
            <div className="files-divider" onPointerDown={onFilesDividerDown} />
          </div>
        )}
        {/* Sits between the tree and the chat: a file you click on the left opens
            next to it, rather than across the window. Chat keeps the far side. */}
        <div className={`split-main ${layout === 'bottom' ? 'vert' : ''}`}>
          {/* A hidden desk (a busy or recent chat kept alive) shows no panes:
              its page stays in main, and its simulator is found again when it
              comes back on screen. */}
          {paneOpen && !hidden && !mini && (
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
                      chatId={activeChatId ?? undefined}
                      onClose={() => {
                        localStorage.setItem(`simOpen:${deskKey}`, '0')
                        setSimOpen(false)
                        // The phone's mirror follows: closed here is closed there.
                        if (activeChatId) void window.cove.simNoteClosed?.(activeChatId)
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
            style={{ flexBasis: paneOpen && !hidden && !mini ? `${ratio * 100}%` : '100%' }}
          >
            {/* Each chat keeps its own mounted <EasyChat> (and its agent). Only the
              active one is shown; busy siblings stay mounted but hidden so their
              turn keeps streaming. Stable key per chat → switching never remounts,
              so it never tears down a running session. */}
            {activeChat && (
              <div className="chat-mount" style={{ display: 'flex' }}>
                <EasyChat
                  cwd={activeChat.cwd ?? ws.path}
                  workspaceId={ws.id}
                  chatId={activeChat.id}
                  initialSessionId={activeChat.claudeSessionId}
                  browserProject={ws.kind === 'browser'}
                  visible={visible}
                  focused={focused}
                  slotKey={inSplit ? 'tile' : 'desk'}
                />
              </div>
            )}
            {/* The folder has no conversation of its own (its chats are all on
                branches, or it has none): say so and offer one, rather than a
                blank page with nothing to type into. */}
            {ws.kind !== 'browser' && chats !== undefined && !activeRun && !activeChat && (
              <div className="project-empty">
                <p>No conversation in {ws.name} yet.</p>
                <button className="project-empty-new" onClick={() => void newChat(ws.id)}>
                  + New chat
                </button>
              </div>
            )}
            {activeRun && focused && <RoutineRunView routine={activeRun} />}
          </div>
        </div>
      </div>
      {mini && tile && (
        <MiniPane
          deskId={chatId ?? ws.id}
          tile={tile}
          kind={simOpen && (!surface || boardOpen || miniShows === 'sim') ? 'sim' : 'surface'}
          both={!!surface && simOpen && !boardOpen}
          onShow={setMiniShows}
          surfaceLabel={
            boardOpen
              ? 'Todo'
              : openFilePath
                ? openFilePath.split('/').pop() || 'File'
                : docName || hostOf(attachedUrl || paneUrl) || 'Browser'
          }
          onBig={() => zoomTile(tile.index)}
          onClose={(which) => {
            if (which === 'sim') {
              localStorage.setItem(`simOpen:${deskKey}`, '0')
              setSimOpen(false)
              if (activeChatId) void window.cove.simNoteClosed?.(activeChatId)
            } else if (boardOpen) {
              localStorage.setItem(`boardOpen:${deskKey}`, '0')
              setBoardOpen(false)
            } else if (openFilePath) closeFile(ws.id, chatId)
            else toggleBrowser(ws.id, true, chatId)
          }}
          sim={
            simOpen && !boardOpen ? (
              <SimulatorPane
                mini
                visible={visible}
                workspaceId={ws.id}
                chatId={activeChatId ?? undefined}
                onClose={() => {
                  localStorage.setItem(`simOpen:${deskKey}`, '0')
                  setSimOpen(false)
                  if (activeChatId) void window.cove.simNoteClosed?.(activeChatId)
                }}
                onNothingToShow={() => {
                  localStorage.setItem(`simOpen:${deskKey}`, '0')
                  setSimOpen(false)
                }}
              />
            ) : null
          }
        >
          {surface}
        </MiniPane>
      )}
    </div>
  )
}

/** Narrower than this, a window of a split shows its page or simulator as a mini. */
export const MINI_BELOW = 900

type Corner = 0 | 1 | 2 | 3
interface MiniGeom {
  corner: Corner
  w: number
  h: number
  small: boolean
}
const MINI_TOP = 56 // below the window's header
const MINI_BOTTOM = 132 // above the composer
const MINI_MARGIN = 12

/**
 * The page or simulator of a narrow window, as a mini inside that window — like
 * picture-in-picture, but it never leaves the chat it belongs to, so whose it
 * is cannot be in doubt. Snaps to the window's corners, resizes from its inner
 * corner, shrinks to a chip, and ⤢ shows it big (the window goes full size and
 * the pane docks beside the chat). The page inside is the desktop layout scaled
 * down (BrowserPane fits 1280px to whatever width it has).
 */
function MiniPane({
  deskId,
  tile,
  kind,
  both,
  onShow,
  surfaceLabel,
  onBig,
  onClose,
  sim,
  children
}: {
  deskId: string
  tile: DeskTile
  kind: 'surface' | 'sim'
  both: boolean
  onShow: (k: 'surface' | 'sim') => void
  surfaceLabel: string
  onBig: () => void
  onClose: (which: 'surface' | 'sim') => void
  sim: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const key = `mini:${deskId}:${kind}`
  const fallback = (): MiniGeom =>
    kind === 'sim'
      ? { corner: 1, w: 210, h: 430, small: false }
      : { corner: 1, w: 380, h: 270, small: false }
  const [geom, setGeom] = useState<MiniGeom>(() => {
    try {
      const g = JSON.parse(localStorage.getItem(key) || 'null') as MiniGeom | null
      return g && typeof g.w === 'number' ? g : fallback()
    } catch {
      return fallback()
    }
  })
  const [seenKey, setSeenKey] = useState(key)
  if (seenKey !== key) {
    setSeenKey(key)
    try {
      const g = JSON.parse(localStorage.getItem(key) || 'null') as MiniGeom | null
      setGeom(g && typeof g.w === 'number' ? g : fallback())
    } catch {
      setGeom(fallback())
    }
  }
  const save = (g: MiniGeom): void => {
    setGeom(g)
    localStorage.setItem(key, JSON.stringify(g))
  }
  const enterOverlay = useStore((s) => s.enterOverlay)
  const exitOverlay = useStore((s) => s.exitOverlay)
  const [drag, setDrag] = useState<{ x: number; y: number; near: Corner } | null>(null)

  const W = tile.rect.w
  const H = tile.rect.h
  const w = Math.max(160, Math.min(geom.w, W - MINI_MARGIN * 2))
  const h = Math.max(140, Math.min(geom.h, H - MINI_TOP - MINI_BOTTOM + 40))
  const at = (c: Corner, ww: number, hh: number): { x: number; y: number } => ({
    x: c % 2 ? W - ww - MINI_MARGIN : MINI_MARGIN,
    y: c < 2 ? MINI_TOP : Math.max(MINI_TOP, H - hh - MINI_BOTTOM)
  })
  const home = at(geom.corner, w, h)

  const onHeadDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const dx = e.clientX - home.x
    const dy = e.clientY - home.y
    enterOverlay()
    let last = { x: home.x, y: home.y, near: geom.corner }
    const move = (ev: PointerEvent): void => {
      const x = Math.max(4, Math.min(W - w - 4, ev.clientX - dx))
      const y = Math.max(MINI_TOP - 10, Math.min(H - h - 4, ev.clientY - dy))
      const near = ((x + w / 2 > W / 2 ? 1 : 0) + (y + h / 2 > H / 2 ? 2 : 0)) as Corner
      last = { x, y, near }
      setDrag(last)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      exitOverlay()
      save({ ...geom, corner: last.near })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // The handle sits on the corner facing the middle of the window.
  const onGrowDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    const w0 = w
    const h0 = h
    const kx = geom.corner % 2 ? -1 : 1
    const ky = geom.corner < 2 ? 1 : -1
    enterOverlay()
    let g = geom
    const move = (ev: PointerEvent): void => {
      g = { ...geom, w: w0 + kx * (ev.clientX - sx), h: h0 + ky * (ev.clientY - sy) }
      setGeom(g)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      exitOverlay()
      save({ ...g, w: Math.max(160, Math.min(g.w, W - MINI_MARGIN * 2)), h: Math.max(140, g.h) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const label = kind === 'sim' ? 'Simulator' : surfaceLabel
  const icon =
    kind === 'sim' ? (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="4.2" y="1.5" width="7.6" height="13" rx="1.8" />
        <path d="M7 12.6h2" />
      </svg>
    ) : (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.7 3.8 2.7 6.2S9.8 12.5 8 14.2C6.2 12.5 5.3 10.4 5.3 8S6.2 3.5 8 1.8z" />
      </svg>
    )

  if (geom.small) {
    const p = at(geom.corner, 150, 30)
    return (
      <button
        className="mini-chip"
        style={{ left: geom.corner % 2 ? W - MINI_MARGIN - 150 : p.x, top: p.y }}
        title={`Show the ${label.toLowerCase()} again`}
        onClick={() => save({ ...geom, small: false })}
      >
        {icon}
        <span>{label}</span>
      </button>
    )
  }

  const pos = drag ?? home
  return (
    <>
      {drag &&
        ([0, 1, 2, 3] as Corner[]).map((c) => {
          const q = at(c, w, h)
          return (
            <div
              key={c}
              className={`mini-snap ${c === drag.near ? 'hot' : ''}`}
              style={{ left: q.x, top: q.y, width: w, height: h }}
            />
          )
        })}
      <div
        className={`mini-pane ${drag ? 'dragging' : ''} ${tile.focused ? 'own' : ''}`}
        style={{ left: pos.x, top: pos.y, width: w, height: h }}
        data-mini={kind}
      >
        <div className="mini-head" onPointerDown={onHeadDown}>
          {!both && <span className="mini-icon">{icon}</span>}
          {both ? (
            <span className="mini-switch" role="tablist">
              <button
                role="tab"
                aria-selected={kind === 'surface'}
                aria-label={surfaceLabel}
                title={surfaceLabel}
                className={kind === 'surface' ? 'on' : ''}
                onClick={() => onShow('surface')}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.2" />
                  <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.7 3.8 2.7 6.2S9.8 12.5 8 14.2C6.2 12.5 5.3 10.4 5.3 8S6.2 3.5 8 1.8z" />
                </svg>
              </button>
              <button
                role="tab"
                aria-selected={kind === 'sim'}
                aria-label="Simulator"
                title="Simulator"
                className={kind === 'sim' ? 'on' : ''}
                onClick={() => onShow('sim')}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4.2" y="1.5" width="7.6" height="13" rx="1.8" />
                  <path d="M7 12.6h2" />
                </svg>
              </button>
              <span className="mini-label">{kind === 'sim' ? 'Simulator' : surfaceLabel}</span>
            </span>
          ) : (
            <span className="mini-label">{label}</span>
          )}
          <span className="mini-actions">
            <button title="See it big" aria-label="See it big" onClick={onBig}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
              </svg>
            </button>
            <button
              title="Make it small"
              aria-label="Make it small"
              onClick={() => save({ ...geom, small: true })}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8h9" />
              </svg>
            </button>
            <button
              title="Close"
              aria-label={`Close the ${label.toLowerCase()}`}
              onClick={() => onClose(kind)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </span>
        </div>
        <div className="mini-body">{kind === 'sim' ? sim : children}</div>
        <div
          className="mini-grow"
          onPointerDown={onGrowDown}
          style={{
            left: geom.corner % 2 ? 0 : undefined,
            right: geom.corner % 2 ? undefined : 0,
            top: geom.corner < 2 ? undefined : 0,
            bottom: geom.corner < 2 ? 0 : undefined,
            cursor: geom.corner === 0 || geom.corner === 3 ? 'nwse-resize' : 'nesw-resize'
          }}
        />
      </div>
    </>
  )
}
