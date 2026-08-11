import { create } from 'zustand'
import { useEffect } from 'react'
import type { TreeGroup, Routine, Chat } from '../../preload'

export type WorkspaceStatus = 'idle' | 'working' | 'needs-you'

// How the app opens a file by extension. Text/code/markdown render in the in-app
// viewer/editor; these binary types preview inline in the browser pane; anything
// else goes to the OS. Shared by the file tree and the agent's open_file tool.
export const FILE_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'xml', 'csv', 'log', 'yml', 'yaml', 'toml', 'ini',
  'env', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'htm', 'py',
  'go', 'rs', 'java', 'c', 'h', 'cpp', 'rb', 'php', 'swift', 'kt', 'sql', 'sh', 'bash', 'zsh'
])
export const FILE_PREVIEW_EXTS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'
])

// Detected dev-server ports persist across restarts so the "Open preview" chip
// survives; verifyPorts() prunes any that are no longer listening on startup.
const PORTS_KEY = 'cove.ports'
function loadPorts(): Record<string, number[]> {
  try {
    return JSON.parse(localStorage.getItem(PORTS_KEY) || '{}')
  } catch {
    return {}
  }
}
function savePorts(p: Record<string, number[]>): void {
  try {
    localStorage.setItem(PORTS_KEY, JSON.stringify(p))
  } catch {
    /* ignore quota/serialization errors */
  }
}

// Whether the browser pane is open per workspace. Kept only in memory: a cold
// app start always lands on the chat with the pane closed, so we never reopen a
// logged-out site as a floating login card. Within a session the map persists as
// normal zustand state.

/**
 * Only modes that need no prompt: SuperAgent drives `claude -p`, where there is
 * nowhere to answer a permission request, so an asking mode would silently deny
 * and the tool would just fail.
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'plan'

/** A task from Claude's TodoWrite tool, surfaced live in the chat. */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

interface CoveState {
  tree: TreeGroup[]
  activeWorkspaceId: string | null
  /**
   * The full-window view sitting over the projects, if any — just Computer
   * now that Dashboard, Skills and Routines are applications inside it. The
   * sidebar marks it, and a project row must not keep looking selected while
   * it is covered up.
   */
  /**
   * Projects whose pane currently has a page on it, reported by the pane
   * itself. previewUrls only records navigations *we* asked for, so a pane
   * restored at startup has none — and the sidebar could not tell a project
   * sitting on a live site from one with nothing open.
   */
  pageUrl: Record<string, string>
  setPageUrl: (workspaceId: string, url: string) => void
  /** Projects with the simulator pane open, so the sidebar can say so. */
  simOpen: Record<string, boolean>
  setSimOpen: (workspaceId: string, open: boolean) => void
  overlay: 'computer' | null
  setOverlay: (o: 'computer' | null) => void
  // Routines grouped by workspace id, shown nested under each project in the sidebar.
  routines: Record<string, Routine[]>
  refreshRoutines: () => Promise<void>
  startRoutinesListener: () => void
  // The routine whose last-run transcript is open in the viewer (null = closed).
  openRoutineRunId: string | null
  openRoutineRun: (id: string) => void
  closeRoutineRun: () => void
  statuses: Record<string, WorkspaceStatus>
  // Claude's current task list from TodoWrite (live in the chat), keyed by chat
  // id — each conversation keeps its own list, so two chats in one project don't
  // overwrite each other's checklist.
  todos: Record<string, TodoItem[]>
  setTodos: (chatId: string, todos: TodoItem[]) => void
  clearTodos: (chatId: string) => void
  ports: Record<string, number[]>
  browserOpen: Record<string, boolean>
  coldStart: boolean
  filesOpen: Record<string, boolean>
  // Absolute path of the text file open in the in-app viewer/editor, per workspace.
  openFile: Record<string, string | null>
  openFileInViewer: (workspaceId: string, path: string, focus?: boolean) => void
  closeFile: (workspaceId: string) => void
  // Open an absolute file path the right way: text/code/markdown in the in-app
  // viewer, PDFs/images in the preview pane, everything else in the OS default.
  // Shared by the file tree and the agent's open_file tool.
  openPath: (workspaceId: string, absPath: string, focus?: boolean) => void

  // Count of open HTML overlays (slide-overs, modals). While > 0 the native
  // browser view is hidden so it can't cover them.
  overlayCount: number
  enterOverlay: () => void
  exitOverlay: () => void

  refresh: () => Promise<void>
  setActive: (id: string) => void
  setStatus: (workspaceId: string, status: WorkspaceStatus) => void
  addPort: (workspaceId: string, port: number) => void
  verifyPorts: () => Promise<void>
  /**
   * `current` is the pane's *effective* open state, which the component has
   * already resolved. Without it this toggled `browserOpen[id]` raw — and a
   * pane restored from localStorage has no entry there, so `!undefined` was
   * `true` and the first click on ✕ re-opened what was already open.
   */
  toggleBrowser: (workspaceId: string, current?: boolean) => void
  toggleFiles: (workspaceId: string) => void
  hooksEnabled: boolean
  setHooksEnabled: (v: boolean) => void
  startHookListener: () => void

  previewUrls: Record<string, string>
  reloadOnIdle: Record<string, boolean>
  toast: { workspaceId: string; port: number } | null
  openPreview: (workspaceId: string, port: number) => void
  /** Reveal the browser pane on an arbitrary URL (e.g. a file:// from the tree). */
  openUrl: (workspaceId: string, url: string, focus?: boolean) => void
  dismissToast: () => void
  setReloadOnIdle: (workspaceId: string, v: boolean) => void

  browsingWorkspaceId: string | null
  stopBrowsing: () => void
  startBrowsingListener: () => void

  // Chats belonging to each project, and which one is on screen. A project can
  // hold many conversations; only the active one keeps a live claude process.
  chats: Record<string, Chat[]>
  activeChatId: Record<string, string>
  refreshChats: () => Promise<void>
  loadChats: (workspaceId: string) => Promise<Chat[]>
  newChat: (workspaceId: string) => Promise<void>
  /** New chat running in a fresh git worktree of the project. */
  newChatInWorktree: (workspaceId: string, projectPath: string) => Promise<boolean>
  selectChat: (workspaceId: string, chatId: string) => void
  removeChat: (workspaceId: string, chatId: string) => Promise<void>
  renameChat: (workspaceId: string, chatId: string, title: string) => Promise<void>
  touchChat: (workspaceId: string, chatId: string, patch: Partial<Chat>) => void

  agentIds: Record<string, string>
  registerAgent: (workspaceId: string, agentId: string) => void
  sendToClaude: (workspaceId: string, text: string) => void

  /**
   * What each chat currently has in flight, keyed by chat id. Only the chats know
   * this, but quitting is app-wide — installing an update kills every agent — so
   * the banner needs to be able to ask before it throws work away.
   */
  busy: Record<string, { generating: boolean; background: number }>
  /**
   * Conversations that finished a turn while you were looking elsewhere.
   * Keyed by chat id; cleared the moment you actually read it.
   */
  unread: Record<string, boolean>
  markUnread: (chatId: string) => void
  markRead: (chatId: string) => void
  setBusy: (chatId: string, state: { generating: boolean; background: number }) => void
  clearBusy: (chatId: string) => void

  /**
   * Workspaces with a live claude process right now. Absent/false covers both
   * "never opened this session" and "reaped after sitting idle" — in each case
   * there is no session, which is what the half-dot means. A workspace only lands
   * here once its chat's agent is actually up.
   */
  agentLive: Record<string, boolean>
  /** Which chats are live right now, per chat id → its workspace. A workspace can
      have several chats mounted at once (busy siblings kept alive in the
      background), so its dot has to be the union — one finishing chat must not
      clear it while another is still running. */
  agentLiveChats: Record<string, string>
  setAgentLive: (workspaceId: string, chatId: string, value: boolean) => void

  /** An update downloading in the background: version + percent. Store-backed so
      Settings shows it even when reopened mid-download. */
  updateProgress: { version: string | null; percent: number } | null
  /** Last updater failure, cleared by progress/ready. Settings shows it. */
  updateError: string | null

  /** How much the agent may do without asking. Applies to newly started chats. */
  permissionMode: PermissionMode
  setPermissionMode: (m: PermissionMode) => void
  // Model to run agents on ('' = Claude's default). Passed as --model at spawn.
  model: string
  setModel: (m: string) => void

  theme: 'system' | 'light' | 'dark'
  setTheme: (t: 'system' | 'light' | 'dark') => void
  applyTheme: () => void

  addGroup: () => Promise<void>
  renameGroup: (id: string, name: string) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  moveGroup: (groupId: string, toIndex: number) => Promise<void>
  renameWorkspace: (id: string, name: string) => Promise<void>
  toggleCollapse: (id: string, collapsed: boolean) => Promise<void>
  addWorkspace: (groupId: string) => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  moveWorkspace: (workspaceId: string, toGroupId: string, toIndex: number) => Promise<void>

  // New-project chooser (Code vs Browser project).
  newProjectGroupId: string | null
  closeNewProject: () => void
  createCodeProject: (groupId: string) => Promise<void>
  createBrowserProject: (groupId: string) => Promise<void>
  openFolderAsProject: (groupId: string, name: string, path: string) => Promise<void>
}

// Dedupe concurrent loadChats() calls per workspace. Without this, React
// StrictMode's double-invoked mount effect fires two loads at once; both see an
// empty project and each creates a default chat, so a new project gets two.
const chatLoadInflight = new Map<string, Promise<Chat[]>>()

export const useStore = create<CoveState>((set, get) => ({
  tree: [],
  activeWorkspaceId: null,
  pageUrl: {},
  setPageUrl: (workspaceId, url) =>
    set((s) => (s.pageUrl[workspaceId] === url ? s : { pageUrl: { ...s.pageUrl, [workspaceId]: url } })),
  simOpen: {},
  setSimOpen: (workspaceId, open) =>
    set((s) => ({ simOpen: { ...s.simOpen, [workspaceId]: open } })),
  overlay: null,
  setOverlay: (o) => set({ overlay: o }),
  routines: {},
  openRoutineRunId: null,
  statuses: {},
  todos: {},
  setTodos: (chatId, todos) => set((s) => ({ todos: { ...s.todos, [chatId]: todos } })),
  clearTodos: (chatId) =>
    set((s) => {
      if (!s.todos[chatId]) return s
      const next = { ...s.todos }
      delete next[chatId]
      return { todos: next }
    }),
  ports: loadPorts(),
  browserOpen: {},
  // True until the user first selects a workspace this session. While true, a
  // browser-kind project shows its chat (not the auto-opened pane) so a fresh
  // launch never lands on a reloaded live page.
  coldStart: true,
  filesOpen: {},
  openFile: {},
  // A text file replaces the browser pane's slot; hide the native view so it can't
  // cover the viewer, and remember which file is showing.
  openFileInViewer: (workspaceId, path, focus = true) => {
    localStorage.setItem(`openFile:${workspaceId}`, path)
    set((s) => ({
      // Only a USER action may move the user. The agent opening its results must
      // land in its own project quietly — yanking the active workspace mid-typing
      // is the "app hijacks my work" bug.
      ...(focus ? { activeWorkspaceId: workspaceId } : {}),
      openFile: { ...s.openFile, [workspaceId]: path }
    }))
  },
  closeFile: (workspaceId) => {
    localStorage.removeItem(`openFile:${workspaceId}`)
    set((s) => ({ openFile: { ...s.openFile, [workspaceId]: null } }))
  },
  openPath: (workspaceId, absPath, focus = true) => {
    const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase()
    if (FILE_TEXT_EXTS.has(ext)) {
      get().openFileInViewer(workspaceId, absPath, focus)
    } else if (FILE_PREVIEW_EXTS.has(ext)) {
      // encodeURI (not encodeURIComponent) so path separators survive.
      get().openUrl(workspaceId, `file://${encodeURI(absPath)}`, focus)
    } else {
      // .docx, .xlsx, archives, unknown types → hand off to the OS.
      window.cove.filesOpenExternal(absPath)
    }
  },
  overlayCount: 0,
  enterOverlay: () => set((s) => ({ overlayCount: s.overlayCount + 1 })),
  exitOverlay: () => set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
  hooksEnabled: false,
  previewUrls: {},
  reloadOnIdle: {},
  toast: null,
  browsingWorkspaceId: null,
  chats: {},
  activeChatId: {},
  agentIds: {},
  busy: {},
  unread: {},
  agentLive: {},
  agentLiveChats: {},
  updateProgress: null,
  updateError: null,
  theme: (localStorage.getItem('cove.theme') as 'system' | 'light' | 'dark') || 'system',
  permissionMode:
    (localStorage.getItem('cove.permissionMode') as PermissionMode) || 'bypassPermissions',
  setPermissionMode: (m) => {
    localStorage.setItem('cove.permissionMode', m)
    set({ permissionMode: m })
  },
  // A preference saved before the picker moved to the 1M variants would name a
  // model the menu no longer lists — it would still run, but the pill would
  // label it "Default" and it would quietly be the 200K window.
  model: ((): string => {
    const saved = localStorage.getItem('cove.model') || ''
    const moved: Record<string, string> = { opus: 'opus[1m]', sonnet: 'sonnet[1m]' }
    return moved[saved] ?? saved
  })(),
  setModel: (m) => {
    localStorage.setItem('cove.model', m)
    set({ model: m })
  },

  refresh: async () => {
    const tree = await window.cove.storeTree()
    set({ tree })
    const active = get().activeWorkspaceId
    const allIds = tree.flatMap((g) => g.workspaces.map((w) => w.id))
    if (!active || !allIds.includes(active)) {
      // Land where you left off, falling back to the first project.
      const saved = localStorage.getItem('activeWorkspace')
      set({ activeWorkspaceId: saved && allIds.includes(saved) ? saved : (allIds[0] ?? null) })
    }
    await get().refreshChats()
  },

  refreshChats: async () => {
    const all = await window.cove.chatListAll()
    const byWs: Record<string, Chat[]> = {}
    for (const c of all) (byWs[c.workspaceId] ??= []).push(c)
    set((s) => {
      const active = { ...s.activeChatId }
      for (const [wsId, list] of Object.entries(byWs)) {
        // Keep the open conversation selected; otherwise fall to the newest.
        if (!list.some((c) => c.id === active[wsId])) active[wsId] = list[list.length - 1].id
      }
      return { chats: byWs, activeChatId: active }
    })
  },

  refreshRoutines: async () => {
    // One call returns every routine (no workspace filter); group them by workspace.
    const all = await window.cove.routinesList()
    const byWs: Record<string, Routine[]> = {}
    for (const r of all) (byWs[r.workspaceId] ??= []).push(r)
    set({ routines: byWs })
  },
  startRoutinesListener: () => {
    get().refreshRoutines()
    window.cove.onRoutinesChanged(() => get().refreshRoutines())
  },
  openRoutineRun: (id) => set({ openRoutineRunId: id }),
  closeRoutineRun: () => set({ openRoutineRunId: null }),

  setActive: (id) => {
    localStorage.setItem('activeWorkspace', id)
    set({ activeWorkspaceId: id, coldStart: false })
  },
  setStatus: (workspaceId, status) =>
    set((s) => ({ statuses: { ...s.statuses, [workspaceId]: status } })),
  addPort: (workspaceId, port) =>
    set((s) => {
      const cur = s.ports[workspaceId] ?? []
      if (cur.includes(port)) return s
      // First time we see this port → surface a toast offering to open the preview.
      const ports = { ...s.ports, [workspaceId]: [...cur, port].slice(-5) }
      savePorts(ports) // persist so the chip survives an app restart
      // A server takes a moment to bind, so the chip goes up on the agent's
      // word and is checked shortly after — a port merely mentioned in passing
      // then drops out rather than sitting there green forever.
      window.setTimeout(() => void get().verifyPorts(), 4000)
      return { ports, toast: { workspaceId, port } }
    }),
  // After a restart, drop any persisted server that isn't actually listening
  // anymore (its process may not have survived) — keep the ones that did.
  verifyPorts: async () => {
    const current = get().ports
    const alive: Record<string, number[]> = {}
    for (const [ws, list] of Object.entries(current)) {
      const kept: number[] = []
      for (const p of list) if (await window.cove.checkPort(p)) kept.push(p)
      if (kept.length) alive[ws] = kept
    }
    savePorts(alive)
    set({ ports: alive })
  },
  toggleFiles: (workspaceId) =>
    set((s) => {
      const next = !s.filesOpen[workspaceId]
      localStorage.setItem(`filesOpen:${workspaceId}`, next ? '1' : '0')
      return { filesOpen: { ...s.filesOpen, [workspaceId]: next } }
    }),

  toggleBrowser: (workspaceId, current) =>
    set((s) => {
      const saved = localStorage.getItem(`paneOpen:${workspaceId}`)
      const effective =
        current ?? s.browserOpen[workspaceId] ?? (saved !== null ? saved === '1' : false)
      const next = !effective
      // Remembered so a code project's preview survives an app restart. Browser
      // projects deliberately don't restore (a cold start must not land on a
      // reloaded, often logged-out live page) — see the coldStart flag.
      localStorage.setItem(`paneOpen:${workspaceId}`, next ? '1' : '0')
      const browserOpen = { ...s.browserOpen, [workspaceId]: next }
      return { browserOpen, coldStart: false }
    }),
  setHooksEnabled: (v) => set({ hooksEnabled: v }),

  openPreview: (workspaceId, port) => {
    // Check before opening: the chip is scraped from the agent's output, so it
    // can name a server that has since stopped. Showing ERR_CONNECTION_REFUSED
    // and leaving a green dot claiming it is running cannot both be right.
    void window.cove.checkPort(port).then((alive) => {
      if (!alive) void get().verifyPorts()
    })
    set((s) => {
      localStorage.setItem(`paneOpen:${workspaceId}`, '1')
      const browserOpen = { ...s.browserOpen, [workspaceId]: true }
      return {
        activeWorkspaceId: workspaceId,
        browserOpen,
        coldStart: false,
        previewUrls: { ...s.previewUrls, [workspaceId]: `http://localhost:${port}` },
        toast: null
      }
    })
  },
  openUrl: (workspaceId, url, focus = true) =>
    set((s) => {
      localStorage.setItem(`paneOpen:${workspaceId}`, '1')
      const browserOpen = { ...s.browserOpen, [workspaceId]: true }
      // The viewer and the pane are the same slot, and the viewer wins it. A
      // text file left open therefore swallowed every PDF and image opened
      // afterwards: the row highlighted, the page loaded, and nothing changed
      // on screen. Whatever was asked for last is what you want to see.
      localStorage.removeItem(`openFile:${workspaceId}`)
      return {
        ...(focus ? { activeWorkspaceId: workspaceId } : {}),
        browserOpen,
        coldStart: false,
        openFile: { ...s.openFile, [workspaceId]: null },
        previewUrls: { ...s.previewUrls, [workspaceId]: url },
        toast: null
      }
    }),
  dismissToast: () => set({ toast: null }),
  setReloadOnIdle: (workspaceId, v) =>
    set((s) => ({ reloadOnIdle: { ...s.reloadOnIdle, [workspaceId]: v } })),

  stopBrowsing: () => {
    const id = get().browsingWorkspaceId
    if (id) window.cove.browserStopAutomation(id)
    set({ browsingWorkspaceId: null })
  },
  startBrowsingListener: () => {
    let timer: ReturnType<typeof setTimeout> | null = null
    window.cove.onBrowserActivity((paneId) => {
      // Routine runs drive an offscreen pane ("<workspaceId>::routine") — ignore
      // those; they must never steal the viewport or flip a panel open.
      if (paneId.includes('::')) return
      const workspaceId = paneId
      set({ browsingWorkspaceId: workspaceId })
      // The agent is driving the in-app browser — reveal the preview pane if it's
      // hidden (e.g. a code project) so the user can watch what it's doing.
      const s = get()
      const known = s.tree.some((g) => g.workspaces.some((w) => w.id === workspaceId))
      if (known && !s.browserOpen[workspaceId]) {
        // Persist too — an agent-opened pane must survive restarts exactly like
        // a user-opened one (this was the hole: agent panes vanished on update).
        localStorage.setItem(`paneOpen:${workspaceId}`, '1')
        set({ browserOpen: { ...s.browserOpen, [workspaceId]: true } })
      }
      if (timer) clearTimeout(timer)
      // Auto-clear the indicator a few seconds after the last tool call.
      timer = setTimeout(() => set({ browsingWorkspaceId: null }), 4000)
    })
    // Cold start: the agent navigated the browser before the preview was open.
    // Reveal it (and focus the project) so the pane gets created and the page shows.
    window.cove.onBrowserRequestOpen((workspaceId) => {
      const s = get()
      if (!s.tree.some((g) => g.workspaces.some((w) => w.id === workspaceId))) return
      // Always reveal the pane so the page is ready when the user looks. Only pull
      // the user to this workspace when the app is actually frontmost — a
      // background agent must never yank the view while they're in another app.
      const focused = document.hasFocus()
      // Persist here too. This handler runs BEFORE any browser:activity event
      // and marks the pane open in memory — which made the activity listener's
      // "not open yet" persist guard skip, so agent-opened panes still vanished
      // on restart (seen live: levantto-shop).
      localStorage.setItem(`paneOpen:${workspaceId}`, '1')
      set({
        browserOpen: { ...s.browserOpen, [workspaceId]: true },
        ...(focused ? { activeWorkspaceId: workspaceId, coldStart: false } : {})
      })
    })
  },

  setTheme: (t) => {
    localStorage.setItem('cove.theme', t)
    set({ theme: t })
    get().applyTheme()
  },
  applyTheme: () => {
    const { theme } = get()
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    document.documentElement.setAttribute('data-theme', resolved)
    window.cove.setTheme?.(theme)
  },
  loadChats: async (workspaceId) => {
    // Reuse an in-flight load so two concurrent callers can't each create a chat.
    const pending = chatLoadInflight.get(workspaceId)
    if (pending) return pending
    const run = (async (): Promise<Chat[]> => {
      let list = await window.cove.chatList(workspaceId)
      // Every project has at least one chat, so the UI never has an empty state
      // to special-case (pre-existing projects get theirs from the migration).
      if (list.length === 0) {
        await window.cove.chatCreate(workspaceId)
        list = await window.cove.chatList(workspaceId)
      }
      set((s) => ({
        chats: { ...s.chats, [workspaceId]: list },
        activeChatId: {
          ...s.activeChatId,
          [workspaceId]:
            // `||`, not `??`: removeChat writes '' when it deletes the last
            // chat, and ?? kept that empty string — so the replacement chat was
            // created and then never selected, leaving the pane on "Starting…"
            // with no way back.
            s.activeChatId[workspaceId] ||
            // Prefer the chat that was on screen last run, if it still exists.
            (() => {
              const saved = localStorage.getItem(`activeChat:${workspaceId}`)
              return saved && list.some((c) => c.id === saved)
                ? saved
                : list[list.length - 1].id
            })()
        }
      }))
      return list
    })()
    chatLoadInflight.set(workspaceId, run)
    try {
      return await run
    } finally {
      chatLoadInflight.delete(workspaceId)
    }
  },
  newChat: async (workspaceId) => {
    const id = await window.cove.chatCreate(workspaceId)
    const list = await window.cove.chatList(workspaceId)
    set((s) => ({
      chats: { ...s.chats, [workspaceId]: list },
      activeChatId: { ...s.activeChatId, [workspaceId]: id }
    }))
  },
  newChatInWorktree: async (workspaceId, projectPath) => {
    const wt = await window.cove.worktreeCreate(projectPath)
    if (!wt) return false // not a git repo, or git refused — caller says so
    const id = await window.cove.chatCreate(workspaceId, wt.path)
    const list = await window.cove.chatList(workspaceId)
    set((s) => ({
      chats: { ...s.chats, [workspaceId]: list },
      activeChatId: { ...s.activeChatId, [workspaceId]: id }
    }))
    return true
  },
  selectChat: (workspaceId, chatId) => {
    // Opening a conversation is reading it.
    get().markRead(chatId)
    localStorage.setItem(`activeChat:${workspaceId}`, chatId)
    set((s) => ({ activeChatId: { ...s.activeChatId, [workspaceId]: chatId } }))
  },
  removeChat: async (workspaceId, chatId) => {
    const dying = get().chats[workspaceId]?.find((c) => c.id === chatId)
    if (dying?.cwd && dying.cwd.includes('/.worktrees/')) {
      const projectPath = dying.cwd.split('/.worktrees/')[0]
      void window.cove.worktreeRemove(projectPath, dying.cwd)
    }
    await window.cove.chatDelete(chatId)
    const list = await window.cove.chatList(workspaceId)
    set((s) => {
      const active = s.activeChatId[workspaceId]
      return {
        chats: { ...s.chats, [workspaceId]: list },
        // Deleting the open chat falls back to the newest survivor.
        activeChatId: {
          ...s.activeChatId,
          [workspaceId]: active === chatId ? (list[list.length - 1]?.id ?? '') : active
        }
      }
    })
    if (list.length === 0) await get().loadChats(workspaceId)
  },
  renameChat: async (workspaceId, chatId, title) => {
    await window.cove.chatUpdate(chatId, { title })
    get().touchChat(workspaceId, chatId, { title })
  },
  touchChat: (workspaceId, chatId, patch) =>
    set((s) => ({
      chats: {
        ...s.chats,
        [workspaceId]: (s.chats[workspaceId] ?? []).map((c) =>
          c.id === chatId ? { ...c, ...patch } : c
        )
      }
    })),

  registerAgent: (workspaceId, agentId) =>
    set((s) => ({ agentIds: { ...s.agentIds, [workspaceId]: agentId } })),

  markUnread: (chatId) =>
    set((s) => (s.unread[chatId] ? s : { unread: { ...s.unread, [chatId]: true } })),
  markRead: (chatId) =>
    set((s) => {
      if (!s.unread[chatId]) return s
      const next = { ...s.unread }
      delete next[chatId]
      return { unread: next }
    }),
  setBusy: (chatId, state) =>
    set((s) => {
      const prev = s.busy[chatId]
      // Reported from an effect on every turn tick; bail when nothing moved so
      // subscribers don't re-render on identical state.
      if (prev && prev.generating === state.generating && prev.background === state.background) {
        return s
      }
      return { busy: { ...s.busy, [chatId]: state } }
    }),
  clearBusy: (chatId) =>
    set((s) => {
      if (!(chatId in s.busy)) return s
      const next = { ...s.busy }
      delete next[chatId]
      return { busy: next }
    }),

  setAgentLive: (workspaceId, chatId, value) =>
    set((s) => {
      const wasLive = chatId in s.agentLiveChats
      if (wasLive === value) return s
      const liveChats = { ...s.agentLiveChats }
      if (value) liveChats[chatId] = workspaceId
      else delete liveChats[chatId]
      // The workspace dot is the union: live if any of its chats still is.
      const anyLive = Object.values(liveChats).includes(workspaceId)
      return Boolean(s.agentLive[workspaceId]) === anyLive
        ? { agentLiveChats: liveChats }
        : { agentLiveChats: liveChats, agentLive: { ...s.agentLive, [workspaceId]: anyLive } }
    }),
  sendToClaude: (workspaceId, text) => {
    // Send as a chat message to the streaming agent (the single Chat mode). The
    // chat itself does the delivering: it knows which of the project's
    // conversations is on screen, and whether its process was reaped while the
    // project sat in the background (in which case it queues and wakes it).
    window.dispatchEvent(
      new CustomEvent('cove:easy-user-message', { detail: { workspaceId, text } })
    )
  },

  startHookListener: () => {
    // Hooks power the status badges + agent notifications; there's no user toggle
    // anymore, so keep them always on — install on first run if not present.
    window.cove.hooksStatus().then((v) => {
      if (v) set({ hooksEnabled: true })
      else window.cove.hooksInstall().then((res) => set({ hooksEnabled: res.ok }))
    })
    window.cove.onHookEvent((e) => {
      if (!e.workspaceId) return
      if (e.status) {
        set((s) => ({ statuses: { ...s.statuses, [e.workspaceId]: e.status! } }))
        // Refresh the preview when Claude finishes a turn, if enabled for this workspace.
        if (e.status === 'idle') {
          const s = get()
          // reloadOnIdle defaults to true (matches the toolbar toggle's default),
          // so a code project with the preview open refreshes after Claude's turn.
          // Browser projects have browserOpen undefined here, so they're skipped —
          // we don't want to reload a page the user is having Claude drive.
          if (s.browserOpen[e.workspaceId] && (s.reloadOnIdle[e.workspaceId] ?? true)) {
            window.cove.browserReload(e.workspaceId)
          }
          // Let the file tree re-read the project (Claude may have added/removed files).
          window.dispatchEvent(
            new CustomEvent('cove:workspace-idle', { detail: { workspaceId: e.workspaceId } })
          )
        }
      }
      if (e.sessionId) {
        window.cove.updateWorkspace(e.workspaceId, { lastSessionId: e.sessionId })
      }
    })
    window.cove.onFocusWorkspace((workspaceId) => {
      if (workspaceId) set({ activeWorkspaceId: workspaceId })
    })
  },

  addGroup: async () => {
    const tree = await window.cove.createGroup('New group')
    set({ tree })
  },
  renameGroup: async (id, name) => {
    const tree = await window.cove.updateGroup(id, { name })
    set({ tree })
  },
  deleteGroup: async (id) => {
    const tree = await window.cove.deleteGroup(id)
    set({ tree })
  },
  moveGroup: async (groupId, toIndex) => {
    const tree = await window.cove.moveGroup(groupId, toIndex)
    set({ tree })
  },
  renameWorkspace: async (id, name) => {
    const tree = await window.cove.updateWorkspace(id, { name })
    set({ tree })
  },
  toggleCollapse: async (id, collapsed) => {
    const tree = await window.cove.updateGroup(id, { collapsed: collapsed ? 1 : 0 })
    set({ tree })
  },
  // Straight to the folder picker — browser projects have their own entry
  // point (the Browse section's +), so the Code-vs-Browser chooser was a
  // pointless extra click.
  addWorkspace: async (groupId) => {
    await get().createCodeProject(groupId)
  },
  newProjectGroupId: null,
  closeNewProject: () => set({ newProjectGroupId: null }),
  createCodeProject: async (groupId) => {
    const picked = await window.cove.pickFolder()
    if (!picked) return
    const { tree, workspaceId } = await window.cove.createWorkspace(
      groupId,
      picked.name,
      picked.path
    )
    set({ tree, activeWorkspaceId: workspaceId, newProjectGroupId: null })
  },
  createBrowserProject: async (groupId) => {
    const { tree, workspaceId } = await window.cove.createBrowserWorkspace(
      groupId,
      'Browser project'
    )
    set({ tree, activeWorkspaceId: workspaceId, newProjectGroupId: null })
  },
  // Open a known folder (e.g. a git sub-repo) as its own code project + session.
  openFolderAsProject: async (groupId, name, path) => {
    const existing = get()
      .tree.flatMap((g) => g.workspaces)
      .find((w) => w.path === path)
    if (existing) {
      set({ activeWorkspaceId: existing.id }) // already open — just focus it
      return
    }
    const { tree, workspaceId } = await window.cove.createWorkspace(groupId, name, path)
    set({ tree, activeWorkspaceId: workspaceId })
  },
  removeWorkspace: async (id) => {
    // Tear down the workspace's browser view. The PTY and Easy-mode agent are
    // stopped by their panes' unmount effects, but the WebContentsView has no
    // such hook (it's kept alive across preview toggles), so destroy it here.
    window.cove.browserDestroy(id)
    const tree = await window.cove.deleteWorkspace(id)
    set({ tree })
    if (get().activeWorkspaceId === id) {
      const first = tree.flatMap((g) => g.workspaces)[0]
      set({ activeWorkspaceId: first?.id ?? null })
    }
  },
  moveWorkspace: async (workspaceId, toGroupId, toIndex) => {
    const tree = await window.cove.moveWorkspace(workspaceId, toGroupId, toIndex)
    set({ tree })
  }
}))

/**
 * While `active`, register an open HTML overlay so the native browser view
 * hides itself (native WebContentsViews always paint above HTML and would
 * otherwise cover slide-overs and modals).
 */
export function useOverlayLock(active = true): void {
  const enterOverlay = useStore((s) => s.enterOverlay)
  const exitOverlay = useStore((s) => s.exitOverlay)
  useEffect(() => {
    if (!active) return
    enterOverlay()
    return exitOverlay
  }, [active, enterOverlay, exitOverlay])
}
