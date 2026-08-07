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

export interface CoveApi {
  browserCreate: (id: string, partition: string) => Promise<void>
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
  browserSampleCorners: (id: string) => Promise<{ left: string; right: string } | null>
  /** Full-res PNG bytes of the pane (screenshot tooling). */
  browserShoot: (id: string) => Promise<Uint8Array | null>
  /** PNG of the side-by-side phone twin, if one is on screen. */
  browserShootTwin: () => Promise<Uint8Array | null>
  /** Native context menu for a file-tree row (Reveal in Finder, Copy Path…). */
  filesMenu: (absPath: string) => void
  chatMenu: (chatId: string, workspaceId: string) => void
  onChatCleared: (cb: (p: { chatId: string; workspaceId: string }) => void) => () => void
  onChatDeleteRequest: (cb: (p: { chatId: string; workspaceId: string }) => void) => () => void
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
    spark: { day: string; turns: number; tokens: number }[]
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
  worktreeCreate: (projectPath: string) => Promise<{ path: string; branch: string } | null>
  worktreeRemove: (projectPath: string, wtPath: string) => Promise<boolean>
  /** Photograph the pane and detach it in one step; returns the JPEG bytes. */
  browserFreeze: (id: string) => Promise<Uint8Array | null>
  checkPort: (port: number) => Promise<boolean>
  onBrowserZoom: (id: string, cb: (factor: number) => void) => () => void
  onBrowserState: (id: string, cb: (s: BrowserState) => void) => () => void
  onOpenFile: (cb: (p: { workspaceId: string; path: string }) => void) => () => void
  onBrowserCrashed: (id: string, cb: () => void) => () => void
  browserStopAutomation: (id: string) => void
  /** Stop a page that is still loading (the reload button becomes ×). */
  browserStop: (id: string) => void
  /** Tail a background shell's output file (the Bash result says where it is). */
  bgTail: (path: string, maxBytes?: number) => Promise<string | null>
  /** iOS Simulator: devices, lifecycle, a frame stream, and input. */
  simList: () => Promise<{ udid: string; name: string; state: string; runtime: string }[]>
  simBoot: (udid: string) => Promise<boolean>
  simShutdown: (udid: string) => Promise<boolean>
  simStreamStart: (udid: string, fps?: number) => void
  simStreamStop: (udid: string) => void
  simInput: (
    udid: string,
    action: Record<string, unknown>
  ) => Promise<{ ok: boolean; error?: string }>
  simHasInput: () => Promise<boolean>
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
  filesList: (root: string) => Promise<string[]>
  filesOpenExternal: (path: string) => Promise<string>
  fileRead: (path: string) => Promise<string | null>
  fileWrite: (path: string, content: string) => Promise<boolean>
  gitBranch: (cwd: string) => Promise<string | null>
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
    resumeSessionId?: string | null
    browserProject?: boolean
    permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan'
    model?: string
  }) => Promise<string>
  agentSuggestTitle: (cwd: string, excerpt: string) => Promise<string | null>
  agentSend: (id: string, text: string, images?: { mediaType: string; data: string }[]) => void
  agentInterrupt: (id: string) => void
  agentStop: (id: string) => void
  onAgentEvent: (id: string, cb: (event: Record<string, unknown>) => void) => () => void
  onAgentExit: (id: string, cb: (code: number) => void) => () => void

  onHookEvent: (cb: (e: HookEvent) => void) => () => void
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
  browserTwinBounds: (id, bounds, zoom) => ipcRenderer.send('browser:twin-bounds', id, bounds, zoom),
  browserSampleCorners: (id) => ipcRenderer.invoke('browser:sample-corners', id),
  browserShoot: (id) => ipcRenderer.invoke('browser:shoot', id),
  browserShootTwin: () => ipcRenderer.invoke('browser:shoot-twin'),
  filesMenu: (absPath) => ipcRenderer.send('files:menu', absPath),
  chatMenu: (chatId, workspaceId) => ipcRenderer.send('chat:menu', chatId, workspaceId),
  onChatCleared: (cb) =>
    subscribe('chat:cleared', (p) => cb(p as { chatId: string; workspaceId: string })),
  onChatDeleteRequest: (cb) =>
    subscribe('chat:delete', (p) => cb(p as { chatId: string; workspaceId: string })),
  setNotifyPrefs: (prefs) => ipcRenderer.send('notify:prefs', prefs),
  filesImport: (destDir, sources) => ipcRenderer.invoke('files:import', destDir, sources),
  chatLastReply: (workspaceId, excerpt) => ipcRenderer.send('chat:last-reply', workspaceId, excerpt),
  eventsRecord: (kind, workspaceId, n) => ipcRenderer.send('events:record', kind, workspaceId, n),
  kvAll: () => ipcRenderer.invoke('kv:all'),
  kvSet: (key, value) => ipcRenderer.send('kv:set', key, value),
  kvDel: (key) => ipcRenderer.send('kv:del', key),
  eventsDashboard: (rangeDays) => ipcRenderer.invoke('events:dashboard', rangeDays),
  worktreeCreate: (projectPath) => ipcRenderer.invoke('worktree:create', projectPath),
  worktreeRemove: (projectPath, wtPath) => ipcRenderer.invoke('worktree:remove', projectPath, wtPath),
  browserFreeze: (id) => ipcRenderer.invoke('browser:freeze', id),
  checkPort: (port) => ipcRenderer.invoke('net:checkPort', port),
  onBrowserZoom: (id, cb) => subscribe(`browser:zoom:${id}`, (f) => cb(f as number)),
  browserDestroy: (id) => ipcRenderer.send('browser:destroy', id),
  onBrowserState: (id, cb) => subscribe(`browser:state:${id}`, (s) => cb(s as BrowserState)),
  onBrowserCrashed: (id, cb) => subscribe(`browser:crashed:${id}`, () => cb()),
  browserStopAutomation: (id) => ipcRenderer.send('browser:stop-automation', id),
  browserStop: (id) => ipcRenderer.send('browser:stop', id),
  bgTail: (path, maxBytes) => ipcRenderer.invoke('bg:tail', path, maxBytes),
  simList: () => ipcRenderer.invoke('sim:list'),
  simBoot: (udid) => ipcRenderer.invoke('sim:boot', udid),
  simShutdown: (udid) => ipcRenderer.invoke('sim:shutdown', udid),
  simStreamStart: (udid, fps) => ipcRenderer.send('sim:stream-start', udid, fps),
  simStreamStop: (udid) => ipcRenderer.send('sim:stream-stop', udid),
  simInput: (udid, action) => ipcRenderer.invoke('sim:input', udid, action),
  simHasInput: () => ipcRenderer.invoke('sim:has-input'),
  onSimFrame: (udid, cb) =>
    subscribe(`sim:frame:${udid}`, (f) => cb(f as { url: string; width: number; height: number })),
  onSimGone: (udid, cb) => subscribe(`sim:gone:${udid}`, () => cb()),
  simAttachReady: () => ipcRenderer.invoke('sim:attach-ready'),
  simAttachRequest: () => ipcRenderer.invoke('sim:attach-request'),
  simAttachSettings: () => ipcRenderer.invoke('sim:attach-settings'),
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
  // The agent asked to open a file in-app (open_file tool) → {workspaceId, path}.
  onOpenFile: (cb) =>
    subscribe('app:open-file', (p) => cb(p as { workspaceId: string; path: string })),

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
      'menu:toggle-preview'
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
  filesList: (root) => ipcRenderer.invoke('files:list', root),
  filesOpenExternal: (path) => ipcRenderer.invoke('files:openExternal', path),
  fileRead: (path) => ipcRenderer.invoke('files:read', path),
  fileWrite: (path, content) => ipcRenderer.invoke('files:write', path, content),
  gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
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
  onAgentExit: (id, cb) => subscribe(`agent:exit:${id}`, (code) => cb(code as number)),

  onHookEvent: (cb) => subscribe('hook:event', (ev) => cb(ev as HookEvent)),
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
