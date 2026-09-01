import { create } from 'zustand'
import { useEffect } from 'react'
import type { TreeGroup, Routine, Chat } from '../../preload'

export type WorkspaceStatus = 'idle' | 'working' | 'needs-you'

// How the app opens a file by extension. Text/code/markdown render in the in-app
// viewer/editor; these binary types preview inline in the browser pane; anything
// else goes to the OS. Shared by the file tree and the agent's open_file tool.
export const FILE_TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'xml',
  'csv',
  'log',
  'yml',
  'yaml',
  'toml',
  'ini',
  'env',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'html',
  'htm',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'rb',
  'php',
  'swift',
  'kt',
  'sql',
  'sh',
  'bash',
  'zsh'
])
export const FILE_PREVIEW_EXTS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'bmp',
  'avif'
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

/**
 * The key a workspace's pane-visibility state lives under. Which surface is open
 * (browser / files / board / a file) is remembered per CONVERSATION, so two
 * chats in one project can have different setups — one on a webpage, another on
 * nothing. So it keys off the workspace's active chat, falling back to the
 * workspace id when there's no chat yet (or when handed an id that is itself a
 * chat). The native browser view and its login session stay per-workspace
 * (paneId = ws.id), so switching chats swaps what's shown, not who you're
 * logged in as.
 */
function deskKey(s: { activeChatId: Record<string, string> }, id: string): string {
  return s.activeChatId[id] ?? id
}

/**
 * The key of a workspace's browser VIEW — `workspace::chat`, so each conversation
 * drives its own native pane (chat A on a PDF, chat B on a website) while sharing
 * the workspace's login. Matches the paneId WorkspaceView renders and the agent's
 * MCP PANE_ID. Falls back to the workspace id before a chat is selected.
 */
function browserKey(s: { activeChatId: Record<string, string> }, workspaceId: string): string {
  const c = s.activeChatId[workspaceId]
  return c ? `${workspaceId}::${c}` : workspaceId
}

// Whether the browser pane is open per workspace. Kept only in memory: a cold
// app start always lands on the chat with the pane closed, so we never reopen a
// logged-out site as a floating login card. Within a session the map persists as
// normal zustand state.

/**
 * Why a Keep failed, in words a user can act on — no branch/worktree/merge
 * jargon. Shared by the menu flow (App.tsx) and the delete guard.
 */
/**
 * Two paths mean the same working copy. git and the app build these strings
 * separately, so a trailing slash on one side was enough to make a branch look
 * like it had no chat — and clicking it then made a duplicate.
 */
/**
 * A branch name from a sentence. Used both when a chat's title changes and when
 * its branch is first cut from the opening message, so the two agree.
 */
export function branchSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** A chat that has not been given a branch yet — it has sent nothing. */
/**
 * When you last had a conversation open, per chat.
 *
 * The in-memory `unread` flag only ever covered a narrow case: it is set by the
 * chat component noticing a turn finish while you were elsewhere, so it needs
 * that component mounted — which it is only for the project you are in — and it
 * is gone the moment the app quits. A conversation that moved in another
 * project, or overnight, left no mark at all.
 *
 * So the mark is also kept here, against the conversation's own updatedAt: it
 * survives a restart, it covers every project, and it is the same rule the
 * phone uses.
 */
const SEEN_KEY = 'cove.chatSeen'

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* no storage: unread falls back to the in-memory flag */
  }
}

function seenNow(chatId: string): void {
  const seen = readSeen()
  seen[chatId] = Date.now()
  writeSeen(seen)
}

/**
 * Anything never seen before is recorded as read where it stands — otherwise
 * every conversation on the machine lights up the first time this ships.
 */
export function noteChatsSeen(chats: { id: string; updatedAt?: number }[]): void {
  const seen = readSeen()
  let changed = false
  for (const c of chats) {
    if (seen[c.id] === undefined) {
      seen[c.id] = c.updatedAt ?? Date.now()
      changed = true
    }
  }
  if (changed) writeSeen(seen)
}

/** Has this conversation moved since you last had it open? */
export function movedSinceSeen(chat: { id: string; updatedAt?: number }): boolean {
  const at = readSeen()[chat.id]
  if (at === undefined || !chat.updatedAt) return false
  return chat.updatedAt > at
}

/**
 * Leave whatever full-window surface is up.
 *
 * The Computer, Chats, the dashboard and Settings all cover the projects
 * completely, and the ONLY thing that dismisses them is this event — which the
 * sidebar fires when you click a project row. Creating a project set it as
 * active and never fired it, so a folder added while any of those was on screen
 * became the active project behind a full-window surface and nothing appeared
 * to happen. Adding it again looked like the fix; clicking the row it had
 * already made was the actual fix.
 */
function leaveFullWindowSurfaces(): void {
  window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
}

export function isPendingBranch(chatId: string): boolean {
  try {
    return localStorage.getItem(`pendingBranch:${chatId}`) === '1'
  } catch {
    return false
  }
}

export function normalizeCwd(p: string | null | undefined): string {
  if (!p) return ''
  // macOS resolves /var, /tmp and /etc through /private. main re-roots git's
  // answers onto the app's spelling, but strip it here too so a path that
  // arrives from anywhere else still compares equal.
  return p.replace(/^\/private(?=\/(var|tmp|etc)\/)/, '').replace(/\/+$/, '')
}

export function keepErrorText(reason: string, detail?: string): string {
  const map: Record<string, string> = {
    'base-dirty':
      "The project has changes that aren't saved yet. Save or discard them in the project first, then keep.",
    conflict:
      'These changes clash with something already in the project. Ask the agent in this chat to resolve it, then keep again. Nothing was changed.',
    nothing: "Nothing to keep — this chat didn't change anything.",
    'not-worktree': "This chat doesn't have its own copy of the project.",
    error: detail || 'git failed.'
  }
  return map[reason] ?? "Couldn't keep the changes."
}

/**
 * Only modes that need no prompt: Superagent drives `claude -p`, where there is
 * nowhere to answer a permission request, so an asking mode would silently deny
 * and the tool would just fail.
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'plan' | 'ask'

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
  overlay: 'computer' | 'chats' | null
  setOverlay: (o: 'computer' | 'chats' | null) => void
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
  // deskId targets a SPECIFIC chat's desk (an agent reveal for a background
  // chat), instead of the workspace's currently-active chat. Omit for user
  // actions, which always mean "the chat I'm looking at".
  openFileInViewer: (
    workspaceId: string,
    path: string,
    focus?: boolean,
    deskId?: string | null
  ) => void
  closeFile: (workspaceId: string) => void
  // Open an absolute file path the right way: text/code/markdown in the in-app
  // viewer, PDFs/images in the preview pane, everything else in the OS default.
  // Shared by the file tree and the agent's open_file tool.
  openPath: (workspaceId: string, absPath: string, focus?: boolean, deskId?: string | null) => void

  // Count of open HTML overlays (slide-overs, modals). While > 0 the native
  // browser view is hidden so it can't cover them.
  overlayCount: number
  enterOverlay: () => void
  exitOverlay: () => void

  refresh: () => Promise<void>
  setActive: (id: string) => void
  /**
   * Map a desk id (which may be a chat id, now that each chat has its own desk)
   * back to the workspace that owns it. Returns the id unchanged if it's already
   * a workspace, the owning workspace if it's a chat, or null if neither — so
   * `activeWorkspaceId` is NEVER set to a chat id (which would select a
   * non-existent project and blank the screen).
   */
  resolveWorkspace: (deskId: string) => string | null
  setStatus: (workspaceId: string, status: WorkspaceStatus) => void
  addPort: (workspaceId: string, port: number) => void
  removePort: (workspaceId: string, port: number) => void
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
  /** Set when a turn edited files, so idle-reload only fires when the page could
      have actually changed — asking a question no longer reloads the preview. */
  previewDirty: Record<string, boolean>
  markPreviewDirty: (workspaceId: string) => void
  toast: { workspaceId: string; port: number } | null
  openPreview: (workspaceId: string, port: number, deskId?: string | null) => void
  /** Reveal the browser pane on an arbitrary URL (e.g. a file:// from the tree). */
  openUrl: (workspaceId: string, url: string, focus?: boolean, deskId?: string | null) => void
  dismissToast: () => void
  setReloadOnIdle: (workspaceId: string, v: boolean) => void

  browsingWorkspaceId: string | null
  /**
   * Desks whose pane the USER closed while an agent was browsing, by desk key →
   * when. While an entry exists, automation activity must not auto-reveal that
   * pane again — the user's close outranks the agent's "look at this". Cleared
   * when the workspace's turn goes idle or the pane is reopened.
   */
  userClosedPaneAt: Record<string, number>
  /** The full pane id (workspace::chat) the agent is browsing — what the Stop
      button must target, since automation is keyed by pane, not workspace. */
  browsingPaneId: string | null
  stopBrowsing: () => void
  startBrowsingListener: () => void

  // Chats belonging to each project, and which one is on screen. A project can
  // hold many conversations; only the active one keeps a live claude process.
  chats: Record<string, Chat[]>
  activeChatId: Record<string, string>
  refreshChats: () => Promise<void>
  loadChats: (workspaceId: string) => Promise<Chat[]>
  /**
   * New conversation. On a git repo this ALSO creates a private worktree —
   * a chat is a checkout — falling back to a plain chat if git refuses.
   */
  newChat: (workspaceId: string) => Promise<void>
  /**
   * Cut the branch a pending chat has been waiting for, named from its opening
   * message, and return the directory the agent must run in. null when there is
   * nothing to do — the chat already has a copy, or the project is not a repo.
   */
  materializeBranch: (
    workspaceId: string,
    chatId: string,
    hint: string
  ) => Promise<string | null>
  /** Open a branch's conversation, creating one if that branch has none. null = the project folder. */
  openBranch: (workspaceId: string, cwd: string | null) => Promise<void>
  /**
   * A named branch: its own checkout, its own conversation, running alongside
   * whatever else is open. This is the only thing that makes a worktree now.
   */
  newBranch: (
    workspaceId: string,
    name: string
  ) => Promise<
    | { ok: true; branch: string; path: string }
    | { ok: false; reason: 'not-a-project' | 'not-a-repo' | 'git-refused' }
  >
  selectChat: (workspaceId: string, chatId: string) => void
  /**
   * Delete a conversation. A worktree chat with unkept changes gets the native
   * Keep / Throw away / Cancel dialog first; `force` skips it (the user already
   * confirmed a Throw away, or Keep just merged).
   */
  removeChat: (workspaceId: string, chatId: string, force?: boolean) => Promise<void>
  /**
   * Keep a worktree chat's changes: squash them into the branch it was cut
   * from, then remove the chat. Returns worktree:merge's result verbatim.
   */
  keepWorktreeChat: (
    workspaceId: string,
    chatId: string
  ) => Promise<
    | { ok: true; committed: boolean }
    | {
        ok: false
        reason: 'not-worktree' | 'base-dirty' | 'nothing' | 'conflict' | 'error'
        detail?: string
      }
  >
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
  /** Give a project its first conversation, if it has none. */
  startFirstChat: (workspaceId: string) => Promise<void>
  /** Put a conversation where you dropped it, within its project. */
  moveChat: (chatId: string, beforeChatId: string) => Promise<void>
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
    set((s) =>
      s.pageUrl[workspaceId] === url ? s : { pageUrl: { ...s.pageUrl, [workspaceId]: url } }
    ),
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
  openFileInViewer: (workspaceId, path, focus = true, deskId) => {
    // Which surface is open is per CHAT (each conversation has its own setup),
    // so the visibility maps are keyed by the workspace's active chat. Focus
    // still follows the workspace. deskKey() resolves ws → its active chat;
    // deskId overrides it to reveal on a specific (background) chat's desk.
    const key = deskId ?? deskKey(get(), workspaceId)
    localStorage.setItem(`openFile:${key}`, path)
    const focusWs = focus ? get().resolveWorkspace(workspaceId) : null
    set((s) => ({
      // Only a USER action may move the user. The agent opening its results must
      // land in its own project quietly — yanking the active workspace mid-typing
      // is the "app hijacks my work" bug.
      ...(focusWs ? { activeWorkspaceId: focusWs } : {}),
      openFile: { ...s.openFile, [key]: path }
    }))
  },
  closeFile: (workspaceId) => {
    const key = deskKey(get(), workspaceId)
    localStorage.removeItem(`openFile:${key}`)
    set((s) => ({ openFile: { ...s.openFile, [key]: null } }))
  },
  openPath: (workspaceId, absPath, focus = true, deskId) => {
    const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase()
    if (FILE_TEXT_EXTS.has(ext)) {
      get().openFileInViewer(workspaceId, absPath, focus, deskId)
    } else if (FILE_PREVIEW_EXTS.has(ext)) {
      // encodeURI (not encodeURIComponent) so path separators survive.
      get().openUrl(workspaceId, `file://${encodeURI(absPath)}`, focus, deskId)
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
  previewDirty: {},
  toast: null,
  browsingWorkspaceId: null,
  browsingPaneId: null,
  userClosedPaneAt: {},
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
  resolveWorkspace: (deskId) => {
    const s = get()
    if (s.tree.some((g) => g.workspaces.some((w) => w.id === deskId))) return deskId
    for (const [wsId, chats] of Object.entries(s.chats)) {
      if (chats.some((c) => c.id === deskId)) return wsId
    }
    return null
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
  // Drop a port from the chip (e.g. after "Stop the server" kills it).
  removePort: (workspaceId, port) =>
    set((s) => {
      const ports = {
        ...s.ports,
        [workspaceId]: (s.ports[workspaceId] ?? []).filter((p) => p !== port)
      }
      savePorts(ports)
      return { ports }
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
      const key = deskKey(s, workspaceId)
      const next = !s.filesOpen[key]
      localStorage.setItem(`filesOpen:${key}`, next ? '1' : '0')
      return { filesOpen: { ...s.filesOpen, [key]: next } }
    }),

  toggleBrowser: (workspaceId, current) =>
    set((s) => {
      const key = deskKey(s, workspaceId)
      const saved = localStorage.getItem(`paneOpen:${key}`)
      const effective = current ?? s.browserOpen[key] ?? (saved !== null ? saved === '1' : false)
      const next = !effective
      // Remembered so a code project's preview survives an app restart. Browser
      // projects deliberately don't restore (a cold start must not land on a
      // reloaded, often logged-out live page) — see the coldStart flag.
      localStorage.setItem(`paneOpen:${key}`, next ? '1' : '0')
      const browserOpen = { ...s.browserOpen, [key]: next }
      // Closing while the agent is browsing must STICK: without this record the
      // very next automation event auto-revealed the pane again, so during a
      // long agent-driven browse the card kept popping back over whatever the
      // user was doing ("it blocks every other action"). Cleared when the turn
      // goes idle, or when the pane is opened again.
      const userClosedPaneAt = { ...s.userClosedPaneAt }
      if (next) delete userClosedPaneAt[key]
      else userClosedPaneAt[key] = Date.now()
      return { browserOpen, coldStart: false, userClosedPaneAt }
    }),
  setHooksEnabled: (v) => set({ hooksEnabled: v }),

  openPreview: (workspaceId, port, deskId) => {
    // Check before opening: the chip is scraped from the agent's output, so it
    // can name a server that has since stopped. Showing ERR_CONNECTION_REFUSED
    // and leaving a green dot claiming it is running cannot both be right.
    void window.cove.checkPort(port).then((alive) => {
      if (!alive) void get().verifyPorts()
    })
    const focusWs = get().resolveWorkspace(workspaceId)
    set((s) => {
      // Visibility (browserOpen) is per chat; the URL to load is per chat's VIEW
      // (workspace::chat), so opening a preview in one chat doesn't change another.
      // deskId targets a specific (background) chat's desk/view; without it the
      // preview lands on the active chat, which was the "wrong session" bug.
      const key = deskId ?? deskKey(s, workspaceId)
      const view = deskId ? `${workspaceId}::${deskId}` : browserKey(s, workspaceId)
      localStorage.setItem(`paneOpen:${key}`, '1')
      const browserOpen = { ...s.browserOpen, [key]: true }
      return {
        ...(focusWs ? { activeWorkspaceId: focusWs } : {}),
        browserOpen,
        coldStart: false,
        previewUrls: { ...s.previewUrls, [view]: `http://localhost:${port}` },
        toast: null
      }
    })
  },
  openUrl: (workspaceId, url, focus = true, deskId) => {
    const focusWs = focus ? get().resolveWorkspace(workspaceId) : null
    set((s) => {
      // deskId reveals on a specific (background) chat's desk/view; without it a
      // PDF/URL opened by a background chat's agent landed on the active chat.
      const key = deskId ?? deskKey(s, workspaceId)
      const view = deskId ? `${workspaceId}::${deskId}` : browserKey(s, workspaceId)
      localStorage.setItem(`paneOpen:${key}`, '1')
      const browserOpen = { ...s.browserOpen, [key]: true }
      // The viewer and the pane are the same slot, and the viewer wins it. A
      // text file left open therefore swallowed every PDF and image opened
      // afterwards: the row highlighted, the page loaded, and nothing changed
      // on screen. Whatever was asked for last is what you want to see.
      localStorage.removeItem(`openFile:${key}`)
      return {
        ...(focusWs ? { activeWorkspaceId: focusWs } : {}),
        browserOpen,
        coldStart: false,
        openFile: { ...s.openFile, [key]: null },
        previewUrls: { ...s.previewUrls, [view]: url },
        toast: null
      }
    })
  },
  dismissToast: () => set({ toast: null }),
  setReloadOnIdle: (workspaceId, v) =>
    set((s) => ({ reloadOnIdle: { ...s.reloadOnIdle, [workspaceId]: v } })),
  markPreviewDirty: (workspaceId) =>
    set((s) =>
      s.previewDirty[workspaceId] ? s : { previewDirty: { ...s.previewDirty, [workspaceId]: true } }
    ),

  stopBrowsing: () => {
    // Stop the exact pane the agent is driving (workspace::chat) — stopping by
    // workspace id would miss a per-chat pane and the automation would carry on.
    const id = get().browsingPaneId
    if (id) window.cove.browserStopAutomation(id)
    set({ browsingWorkspaceId: null, browsingPaneId: null })
  },
  startBrowsingListener: () => {
    let timer: ReturnType<typeof setTimeout> | null = null
    window.cove.onBrowserActivity((paneId) => {
      // Routine runs drive an offscreen pane ("<workspaceId>::routine") — ignore
      // those; they must never steal the viewport or flip a panel open. Note the
      // suffix check is ::routine specifically: a per-chat pane is also
      // "<workspace>::<chatId>", and that one we DO want to reveal.
      if (paneId.endsWith('::routine')) return
      // paneId is "<workspace>::<chatId>" for a per-chat view (or bare workspace).
      const workspaceId = paneId.split('::')[0]
      const chatId = paneId.split('::')[1]
      set({ browsingWorkspaceId: workspaceId, browsingPaneId: paneId })
      // The agent is driving the in-app browser — reveal the preview pane if it's
      // hidden (e.g. a code project) so the user can watch what it's doing.
      const s = get()
      const known = s.tree.some((g) => g.workspaces.some((w) => w.id === workspaceId))
      // Reveal for the SPECIFIC chat whose agent is browsing (its own view), not
      // whichever chat happens to be active.
      const key = chatId ?? workspaceId
      // The user closed this pane mid-browse: that decision STICKS for the rest
      // of the turn. Re-revealing on every tool call made the card pop back over
      // whatever they were doing, endlessly, until the agent finished.
      if (known && !s.browserOpen[key] && !s.userClosedPaneAt[key]) {
        // Persist too — an agent-opened pane must survive restarts exactly like
        // a user-opened one (this was the hole: agent panes vanished on update).
        localStorage.setItem(`paneOpen:${key}`, '1')
        set({ browserOpen: { ...s.browserOpen, [key]: true } })
      }
      if (timer) clearTimeout(timer)
      // Auto-clear the indicator a few seconds after the last tool call.
      timer = setTimeout(() => set({ browsingWorkspaceId: null, browsingPaneId: null }), 4000)
    })
    // A turn finished: the user's "keep it closed" veto expires with the turn
    // that provoked it — the NEXT turn's browsing may reveal again.
    window.addEventListener('cove:workspace-idle', (e) => {
      const wsId = (e as CustomEvent<{ workspaceId: string }>).detail?.workspaceId
      if (!wsId) return
      const s = get()
      const keep: Record<string, number> = {}
      for (const [k, at] of Object.entries(s.userClosedPaneAt)) {
        if (s.resolveWorkspace(k) !== wsId && k !== wsId) keep[k] = at
      }
      if (Object.keys(keep).length !== Object.keys(s.userClosedPaneAt).length) {
        set({ userClosedPaneAt: keep })
      }
    })
    // Cold start: the agent navigated the browser before the preview was open.
    // Reveal it (and focus the project) so the pane gets created and the page shows.
    window.cove.onBrowserRequestOpen((paneId) => {
      // The broadcast carries the agent's pane id — "<workspace>::<chatId>" for a
      // per-chat view (or a bare workspace). Split it: the workspace is what the
      // tree and activeWorkspaceId want; the chat is what browserOpen keys on.
      const workspaceId = paneId.split('::')[0]
      const chatId = paneId.split('::')[1]
      const s = get()
      if (!s.tree.some((g) => g.workspaces.some((w) => w.id === workspaceId))) return
      // Reveal the pane in ITS OWN session so the page is ready when the user
      // looks — but never switch the active session for them. A background
      // session's agent opening a page must not yank you off the session you're
      // working in (it did, whenever the app was frontmost). You'll see the page
      // when you choose to go to that session; the agent drives it in the
      // meantime through the main process regardless of what's on screen.
      const key = chatId ?? workspaceId
      // Same veto as the activity path: a pane the user closed this turn stays
      // closed even for an explicit navigate — their close outranks the agent.
      if (s.userClosedPaneAt[key]) return
      // Persist here too. This handler runs BEFORE any browser:activity event
      // and marks the pane open in memory — which made the activity listener's
      // "not open yet" persist guard skip, so agent-opened panes still vanished
      // on restart (seen live: levantto-shop).
      localStorage.setItem(`paneOpen:${key}`, '1')
      set({ browserOpen: { ...s.browserOpen, [key]: true }, coldStart: false })
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
      const list = await window.cove.chatList(workspaceId)
      noteChatsSeen(list)
      // A chat that has its copy is not waiting for one. The phone can cut the
      // branch now, and it clears the flag in main — this clears the window's
      // copy, which is otherwise mirrored straight back and the chat would sit
      // under "no branch yet" for ever with its branch row showing no chat.
      for (const c of list) {
        if (!c.cwd) continue
        try {
          localStorage.removeItem(`pendingBranch:${c.id}`)
        } catch {
          /* no storage: the flag was never set either */
        }
      }
      // Every project has at least one chat, so the UI never has an empty state
      // to special-case (pre-existing projects get theirs from the migration).
      // A project with no conversations stays that way. This used to make one
      // on the spot so the UI never had an empty state — but the sidebar reloads
      // chats whenever anything changes, so deleting your only chat recreated it
      // instantly and delete looked like it had done nothing. Clicking the
      // project row opens one when you actually want it.
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
              if (list.length === 0) return ''
              const saved = localStorage.getItem(`activeChat:${workspaceId}`)
              return saved && list.some((c) => c.id === saved) ? saved : list[list.length - 1].id
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
    // A branch costs a directory, a git ref and a row in your sidebar, and until
    // you have said anything there is nothing to name it after. So a new chat is
    // only a conversation; the branch is cut on the first message, named from
    // what you actually asked for. A chat you open and never use leaves nothing
    // behind, which is where every stray wt-… branch came from.
    const ws = get()
      .tree.flatMap((g) => g.workspaces)
      .find((w) => w.id === workspaceId)
    const id = await window.cove.chatCreate(workspaceId)
    if (ws && ws.kind !== 'browser' && (await window.cove.gitBranch(ws.path)) !== null) {
      try {
        localStorage.setItem(`pendingBranch:${id}`, '1')
      } catch {
        // no storage: the chat simply works in the folder, as it used to
      }
    }
    const list = await window.cove.chatList(workspaceId)
    set((s) => ({
      chats: { ...s.chats, [workspaceId]: list },
      activeChatId: { ...s.activeChatId, [workspaceId]: id }
    }))
    window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: { workspaceId } }))
  },
  materializeBranch: async (workspaceId, chatId, hint) => {
    // Called once, immediately before the agent starts. Claim the flag FIRST:
    // two starts racing must not both cut a branch for one chat.
    if (!isPendingBranch(chatId)) return null
    try {
      localStorage.removeItem(`pendingBranch:${chatId}`)
    } catch {
      /* claimed anyway */
    }
    const ws = get()
      .tree.flatMap((g) => g.workspaces)
      .find((w) => w.id === workspaceId)
    if (!ws || ws.kind === 'browser') return null
    // The rule itself lives in main: when a chat gets its own copy, and what
    // the branch is called. The phone's send path calls the same one, so a
    // conversation started there is not left running in the project folder.
    // git refusing (a name taken, an empty repo) comes back as null, and the
    // folder itself is a working answer — losing the message would not be.
    const cwd = await window.cove.chatEnsureBranch(chatId, ws.path, hint ?? '')
    if (!cwd) return null
    const list = await window.cove.chatList(workspaceId)
    set((s) => ({ chats: { ...s.chats, [workspaceId]: list } }))
    window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: { workspaceId } }))
    return cwd
  },
  newBranch: async (workspaceId, name) => {
    // A branch is a second checkout of the project, on its own branch, with its
    // own conversation — the thing you make when you want the agent kept off
    // your files, or two of them running at once. The name is the user's, so
    // renameChat's auto-rename (superagent/* only) will not touch it later.
    const ws = get()
      .tree.flatMap((g) => g.workspaces)
      .find((w) => w.id === workspaceId)
    if (!ws || ws.kind === 'browser') return { ok: false as const, reason: 'not-a-project' as const }
    if ((await window.cove.gitBranch(ws.path)) === null) {
      return { ok: false as const, reason: 'not-a-repo' as const }
    }
    const wt = await window.cove.worktreeCreate(ws.path, { newBranch: name })
    // git refuses on a repo with no commits yet, or a name already taken.
    if (!wt) return { ok: false as const, reason: 'git-refused' as const }
    const id = await window.cove.chatCreate(workspaceId, wt.path)
    await window.cove.chatUpdate(id, { title: name })
    const list = await window.cove.chatList(workspaceId)
    set((s) => ({
      chats: { ...s.chats, [workspaceId]: list },
      activeChatId: { ...s.activeChatId, [workspaceId]: id }
    }))
    window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: { workspaceId } }))
    return { ok: true as const, branch: wt.branch, path: wt.path }
  },
  openBranch: async (workspaceId, cwd) => {
    // Clicking a branch opens its conversation, and makes one only if it truly
    // has none. The check used to read the store's chat list, which can lag the
    // database by a tick — so a branch whose chat had just been created looked
    // empty, and clicking it made a SECOND chat on the same worktree. Ask the
    // database, not the cache. `cwd === null` is the project folder itself.
    const want = normalizeCwd(cwd)
    get().setActive(workspaceId)
    const list = await window.cove.chatList(workspaceId)
    const existing = list.find((c) => normalizeCwd(c.cwd ?? null) === want)
    set((s) => ({ chats: { ...s.chats, [workspaceId]: list } }))
    if (existing) {
      get().selectChat(workspaceId, existing.id)
      return
    }
    // Never a SECOND conversation in the project folder itself. A chat on a
    // branch has a copy of its own and cannot be disturbed; a chat on the folder
    // has no copy at all, so two of them are two agents editing one set of files
    // — which is precisely how two sessions trampled each other. main is a place
    // you visit, not a place a second agent can sit down in.
    if (cwd === null) {
      const onFolder = list.find((c) => normalizeCwd(c.cwd ?? null) === '')
      if (onFolder) {
        get().selectChat(workspaceId, onFolder.id)
        return
      }
      // And never a FIRST one either. Clicking the project row opens the
      // conversation in the folder; if there is none it opens the project with
      // none, and the empty state offers + New chat. A chat appears when you
      // ask for one and at no other time — clicking a project to look at it
      // used to leave a new empty conversation behind every time.
      set((s) => ({ activeChatId: { ...s.activeChatId, [workspaceId]: '' } }))
      return
    }
    const id = await window.cove.chatCreate(workspaceId, cwd ?? undefined)
    const fresh = await window.cove.chatList(workspaceId)
    set((s) => ({
      chats: { ...s.chats, [workspaceId]: fresh },
      activeChatId: { ...s.activeChatId, [workspaceId]: id }
    }))
  },
  selectChat: (workspaceId, chatId) => {
    // Opening a conversation is reading it.
    get().markRead(chatId)
    localStorage.setItem(`activeChat:${workspaceId}`, chatId)
    set((s) => ({ activeChatId: { ...s.activeChatId, [workspaceId]: chatId } }))
  },
  keepWorktreeChat: async (workspaceId, chatId) => {
    const chat = get().chats[workspaceId]?.find((c) => c.id === chatId)
    if (!chat?.cwd || !chat.cwd.includes('/.worktrees/')) {
      return { ok: false as const, reason: 'not-worktree' as const }
    }
    const projectPath = chat.cwd.split('/.worktrees/')[0]
    const title = chat.title?.trim()
    const message = title && title !== 'New chat' ? title : 'Keep chat changes'
    const res = await window.cove.worktreeMerge(projectPath, chat.cwd, message)
    if (res.ok) {
      window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: { workspaceId } }))
      // The merge already removed the worktree; force skips the unkept-guard.
      await get().removeChat(workspaceId, chatId, true)
      get().setActive(workspaceId)
    }
    return res
  },
  removeChat: async (workspaceId, chatId, force = false) => {
    const dying0 = get().chats[workspaceId]?.find((c) => c.id === chatId)
    // A worktree chat with unkept work must not vanish on a stray click: ask
    // Keep / Throw away / Cancel first. Clean chats delete silently, as ever.
    if (!force && dying0?.cwd && dying0.cwd.includes('/.worktrees/')) {
      const projectPath = dying0.cwd.split('/.worktrees/')[0]
      const st = await window.cove.worktreeStatus(projectPath, dying0.cwd).catch(() => null)
      if (st && (st.dirty || st.ahead > 0)) {
        const choice = await window.cove.chatConfirmUnkept()
        if (choice === 'cancel') return
        if (choice === 'keep') {
          await keepChatChanges(workspaceId, chatId)
          return // kept (and removed), or failed and the chat stays
        }
        // 'throw' falls through to the normal delete
      }
    }
    // Free the chat's native browser view (workspace::chat) — a full Chromium
    // renderer that otherwise leaked for the life of the app, since only whole
    // workspaces were ever torn down (and even then by the bare id).
    window.cove.browserDestroy(`${workspaceId}::${chatId}`)
    const dying = get().chats[workspaceId]?.find((c) => c.id === chatId)
    if (dying?.cwd && dying.cwd.includes('/.worktrees/')) {
      const projectPath = dying.cwd.split('/.worktrees/')[0]
      // Await it, then tell the sidebar. Firing and forgetting left the branch
      // row on screen after its worktree was gone — the list is read from git,
      // and nothing had asked git again.
      await window.cove.worktreeRemove(projectPath, dying.cwd)
      window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: { workspaceId } }))
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
  },
  renameChat: async (workspaceId, chatId, title) => {
    await window.cove.chatUpdate(chatId, { title })
    get().touchChat(workspaceId, chatId, { title })
    // The chat's branch follows its title (auto-title and manual rename both
    // land here) — "superagent/wt-a3f9k" tells nobody anything; the chat's own
    // name does. Only auto-named superagent/* branches are renamed (main-side
    // guard), so a branch the user asked for by name is never touched. Renaming
    // never moves files — safe mid-session.
    const chat = get().chats[workspaceId]?.find((c) => c.id === chatId)
    if (chat?.cwd && chat.cwd.includes('/.worktrees/')) {
      const slug = branchSlug(title)
      if (slug) {
        void window.cove.worktreeRename(chat.cwd, slug).then(() => {
          // Nudge the sidebar chip (it re-reads the branch on this event).
          window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: { workspaceId } }))
        })
      }
    }
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
  markRead: (chatId) => {
    // Reading it is reading it up to now. Written down, so quitting the app is
    // not the same as reading everything in it.
    seenNow(chatId)
    set((s) => {
      if (!s.unread[chatId]) return s
      const next = { ...s.unread }
      delete next[chatId]
      return { unread: next }
    })
  },
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
          // Only reload when the turn actually edited files: a turn that just
          // answered a question can't have changed the page, and reloading it
          // then is the "why does it keep refreshing?" annoyance.
          const dirty = s.previewDirty[e.workspaceId]
          // browserOpen is per active chat now; the pane is shared per workspace.
          const key = deskKey(s, e.workspaceId)
          if (dirty && s.browserOpen[key] && (s.reloadOnIdle[e.workspaceId] ?? true)) {
            window.cove.browserReload(e.workspaceId)
          }
          if (dirty) {
            set((st) => ({ previewDirty: { ...st.previewDirty, [e.workspaceId]: false } }))
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
    leaveFullWindowSurfaces()
    set({ tree, activeWorkspaceId: workspaceId, newProjectGroupId: null })
    await get().startFirstChat(workspaceId)
  },
  createBrowserProject: async (groupId) => {
    const { tree, workspaceId } = await window.cove.createBrowserWorkspace(
      groupId,
      'Browser project'
    )
    leaveFullWindowSurfaces()
    set({ tree, activeWorkspaceId: workspaceId, newProjectGroupId: null })
    await get().startFirstChat(workspaceId)
  },

  /**
   * The conversation a brand-new project opens with.
   *
   * Clicking a project never makes one — you asked for that, and it is right:
   * looking at something should not leave a chat behind. But ADDING a project
   * is not looking, it is asking to work on it, and landing on an empty pane
   * with a "+ New chat" button to press is a step nobody wanted. Only ever for
   * a project with nothing in it, so it cannot produce a second one.
   */
  moveChat: async (chatId, beforeChatId) => {
    const workspaceId = Object.keys(get().chats).find((wid) =>
      (get().chats[wid] ?? []).some((c) => c.id === chatId)
    )
    if (!workspaceId) return
    const list = get().chats[workspaceId] ?? []
    const to = list.findIndex((c) => c.id === beforeChatId)
    if (to < 0) return
    // Move it locally first: a list that waits for the database to answer
    // snaps back under the pointer before it settles.
    const from = list.findIndex((c) => c.id === chatId)
    if (from < 0) return
    const next = [...list]
    next.splice(from, 1)
    next.splice(to, 0, list[from])
    set((s) => ({ chats: { ...s.chats, [workspaceId]: next } }))
    await window.cove.chatMove(chatId, to)
  },

  startFirstChat: async (workspaceId) => {
    const existing = await window.cove.chatList(workspaceId)
    if (existing.length > 0) {
      set((s) => ({
        chats: { ...s.chats, [workspaceId]: existing },
        activeChatId: { ...s.activeChatId, [workspaceId]: existing[existing.length - 1].id }
      }))
      return
    }
    const id = await window.cove.chatCreate(workspaceId)
    const list = await window.cove.chatList(workspaceId)
    set((s) => ({
      chats: { ...s.chats, [workspaceId]: list },
      activeChatId: { ...s.activeChatId, [workspaceId]: id }
    }))
  },
  // Open a known folder (e.g. a git sub-repo) as its own code project + session.
  openFolderAsProject: async (groupId, name, path) => {
    const existing = get()
      .tree.flatMap((g) => g.workspaces)
      .find((w) => w.path === path)
    if (existing) {
      leaveFullWindowSurfaces()
      set({ activeWorkspaceId: existing.id }) // already open — just focus it
      return
    }
    leaveFullWindowSurfaces()
    const { tree, workspaceId } = await window.cove.createWorkspace(groupId, name, path)
    set({ tree, activeWorkspaceId: workspaceId })
    await get().startFirstChat(workspaceId)
  },
  removeWorkspace: async (id) => {
    // Tear down ALL of the workspace's browser views. The PTY and Easy-mode agent
    // are stopped by their panes' unmount effects, but WebContentsViews have no
    // such hook, and each conversation has its own (workspace::chat) — the old
    // bare-id destroy missed every per-chat pane, leaking them all.
    window.cove.browserDestroyWorkspace(id)
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

/**
 * Keep a chat's changes, and when they clash, offer the one thing that can
 * actually fix it: the agent that wrote them. A conflict leaves everything
 * untouched, so there is nothing to undo first — the agent merges the base into
 * its own branch, resolves, and commits, after which Keep goes through. Every
 * other failure is just reported; they are things only the user can settle.
 */
export async function keepChatChanges(workspaceId: string, chatId: string): Promise<void> {
  const s = useStore.getState()
  const res = await s.keepWorktreeChat(workspaceId, chatId)
  if (res.ok) return
  if (res.reason !== 'conflict') {
    window.alert(keepErrorText(res.reason, res.detail))
    return
  }
  const ask = window.confirm(
    "These changes clash with something already in the project.\n\n" +
      'Nothing has been changed. Shall the agent in this chat sort it out for you?'
  )
  if (!ask) return
  s.setActive(workspaceId)
  s.selectChat(workspaceId, chatId)
  s.sendToClaude(
    workspaceId,
    'Keeping this chat\'s changes failed: they conflict with what is already on the branch ' +
      'this chat was created from. Please merge that base branch into this one, resolve every ' +
      'conflict, check the project still builds, and commit the result. Tell me when it is ready ' +
      'to keep again.'
  )
}
