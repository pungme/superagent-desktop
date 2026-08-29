import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  favicon?: string // data: URI of the current page's favicon, if loaded
}

export interface Workspace {
  id: string
  groupId: string
  name: string
  path: string
  position: number
  browserUrl: string | null
  lastSessionId: string | null
  kind: 'app' | 'browser'
}

export interface TreeGroup {
  id: string
  name: string
  color: string
  collapsed: number
  position: number
  workspaces: Workspace[]
}

export interface Routine {
  id: string
  workspaceId: string
  workspacePath: string
  prompt: string
  intervalMs: number
  enabled: number
  nextRunAt: number
  lastRunAt: number | null
  lastRunStatus: 'ok' | 'error' | 'running' | null
  lastRunSummary: string | null
  lastRunTranscript: string | null
  runCount: number
  lastRunTokens: number
}

/** One step in a routine run's transcript (JSON-encoded in Routine.lastRunTranscript). */
export type RoutineStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input?: string }

/** One conversation inside a project. A project can hold many. */
export interface Chat {
  id: string
  workspaceId: string
  title: string | null
  claudeSessionId: string | null
  updatedAt: number
  /** Worktree override — the chat's agent runs here instead of the project path. */
  cwd: string | null
}

export interface HookEvent {
  workspaceId: string
  event: string
  status?: 'idle' | 'working' | 'needs-you'
  sessionId?: string
  body: Record<string, unknown>
}

import type { PairPayload } from '../shared/companion-protocol'

/** Everything Settings → Phone shows. Mirrors companion/index.ts CompanionState. */
export interface CompanionState {
  machineId: string
  relay: { url: string; state: 'connected' | 'reconnecting' | 'offline'; error: string }
  devices: {
    id: string
    name: string
    model: string
    pushToken: string | null
    pushEnv: string
    createdAt: number
    lastSeenAt: number | null
  }[]
  connected: string[]
  pairing: {
    open: boolean
    payload?: PairPayload
    code?: string
    expiresAt?: number
    request?: { device: { id: string; name: string; model: string } }
  }
  keepAwake: boolean
  keepAwakeAlways: boolean
}

/** A prompt-injection gate awaiting the user's tap before a tool runs. */
export interface GuardrailAsk {
  requestId: string
  workspaceId: string
  sessionId: string
  toolName: string
  preview: string
  /** 'permission' = a real Ask-mode prompt; 'guardrail' = the prompt-injection gate. */
  kind?: 'guardrail' | 'permission'
}

export interface BoardCard {
  id: string
  workspaceId: string
  title: string
  body: string
  status: 'todo' | 'doing' | 'testing' | 'done'
  chatId: string | null
  branch: string | null
  images: string[]
  tags: string[]
  position: number
  createdAt: number
  updatedAt: number
}

export interface CalendarEvent {
  id: string
  title: string
  /** ISO: YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:mm (timed). */
  start: string
  end: string | null
  allDay: boolean
  notes: string
  color: string | null
  createdAt: number
  updatedAt: number
}

export interface CoveApi {
  /** Resolves to the pane's current URL ('' if freshly created / nothing loaded). */
  browserCreate: (id: string, partition: string) => Promise<string>
  browserSetBounds: (id: string, b: { x: number; y: number; width: number; height: number }) => void
  browserHide: (id: string) => void
  browserNavigate: (id: string, url: string) => void
  browserBack: (id: string) => void
  browserForward: (id: string) => void
  browserReload: (id: string) => void
  browserOpenExternal: (id: string) => void
  /** Main asks every mounted pane to re-push its bounds (e.g. after the user returns). */
  onBrowserResync: (cb: () => void) => () => void
  /** Whether the app window is focused — main's word, the renderer can't tell. */
  onAppFocus: (cb: (focused: boolean) => void) => () => void
  browserDestroy: (id: string) => void
  /** Free ALL of a workspace's panes (the bare id + every per-chat pane). */
  browserDestroyWorkspace: (workspaceId: string) => void
  browserZoom: (id: string, action: 'in' | 'out' | 'reset') => Promise<number>
  browserSetZoom: (id: string, factor: number) => void
  /** Corner radius of the native view; uniform, so it's chosen per viewport mode. */
  browserSetRadius: (id: string, radius: number) => void
  /** Side-by-side mode: position the mobile twin (null = tear it down). */
  browserTwinBounds: (
    id: string,
    bounds: { x: number; y: number; width: number; height: number } | null,
    zoom: number
  ) => void
  /** Sampled colours of the page's top corners, for the DOM backfills. */
  browserSampleCorners: (
    id: string
  ) => Promise<{ left: string; right: string; bottom: string } | null>
  /** Full-res PNG bytes of the pane (screenshot tooling). */
  browserShoot: (id: string) => Promise<Uint8Array | null>
  /** PNG of the side-by-side phone twin, if one is on screen. */
  browserShootTwin: () => Promise<Uint8Array | null>
  /** Native context menu for a file-tree row (Reveal in Finder, Copy Path…). */
  filesMenu: (absPath: string) => void
  /** Copy text via Electron's clipboard — works even when the document isn't focused. */
  clipboardWrite: (text: string) => void
  chatMenu: (chatId: string, workspaceId: string, cwd?: string | null) => void
  /** A worktree chat asked to be merged back and finished. */
  onChatMergeWorktree: (
    cb: (p: { chatId: string; workspaceId: string; projectPath: string; wtPath: string }) => void
  ) => () => void
  onChatCleared: (cb: (p: { chatId: string; workspaceId: string }) => void) => () => void
  onChatDeleteRequest: (cb: (p: { chatId: string; workspaceId: string }) => void) => () => void
  /** Explicit "Throw away" confirmed in the native dialog — delete without the guard. */
  onChatThrowAway: (cb: (p: { chatId: string; workspaceId: string }) => void) => () => void
  /** Ask to keep a chat's changes (native dialog, then chat:merge-worktree). */
  chatKeepRequest: (p: {
    chatId: string
    workspaceId: string
    projectPath: string
    wtPath: string
  }) => void
  /** Ask to throw a chat's changes away (native dialog, then chat:throw-away). */
  chatThrowRequest: (p: { chatId: string; workspaceId: string }) => void
  /** Three-way dialog for deleting a chat with unkept changes. */
  chatConfirmUnkept: () => Promise<'keep' | 'throw' | 'cancel'>
  /** Right-click a project row: native menu (new chat, new worktree chat, reveal). */
  workspaceMenu: (ws: { id: string; path: string; isRepo: boolean }) => void
  onWorkspaceMenuAction: (
    cb: (p: { action: string; id: string; path: string }) => void
  ) => () => void
  /** Right-click a desktop icon (or selection): native menu (open/rename/reveal/delete). */
  deskMenu: (info: { paths: string[]; single: boolean; isLink: boolean; isDir: boolean }) => void
  onDeskMenuAction: (cb: (p: { action: string; paths: string[] }) => void) => () => void
  /** Which agent events raise a native banner. */
  setNotifyPrefs: (prefs: { done?: boolean; needsYou?: boolean }) => void
  /** Copy dropped files/folders into a project directory; returns created paths. */
  filesImport: (destDir: string, sources: string[]) => Promise<string[]>
  /** Tail of the latest assistant reply, for the done-notification body. */
  chatLastReply: (workspaceId: string, excerpt: string) => void
  /** Append to the activity log (dashboard). */
  eventsRecord: (kind: string, workspaceId?: string, n?: number) => void
  /** Durable localStorage mirror (SQLite) — see kv handlers in store.ts. */
  kvAll: () => Promise<Record<string, string>>
  kvSet: (key: string, value: string) => void
  kvDel: (key: string) => void
  eventsDashboard: (rangeDays?: number) => Promise<{
    turnsToday: number
    tasksToday: number
    streak: number
    longestStreak: number
    spark: { day: string; date: string; turns: number; tokens: number }[]
    attention: { name: string; turns: number }[]
    attentionAll: { name: string; turns: number }[]
    hours: number[]
    busiestDay: { date: string; turns: number } | null
    avgTurns30: number
    activeDays30: number
    firstTs: number | null
    tokens: { today: number; week: number; month: number }
    trends: { turnsWeek: number; turnsPrevWeek: number; tokensWeek: number; tokensPrevWeek: number }
    weekdayAvg: number[]
    tokensByProject: { name: string; tokens: number }[]
    avgMsgsPerChat: number
    totals: {
      turns: number
      tasks: number
      chats: number
      projects: number
      messages: number
      tokens: number
    }
  }>
  /** New git worktree under <project>/.worktrees; null if git refused. */
  worktreeCreate: (
    projectPath: string,
    opts?: { branch?: string; newBranch?: string; base?: string }
  ) => Promise<{ path: string; branch: string; base: string } | null>
  /** Rename a chat's auto-named superagent/* branch to follow its title. */
  worktreeRename: (
    wtPath: string,
    newBranch: string
  ) => Promise<{ ok: boolean; branch: string | null }>
  /** Unkept work in a worktree: uncommitted edits, or commits past its base. */
  worktreeStatus: (
    projectPath: string,
    wtPath: string
  ) => Promise<{ dirty: boolean; ahead: number }>
  /** Local branches: name, whether current, and the worktree path it's in (if any). */
  gitBranches: (
    cwd: string
  ) => Promise<{ name: string; current: boolean; worktree: string | null }[]>
  /** Switch the checkout to a branch. { ok } or { ok:false, error } if git refused. */
  gitCheckout: (cwd: string, branch: string) => Promise<{ ok: boolean; error?: string }>
  worktreeRemove: (projectPath: string, wtPath: string) => Promise<boolean>
  /** Squash-merge a worktree back into the project's branch, then remove it. */
  worktreeMerge: (
    projectPath: string,
    wtPath: string,
    message: string
  ) => Promise<
    | { ok: true; committed: boolean }
    | {
        ok: false
        reason: 'not-worktree' | 'base-dirty' | 'nothing' | 'conflict' | 'error'
        detail?: string
      }
  >
  /** Photograph the pane and detach it in one step; returns the JPEG bytes. */
  browserFreeze: (id: string) => Promise<Uint8Array | null>
  checkPort: (port: number) => Promise<boolean>
  /** Kill whatever dev server is listening on this local port. */
  killPort: (port: number) => Promise<boolean>
  onBrowserZoom: (id: string, cb: (factor: number) => void) => () => void
  onBrowserState: (id: string, cb: (s: BrowserState) => void) => () => void
  onOpenFile: (
    cb: (p: { workspaceId: string; path: string; chatId?: string | null }) => void
  ) => () => void
  /** The project list changed in main (e.g. the agent cloned a repo) — refresh. */
  onProjectsChanged: (cb: (p: { activate?: string }) => void) => () => void
  /** The agent booted or launched something on a simulator — reveal the pane. */
  onOpenSimulator: (
    cb: (p: { workspaceId: string; udid?: string; chatId?: string | null }) => void
  ) => () => void
  onBrowserCrashed: (id: string, cb: () => void) => () => void
  browserStopAutomation: (id: string) => void
  /** Stop a page that is still loading (the reload button becomes ×). */
  browserStop: (id: string) => void
  /** Tail a background shell's output file (the Bash result says where it is). */
  bgTail: (path: string, maxBytes?: number) => Promise<string | null>
  /** The project's board — the same cards the board_* agent tools write. */
  boardList: (workspaceId: string) => Promise<BoardCard[]>
  boardAdd: (
    workspaceId: string,
    title: string,
    opts?: { body?: string; status?: string; tags?: string[] }
  ) => Promise<BoardCard>
  boardUpdate: (
    id: string,
    patch: { title?: string; body?: string; status?: string; tags?: string[] }
  ) => Promise<BoardCard | undefined>
  boardMove: (id: string, status: string, beforeId: string | null) => Promise<BoardCard | undefined>
  boardRemove: (id: string) => Promise<boolean>
  /** The Computer's Calendar. from/to are ISO dates (YYYY-MM-DD); omit for all. */
  calendarList: (from?: string, to?: string) => Promise<CalendarEvent[]>
  calendarAdd: (e: {
    title: string
    start: string
    end?: string | null
    allDay?: boolean
    notes?: string
    color?: string | null
  }) => Promise<CalendarEvent>
  calendarUpdate: (
    id: string,
    patch: Partial<Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'>>
  ) => Promise<CalendarEvent | undefined>
  calendarRemove: (id: string) => Promise<void>
  boardAddImage: (cardId: string, name: string, bytes: Uint8Array) => Promise<string | null>
  boardRemoveImage: (cardId: string, path: string) => Promise<boolean>
  boardImageData: (path: string) => Promise<string | null>
  onBoardChanged: (cb: (p: { workspaceId: string }) => void) => () => void
  /** iOS Simulator: devices, lifecycle, a frame stream, and input. */
  simList: () => Promise<{ udid: string; name: string; state: string; runtime: string }[]>
  simBoot: (udid: string) => Promise<boolean>
  simShutdown: (udid: string) => Promise<boolean>
  simStreamStart: (udid: string, fps?: number) => void
  /** Tell main which device the pane is on, so the agent's tools aim there. */
  simSetCurrent: (udid: string | null) => Promise<boolean>
  simStreamStop: (udid: string) => void
  simInput: (
    udid: string,
    action: Record<string, unknown>
  ) => Promise<{ ok: boolean; error?: string }>
  simHasInput: () => Promise<boolean>
  /** A single still of the simulator device, as a data URL — for the snip tool. */
  simScreenshot: (udid: string) => Promise<string | null>
  onSimFrame: (
    udid: string,
    cb: (f: { url: string; width: number; height: number }) => void
  ) => () => void
  /** The device stopped answering (shut down, or wedged). */
  onSimGone: (udid: string, cb: () => void) => () => void
  /** Attach mode: park Apple's real Simulator window over the pane. */
  simAttachReady: () => Promise<{ trusted: boolean }>
  simAttachRequest: () => Promise<{ trusted: boolean }>
  simAttachSettings: () => Promise<boolean>
  /** Leaving attach for good: unpin the window so it stops floating on top. */
  simAttachRelease: () => Promise<boolean>
  /** The user asked for Apple's Simulator window — open it and stop hiding it. */
  simOpenApp: (udid: string) => Promise<boolean>
  simAttach: (
    udid: string,
    rect: { x: number; y: number; width: number; height: number }
  ) => Promise<{ ok: boolean; error?: string }>
  simAttachMove: (rect: {
    x: number
    y: number
    width: number
    height: number
  }) => Promise<{ ok: boolean; error?: string }>
  simAttachHide: () => Promise<boolean>
  simAttachShow: () => Promise<boolean>
  /** Interrupt even mid-tool-call (signal, not stdin). Resolves when it's stopped. */
  agentHardInterrupt: (id: string) => Promise<boolean>
  onBrowserActivity: (cb: (workspaceId: string) => void) => () => void
  onBrowserRequestOpen: (cb: (workspaceId: string) => void) => () => void
  // Show the themed "new tab" empty state in a blank pane (no URL yet).
  browserShowEmpty: (id: string) => void
  // A newer release finished downloading in the background → offer to restart.
  onUpdateReady: (cb: (version: string) => void) => () => void
  /** Download progress for an update found in the background (percent 0-100). */
  onUpdateProgress: (cb: (p: { version: string | null; percent: number }) => void) => () => void
  /** The updater failed (download/verify) — surfaced so the UI can say so. */
  onUpdateError: (cb: (message: string) => void) => () => void
  installUpdate: () => void
  /** "What's new" for a version — the GitHub release body (markdown), or null. */
  updateNotes: (version: string) => Promise<string | null>

  storeTree: () => Promise<TreeGroup[]>
  createGroup: (name: string) => Promise<TreeGroup[]>
  updateGroup: (
    id: string,
    patch: Partial<{ name: string; color: string; collapsed: number }>
  ) => Promise<TreeGroup[]>
  deleteGroup: (id: string) => Promise<TreeGroup[]>
  moveGroup: (groupId: string, toIndex: number) => Promise<TreeGroup[]>
  createWorkspace: (
    groupId: string,
    name: string,
    path: string
  ) => Promise<{ tree: TreeGroup[]; workspaceId: string }>
  createBrowserWorkspace: (
    groupId: string,
    name: string
  ) => Promise<{ tree: TreeGroup[]; workspaceId: string }>
  deleteWorkspace: (id: string) => Promise<TreeGroup[]>
  updateWorkspace: (
    id: string,
    patch: Partial<{ browserUrl: string | null; lastSessionId: string | null; name: string }>
  ) => Promise<TreeGroup[]>
  moveWorkspace: (workspaceId: string, toGroupId: string, toIndex: number) => Promise<TreeGroup[]>
  pickFolder: () => Promise<{ path: string; name: string } | null>

  chatList: (workspaceId: string) => Promise<Chat[]>
  chatListAll: () => Promise<Chat[]>
  chatCreate: (workspaceId: string, cwd?: string) => Promise<string>
  /** The desktop's own chat: a workspace that belongs to no project. */
  desktopChatHome: () => Promise<{ workspaceId: string; cwd: string }>
  /** Mirror the desktop's files into that chat's working directory. */
  desktopSyncFiles: (paths: string[]) => Promise<string>
  /**
   * Tell the main process what is on the desktop, so the desktop chat's agent
   * can see the computer it is being asked about. Partial: the desktop reports
   * its windows and files, the Browser app reports its tabs.
   */
  desktopReport: (patch: {
    windows?: {
      app: string
      x: number
      y: number
      w: number
      h: number
      minimized: boolean
      maximized: boolean
      focused: boolean
    }[]
    files?: { name: string; path: string }[]
    tabs?: { id: string; url: string; active: boolean }[]
    bounds?: { w: number; h: number }
    open?: boolean
  }) => void
  /** The Computer closed — nothing on the desktop is on screen any more. */
  desktopGone: () => void
  /** The desktop as a real folder: its entries, and what you can do to them. */
  deskRoot: () => Promise<string>
  deskList: (
    dir?: string
  ) => Promise<{ name: string; path: string; target: string; dir: boolean; link: boolean }[]>
  deskNewFolder: (dir?: string, name?: string) => Promise<string | null>
  deskLink: (target: string, dir?: string) => Promise<string | null>
  deskMove: (from: string, toDir: string) => Promise<string | null>
  deskRename: (path: string, name: string) => Promise<string | null>
  deskRemove: (path: string) => Promise<boolean>
  deskReveal: (path: string) => Promise<void>
  /** The desktop chat's agent driving the desktop (the computer_* tools). */
  onDesktopCommand: (
    cb: (c: {
      kind: string
      app?: string
      path?: string
      url?: string
      newTab?: boolean
      position?: string
      x?: number
      y?: number
      width?: number
      height?: number
    }) => void
  ) => () => void
  chatDelete: (id: string) => Promise<void>
  chatUpdate: (
    id: string,
    patch: Partial<{ title: string | null; claudeSessionId: string | null; cwd: string | null }>
  ) => Promise<void>
  chatLoad: (chatId: string) => Promise<string | null>
  chatSave: (chatId: string, data: string) => void
  chatClear: (chatId: string) => void

  historyRecord: (url: string, title: string) => void
  historySearch: (query: string) => Promise<{ url: string; title: string }[]>
  /** Absolute path of a dropped/selected File (Electron webUtils). */
  getPathForFile: (file: File) => string

  setTheme: (source: 'system' | 'light' | 'dark') => void
  onMenu: (cb: (action: string) => void) => () => void

  envDetect: () => Promise<{
    claudeInstalled: boolean
    claudeVersion: string | null
    loggedIn: boolean
  }>
  envVersion: () => Promise<{ claudeInstalled: boolean; claudeVersion: string | null }>
  /** Install Claude Code via Anthropic's native installer; onLine streams progress. */
  installClaude: (onLine: (line: string) => void) => Promise<{ ok: boolean; error?: string }>
  /** Open Terminal running `claude` for the one-time sign-in. */
  openClaudeLogin: () => void
  filesList: (root: string) => Promise<string[]>
  /** A downscaled data URI for an image on disk, or null if it isn't one. */
  filesThumb: (path: string) => Promise<string | null>
  filesOpenExternal: (path: string) => Promise<string>
  fileRead: (path: string) => Promise<string | null>
  fileWrite: (path: string, content: string) => Promise<boolean>
  gitBranch: (cwd: string) => Promise<string | null>
  /** Ahead/behind vs upstream from local refs (no fetch); null if no upstream. */
  gitAheadBehind: (cwd: string) => Promise<{ ahead: number; behind: number } | null>
  gitSubrepos: (root: string) => Promise<{ name: string; path: string; branch: string | null }[]>

  routinesList: (workspaceId?: string) => Promise<Routine[]>
  routinesCreate: (
    workspaceId: string,
    workspacePath: string,
    prompt: string,
    intervalMinutes: number
  ) => Promise<Routine>
  routinesSetEnabled: (id: string, enabled: boolean) => Promise<Routine[]>
  routinesDelete: (id: string) => Promise<Routine[]>
  routinesRunNow: (id: string) => void
  onRoutinesChanged: (cb: () => void) => () => void

  skillsList: (
    projectPath?: string
  ) => Promise<
    { name: string; description: string; scope: 'global' | 'project'; kind: 'skill' | 'command' }[]
  >
  skillsInstallStarters: () => Promise<
    { name: string; description: string; scope: 'global' | 'project'; kind: 'skill' | 'command' }[]
  >

  agentStart: (opts: {
    cwd?: string
    workspaceId?: string
    chatId?: string
    resumeSessionId?: string | null
    browserProject?: boolean
    permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'ask'
    model?: string
  }) => Promise<string>
  agentSuggestTitle: (cwd: string, excerpt: string) => Promise<string | null>
  agentSend: (id: string, text: string, images?: { mediaType: string; data: string }[]) => void
  agentInterrupt: (id: string) => void
  agentStop: (id: string) => void
  onAgentEvent: (id: string, cb: (event: Record<string, unknown>) => void) => () => void
  /** A prompt that reached this session from somewhere other than this window (the phone). */
  onAgentUser: (id: string, cb: (m: { text: string; from: string }) => void) => () => void
  /** Raw stderr from the Claude CLI — carries its real diagnostics (auth, org access…). */
  onAgentStderr: (id: string, cb: (chunk: string) => void) => () => void
  onAgentExit: (id: string, cb: (code: number) => void) => () => void
  /** The previous session could not be resumed; this one starts with no history. */
  onAgentResumeLost: (id: string, cb: () => void) => () => void
  /** Non-null if the session already exited before we were listening. */
  agentDied: (id: string) => Promise<{ code: number; reason?: string } | null>
  /** Catch-up: did a resume fail before we subscribed? Consumes the flag. */
  agentResumeLostCheck: (id: string) => Promise<boolean>

  onHookEvent: (cb: (e: HookEvent) => void) => () => void

  // Phone companion (Settings → Phone)
  companionState: () => Promise<CompanionState>
  onCompanionState: (cb: (s: CompanionState) => void) => () => void
  companionPairStart: () => Promise<{ payload: PairPayload; code: string; expiresAt: number }>
  companionPairCancel: () => void
  companionPairDecide: (accepted: boolean) => void
  onCompanionPairingRequest: (
    cb: (r: { device: { id: string; name: string; model: string }; code: string }) => void
  ) => () => void
  companionRevoke: (deviceId: string) => void
  companionSetRelay: (url: string) => void
  companionReconnect: () => void
  /** One test banner to that phone; false if it never registered for push. */
  companionTestPush: (deviceId: string) => Promise<boolean>
  companionSetKeepAwake: (always: boolean) => void
  /** A tool is gated pending the user's approval (browse-then-execute guard). */
  onGuardrailAsk: (cb: (a: GuardrailAsk) => void) => () => void
  /** A pending gate was resolved elsewhere (e.g. timed out) — dismiss its prompt. */
  onGuardrailResolved: (cb: (requestId: string) => void) => () => void
  /** Answer a gate: approve/deny, and whether to trust the rest of this turn. */
  guardrailResolve: (requestId: string, approve: boolean, trustRest: boolean) => void
  onFocusWorkspace: (cb: (workspaceId: string) => void) => () => void
  /** SuperAgent's own version (package.json / bundle), not Claude Code's. */
  appVersion: () => Promise<string>
  /** Ask the updater to check now. latest=null means up to date (or dev build). */
  updateCheck: () => Promise<{ current: string; latest: string | null; error?: string }>
  hooksStatus: () => Promise<boolean>
  hooksInstall: () => Promise<{ ok: boolean; error?: string }>
  hooksUninstall: () => Promise<boolean>
}

/** Subscribe to an IPC channel; returns an unsubscribe fn. Collapses the repeated on<X> boilerplate. */
function subscribe(channel: string, cb: (...args: unknown[]) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const cove: CoveApi = {
  browserCreate: (id, partition) => ipcRenderer.invoke('browser:create', id, partition),
  browserSetBounds: (id, b) => ipcRenderer.send('browser:set-bounds', id, b),
  browserHide: (id) => ipcRenderer.send('browser:hide', id),
  browserNavigate: (id, url) => ipcRenderer.send('browser:navigate', id, url),
  browserBack: (id) => ipcRenderer.send('browser:back', id),
  browserForward: (id) => ipcRenderer.send('browser:forward', id),
  browserReload: (id) => ipcRenderer.send('browser:reload', id),
  browserOpenExternal: (id) => ipcRenderer.send('browser:open-external', id),
  onBrowserResync: (cb) => subscribe('browser:resync', () => cb()),
  onAppFocus: (cb) => subscribe('app:focus', (v) => cb(v as boolean)),
  browserZoom: (id, action) => ipcRenderer.invoke('browser:zoom', id, action),
  browserSetZoom: (id, factor) => ipcRenderer.send('browser:set-zoom-factor', id, factor),
  browserSetRadius: (id, radius) => ipcRenderer.send('browser:set-radius', id, radius),
  browserTwinBounds: (id, bounds, zoom) =>
    ipcRenderer.send('browser:twin-bounds', id, bounds, zoom),
  browserSampleCorners: (id) => ipcRenderer.invoke('browser:sample-corners', id),
  browserShoot: (id) => ipcRenderer.invoke('browser:shoot', id),
  browserShootTwin: () => ipcRenderer.invoke('browser:shoot-twin'),
  filesMenu: (absPath) => ipcRenderer.send('files:menu', absPath),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  chatMenu: (chatId, workspaceId, cwd) => ipcRenderer.send('chat:menu', chatId, workspaceId, cwd),
  onChatMergeWorktree: (cb) =>
    subscribe('chat:merge-worktree', (p) =>
      cb(p as { chatId: string; workspaceId: string; projectPath: string; wtPath: string })
    ),
  onChatCleared: (cb) =>
    subscribe('chat:cleared', (p) => cb(p as { chatId: string; workspaceId: string })),
  onChatDeleteRequest: (cb) =>
    subscribe('chat:delete', (p) => cb(p as { chatId: string; workspaceId: string })),
  onChatThrowAway: (cb) =>
    subscribe('chat:throw-away', (p) => cb(p as { chatId: string; workspaceId: string })),
  chatKeepRequest: (p) => ipcRenderer.send('chat:keep-request', p),
  chatThrowRequest: (p) => ipcRenderer.send('chat:throw-request', p),
  chatConfirmUnkept: () => ipcRenderer.invoke('chat:confirm-unkept'),
  workspaceMenu: (ws) => ipcRenderer.send('workspace:menu', ws),
  onWorkspaceMenuAction: (cb) =>
    subscribe('workspace:menu-action', (p) =>
      cb(p as { action: string; id: string; path: string })
    ),
  deskMenu: (info) => ipcRenderer.send('desk:menu', info),
  onDeskMenuAction: (cb) =>
    subscribe('desk:menu-action', (p) => cb(p as { action: string; paths: string[] })),
  setNotifyPrefs: (prefs) => ipcRenderer.send('notify:prefs', prefs),
  filesImport: (destDir, sources) => ipcRenderer.invoke('files:import', destDir, sources),
  chatLastReply: (workspaceId, excerpt) =>
    ipcRenderer.send('chat:last-reply', workspaceId, excerpt),
  eventsRecord: (kind, workspaceId, n) => ipcRenderer.send('events:record', kind, workspaceId, n),
  kvAll: () => ipcRenderer.invoke('kv:all'),
  kvSet: (key, value) => ipcRenderer.send('kv:set', key, value),
  kvDel: (key) => ipcRenderer.send('kv:del', key),
  eventsDashboard: (rangeDays) => ipcRenderer.invoke('events:dashboard', rangeDays),
  worktreeCreate: (projectPath, opts) => ipcRenderer.invoke('worktree:create', projectPath, opts),
  worktreeRename: (wtPath, newBranch) => ipcRenderer.invoke('worktree:rename', wtPath, newBranch),
  worktreeStatus: (projectPath, wtPath) =>
    ipcRenderer.invoke('worktree:status', projectPath, wtPath),
  gitBranches: (cwd) => ipcRenderer.invoke('git:branches', cwd),
  gitCheckout: (cwd, branch) => ipcRenderer.invoke('git:checkout', cwd, branch),
  worktreeRemove: (projectPath, wtPath) =>
    ipcRenderer.invoke('worktree:remove', projectPath, wtPath),
  worktreeMerge: (projectPath, wtPath, message) =>
    ipcRenderer.invoke('worktree:merge', projectPath, wtPath, message),
  browserFreeze: (id) => ipcRenderer.invoke('browser:freeze', id),
  checkPort: (port) => ipcRenderer.invoke('net:checkPort', port),
  killPort: (port) => ipcRenderer.invoke('net:killPort', port),
  onBrowserZoom: (id, cb) => subscribe(`browser:zoom:${id}`, (f) => cb(f as number)),
  browserDestroy: (id) => ipcRenderer.send('browser:destroy', id),
  browserDestroyWorkspace: (workspaceId) =>
    ipcRenderer.send('browser:destroy-workspace', workspaceId),
  onBrowserState: (id, cb) => subscribe(`browser:state:${id}`, (s) => cb(s as BrowserState)),
  onBrowserCrashed: (id, cb) => subscribe(`browser:crashed:${id}`, () => cb()),
  browserStopAutomation: (id) => ipcRenderer.send('browser:stop-automation', id),
  browserStop: (id) => ipcRenderer.send('browser:stop', id),
  bgTail: (path, maxBytes) => ipcRenderer.invoke('bg:tail', path, maxBytes),
  boardList: (workspaceId) => ipcRenderer.invoke('board:list', workspaceId),
  boardAdd: (workspaceId, title, opts) => ipcRenderer.invoke('board:add', workspaceId, title, opts),
  boardUpdate: (id, patch) => ipcRenderer.invoke('board:update', id, patch),
  boardMove: (id, status, beforeId) => ipcRenderer.invoke('board:move', id, status, beforeId),
  boardRemove: (id) => ipcRenderer.invoke('board:remove', id),
  calendarList: (from, to) => ipcRenderer.invoke('calendar:list', from, to),
  calendarAdd: (e) => ipcRenderer.invoke('calendar:add', e),
  calendarUpdate: (id, patch) => ipcRenderer.invoke('calendar:update', id, patch),
  calendarRemove: (id) => ipcRenderer.invoke('calendar:remove', id),
  boardAddImage: (cardId, name, bytes) => ipcRenderer.invoke('board:addImage', cardId, name, bytes),
  boardRemoveImage: (cardId, path) => ipcRenderer.invoke('board:removeImage', cardId, path),
  boardImageData: (path) => ipcRenderer.invoke('board:imageData', path),
  onBoardChanged: (cb) => subscribe('board:changed', (p) => cb(p as { workspaceId: string })),
  simList: () => ipcRenderer.invoke('sim:list'),
  simBoot: (udid) => ipcRenderer.invoke('sim:boot', udid),
  simShutdown: (udid) => ipcRenderer.invoke('sim:shutdown', udid),
  simStreamStart: (udid, fps) => ipcRenderer.send('sim:stream-start', udid, fps),
  simSetCurrent: (udid) => ipcRenderer.invoke('sim:set-current', udid),
  simStreamStop: (udid) => ipcRenderer.send('sim:stream-stop', udid),
  simInput: (udid, action) => ipcRenderer.invoke('sim:input', udid, action),
  simHasInput: () => ipcRenderer.invoke('sim:has-input'),
  simScreenshot: (udid) => ipcRenderer.invoke('sim:screenshot', udid),
  onSimFrame: (udid, cb) =>
    subscribe(`sim:frame:${udid}`, (f) => cb(f as { url: string; width: number; height: number })),
  onSimGone: (udid, cb) => subscribe(`sim:gone:${udid}`, () => cb()),
  simAttachReady: () => ipcRenderer.invoke('sim:attach-ready'),
  simAttachRequest: () => ipcRenderer.invoke('sim:attach-request'),
  simAttachSettings: () => ipcRenderer.invoke('sim:attach-settings'),
  simAttachRelease: () => ipcRenderer.invoke('sim:attach-release'),
  simOpenApp: (udid) => ipcRenderer.invoke('sim:open-app', udid),
  simAttach: (udid, rect) => ipcRenderer.invoke('sim:attach', udid, rect),
  simAttachMove: (rect) => ipcRenderer.invoke('sim:attach-move', rect),
  simAttachHide: () => ipcRenderer.invoke('sim:attach-hide'),
  simAttachShow: () => ipcRenderer.invoke('sim:attach-show'),
  agentHardInterrupt: (id) => ipcRenderer.invoke('agent:hard-interrupt', id),
  onBrowserActivity: (cb) => subscribe('browser:activity', (id) => cb(id as string)),
  onBrowserRequestOpen: (cb) => subscribe('browser:request-open', (id) => cb(id as string)),
  browserShowEmpty: (id) => ipcRenderer.send('browser:show-empty', id),
  onUpdateReady: (cb) => subscribe('update:ready', (v) => cb(v as string)),
  onUpdateProgress: (cb) =>
    subscribe('update:progress', (p) => cb(p as { version: string | null; percent: number })),
  onUpdateError: (cb) => subscribe('update:error', (m) => cb(m as string)),
  installUpdate: () => ipcRenderer.send('update:install'),
  updateNotes: (version) => ipcRenderer.invoke('update:notes', version),
  // The agent asked to open a file in-app (open_file tool) → {workspaceId, path}.
  onOpenSimulator: (cb) =>
    subscribe('app:open-simulator', (p) =>
      cb(p as { workspaceId: string; udid?: string; chatId?: string | null })
    ),
  onOpenFile: (cb) =>
    subscribe('app:open-file', (p) =>
      cb(p as { workspaceId: string; path: string; chatId?: string | null })
    ),
  onProjectsChanged: (cb) => subscribe('projects:changed', (p) => cb(p as { activate?: string })),

  storeTree: () => ipcRenderer.invoke('store:tree'),
  createGroup: (name) => ipcRenderer.invoke('store:createGroup', name),
  updateGroup: (id, patch) => ipcRenderer.invoke('store:updateGroup', id, patch),
  deleteGroup: (id) => ipcRenderer.invoke('store:deleteGroup', id),
  moveGroup: (groupId, toIndex) => ipcRenderer.invoke('store:moveGroup', groupId, toIndex),
  createWorkspace: (groupId, name, path) =>
    ipcRenderer.invoke('store:createWorkspace', groupId, name, path),
  createBrowserWorkspace: (groupId, name) =>
    ipcRenderer.invoke('store:createBrowserWorkspace', groupId, name),
  deleteWorkspace: (id) => ipcRenderer.invoke('store:deleteWorkspace', id),
  updateWorkspace: (id, patch) => ipcRenderer.invoke('store:updateWorkspace', id, patch),
  moveWorkspace: (workspaceId, toGroupId, toIndex) =>
    ipcRenderer.invoke('store:moveWorkspace', workspaceId, toGroupId, toIndex),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  chatList: (workspaceId) => ipcRenderer.invoke('chat:list', workspaceId),
  chatListAll: () => ipcRenderer.invoke('chat:listAll'),
  chatCreate: (workspaceId, cwd) => ipcRenderer.invoke('chat:create', workspaceId, cwd),
  desktopChatHome: () => ipcRenderer.invoke('desktop:chat-home'),
  desktopSyncFiles: (paths) => ipcRenderer.invoke('desktop:sync-files', paths),
  desktopReport: (patch) => ipcRenderer.send('desktop:report', patch),
  desktopGone: () => ipcRenderer.send('desktop:gone'),
  deskRoot: () => ipcRenderer.invoke('desk:root'),
  deskList: (dir) => ipcRenderer.invoke('desk:list', dir),
  deskNewFolder: (dir, name) => ipcRenderer.invoke('desk:newFolder', dir, name),
  deskLink: (target, dir) => ipcRenderer.invoke('desk:link', target, dir),
  deskMove: (from, toDir) => ipcRenderer.invoke('desk:move', from, toDir),
  deskRename: (path, name) => ipcRenderer.invoke('desk:rename', path, name),
  deskRemove: (path) => ipcRenderer.invoke('desk:remove', path),
  deskReveal: (path) => ipcRenderer.invoke('desk:reveal', path),
  onDesktopCommand: (cb) => subscribe('desktop:command', (c) => cb(c as Parameters<typeof cb>[0])),
  chatDelete: (id) => ipcRenderer.invoke('chat:delete', id),
  chatUpdate: (id, patch) => ipcRenderer.invoke('chat:update', id, patch),
  chatLoad: (chatId) => ipcRenderer.invoke('chat:load', chatId),
  chatSave: (chatId, data) => ipcRenderer.send('chat:save', chatId, data),
  chatClear: (chatId) => ipcRenderer.send('chat:clear', chatId),

  historyRecord: (url, title) => ipcRenderer.send('history:record', url, title, Date.now()),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  historySearch: (query) => ipcRenderer.invoke('history:search', query),

  setTheme: (source) => ipcRenderer.send('theme:set', source),
  onMenu: (cb) => {
    const actions = [
      'menu:settings',
      'menu:new-project',
      'menu:new-group',
      'menu:skills',
      'menu:routines',
      'menu:reload-page',
      'menu:toggle-preview',
      'menu:close-tab'
    ]
    const listeners = actions.map((action) => {
      const l = (): void => cb(action.replace('menu:', ''))
      ipcRenderer.on(action, l)
      return [action, l] as const
    })
    return () => listeners.forEach(([action, l]) => ipcRenderer.removeListener(action, l))
  },

  envDetect: () => ipcRenderer.invoke('env:detect'),
  envVersion: () => ipcRenderer.invoke('env:version'),
  installClaude: (onLine) => {
    const listener = (_e: Electron.IpcRendererEvent, line: string): void => onLine(line)
    ipcRenderer.on('env:install-progress', listener)
    return ipcRenderer
      .invoke('env:install-claude')
      .finally(() => ipcRenderer.removeListener('env:install-progress', listener))
  },
  openClaudeLogin: () => ipcRenderer.send('env:open-login'),
  filesList: (root) => ipcRenderer.invoke('files:list', root),
  filesThumb: (path) => ipcRenderer.invoke('files:thumb', path),
  filesOpenExternal: (path) => ipcRenderer.invoke('files:openExternal', path),
  fileRead: (path) => ipcRenderer.invoke('files:read', path),
  fileWrite: (path, content) => ipcRenderer.invoke('files:write', path, content),
  gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
  gitAheadBehind: (cwd) => ipcRenderer.invoke('git:aheadBehind', cwd),
  gitSubrepos: (root) => ipcRenderer.invoke('git:subrepos', root),

  routinesList: (workspaceId) => ipcRenderer.invoke('routines:list', workspaceId),
  routinesCreate: (workspaceId, workspacePath, prompt, intervalMinutes) =>
    ipcRenderer.invoke('routines:create', workspaceId, workspacePath, prompt, intervalMinutes),
  routinesSetEnabled: (id, enabled) => ipcRenderer.invoke('routines:setEnabled', id, enabled),
  routinesDelete: (id) => ipcRenderer.invoke('routines:delete', id),
  routinesRunNow: (id) => ipcRenderer.send('routines:runNow', id),
  onRoutinesChanged: (cb) => subscribe('routines:changed', () => cb()),

  skillsList: (projectPath) => ipcRenderer.invoke('skills:list', projectPath),
  skillsInstallStarters: () => ipcRenderer.invoke('skills:installStarters'),

  agentStart: (opts) => ipcRenderer.invoke('agent:start', opts),
  agentSuggestTitle: (cwd, excerpt) => ipcRenderer.invoke('agent:suggestTitle', cwd, excerpt),
  agentSend: (id, text, images) => ipcRenderer.send('agent:send', id, text, images),
  agentInterrupt: (id) => ipcRenderer.send('agent:interrupt', id),
  agentStop: (id) => ipcRenderer.send('agent:stop', id),
  onAgentEvent: (id, cb) =>
    subscribe(`agent:event:${id}`, (event) => cb(event as Record<string, unknown>)),
  onAgentUser: (id, cb) =>
    subscribe(`agent:user:${id}`, (m) => cb(m as { text: string; from: string })),
  onAgentStderr: (id, cb) => subscribe(`agent:stderr:${id}`, (chunk) => cb(chunk as string)),
  onAgentExit: (id, cb) => subscribe(`agent:exit:${id}`, (code) => cb(code as number)),
  onAgentResumeLost: (id, cb) => subscribe(`agent:resume-lost:${id}`, () => cb()),
  agentDied: (id) => ipcRenderer.invoke('agent:died', id),
  agentResumeLostCheck: (id) => ipcRenderer.invoke('agent:resume-lost-check', id),

  onHookEvent: (cb) => subscribe('hook:event', (ev) => cb(ev as HookEvent)),

  companionState: () => ipcRenderer.invoke('companion:state'),
  onCompanionState: (cb) => subscribe('companion:state', (s) => cb(s as CompanionState)),
  companionPairStart: () => ipcRenderer.invoke('companion:pair-start'),
  companionPairCancel: () => ipcRenderer.send('companion:pair-cancel'),
  companionPairDecide: (accepted) => ipcRenderer.send('companion:pair-decide', accepted),
  onCompanionPairingRequest: (cb) =>
    subscribe('companion:pairing-request', (r) =>
      cb(r as { device: { id: string; name: string; model: string }; code: string })
    ),
  companionRevoke: (id) => ipcRenderer.send('companion:revoke', id),
  companionSetRelay: (url) => ipcRenderer.send('companion:set-relay', url),
  companionReconnect: () => ipcRenderer.send('companion:reconnect'),
  companionTestPush: (id) => ipcRenderer.invoke('companion:test-push', id),
  companionSetKeepAwake: (always) => ipcRenderer.send('companion:set-keep-awake', always),
  onGuardrailAsk: (cb) => subscribe('guardrail:ask', (a) => cb(a as GuardrailAsk)),
  onGuardrailResolved: (cb) =>
    subscribe('guardrail:resolved', (r) => cb((r as { requestId: string }).requestId)),
  guardrailResolve: (requestId, approve, trustRest) =>
    ipcRenderer.send('guardrail:resolve', requestId, approve, trustRest),
  onFocusWorkspace: (cb) => subscribe('hook:focus-workspace', (id) => cb(id as string)),
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  hooksStatus: () => ipcRenderer.invoke('hooks:status'),
  hooksInstall: () => ipcRenderer.invoke('hooks:install'),
  hooksUninstall: () => ipcRenderer.invoke('hooks:uninstall')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('cove', cove)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.cove = cove
}
