import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface Workspace {
  id: string
  groupId: string
  name: string
  path: string
  position: number
  browserUrl: string | null
  lastSessionId: string | null
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
}

export interface HookEvent {
  workspaceId: string
  event: string
  status?: 'idle' | 'working' | 'needs-you'
  sessionId?: string
  body: Record<string, unknown>
}

export interface CoveApi {
  ptyCreate: (opts: {
    cwd?: string
    cols: number
    rows: number
    command?: string
    workspaceId?: string
  }) => Promise<string>
  ptyWrite: (id: string, data: string) => void
  ptyResize: (id: string, cols: number, rows: number) => void
  ptyKill: (id: string) => void
  onPtyData: (id: string, cb: (data: string) => void) => () => void
  onPtyExit: (id: string, cb: (code: number) => void) => () => void

  browserCreate: (id: string, partition: string) => Promise<void>
  browserSetBounds: (id: string, b: { x: number; y: number; width: number; height: number }) => void
  browserHide: (id: string) => void
  browserNavigate: (id: string, url: string) => void
  browserBack: (id: string) => void
  browserForward: (id: string) => void
  browserReload: (id: string) => void
  browserOpenExternal: (id: string) => void
  browserDestroy: (id: string) => void
  onBrowserState: (id: string, cb: (s: BrowserState) => void) => () => void
  onBrowserCrashed: (id: string, cb: () => void) => () => void
  browserStopAutomation: (id: string) => void
  onBrowserActivity: (cb: (workspaceId: string) => void) => () => void

  storeTree: () => Promise<TreeGroup[]>
  createGroup: (name: string) => Promise<TreeGroup[]>
  updateGroup: (
    id: string,
    patch: Partial<{ name: string; color: string; collapsed: number }>
  ) => Promise<TreeGroup[]>
  deleteGroup: (id: string) => Promise<TreeGroup[]>
  createWorkspace: (
    groupId: string,
    name: string,
    path: string
  ) => Promise<{ tree: TreeGroup[]; workspaceId: string }>
  deleteWorkspace: (id: string) => Promise<TreeGroup[]>
  updateWorkspace: (
    id: string,
    patch: Partial<{ browserUrl: string | null; lastSessionId: string | null; name: string }>
  ) => Promise<TreeGroup[]>
  moveWorkspace: (workspaceId: string, toGroupId: string, toIndex: number) => Promise<TreeGroup[]>
  pickFolder: () => Promise<{ path: string; name: string } | null>

  onMenu: (cb: (action: string) => void) => () => void

  envDetect: () => Promise<{
    claudeInstalled: boolean
    claudeVersion: string | null
    loggedIn: boolean
  }>
  envVersion: () => Promise<{ claudeInstalled: boolean; claudeVersion: string | null }>

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

  agentStart: (opts: { cwd?: string; workspaceId?: string }) => Promise<string>
  agentSend: (id: string, text: string) => void
  agentStop: (id: string) => void
  onAgentEvent: (id: string, cb: (event: Record<string, unknown>) => void) => () => void
  onAgentExit: (id: string, cb: (code: number) => void) => () => void

  onHookEvent: (cb: (e: HookEvent) => void) => () => void
  onFocusWorkspace: (cb: (workspaceId: string) => void) => () => void
  hooksStatus: () => Promise<boolean>
  hooksInstall: () => Promise<{ ok: boolean; error?: string }>
  hooksUninstall: () => Promise<boolean>
}

const cove: CoveApi = {
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.send('pty:kill', id),
  onPtyData: (id, cb) => {
    const channel = `pty:data:${id}`
    const listener = (_e: Electron.IpcRendererEvent, data: string): void => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onPtyExit: (id, cb) => {
    const channel = `pty:exit:${id}`
    const listener = (_e: Electron.IpcRendererEvent, code: number): void => cb(code)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  browserCreate: (id, partition) => ipcRenderer.invoke('browser:create', id, partition),
  browserSetBounds: (id, b) => ipcRenderer.send('browser:set-bounds', id, b),
  browserHide: (id) => ipcRenderer.send('browser:hide', id),
  browserNavigate: (id, url) => ipcRenderer.send('browser:navigate', id, url),
  browserBack: (id) => ipcRenderer.send('browser:back', id),
  browserForward: (id) => ipcRenderer.send('browser:forward', id),
  browserReload: (id) => ipcRenderer.send('browser:reload', id),
  browserOpenExternal: (id) => ipcRenderer.send('browser:open-external', id),
  browserDestroy: (id) => ipcRenderer.send('browser:destroy', id),
  onBrowserState: (id, cb) => {
    const channel = `browser:state:${id}`
    const listener = (_e: Electron.IpcRendererEvent, s: BrowserState): void => cb(s)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onBrowserCrashed: (id, cb) => {
    const channel = `browser:crashed:${id}`
    const listener = (): void => cb()
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  browserStopAutomation: (id) => ipcRenderer.send('browser:stop-automation', id),
  onBrowserActivity: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('browser:activity', listener)
    return () => ipcRenderer.removeListener('browser:activity', listener)
  },

  storeTree: () => ipcRenderer.invoke('store:tree'),
  createGroup: (name) => ipcRenderer.invoke('store:createGroup', name),
  updateGroup: (id, patch) => ipcRenderer.invoke('store:updateGroup', id, patch),
  deleteGroup: (id) => ipcRenderer.invoke('store:deleteGroup', id),
  createWorkspace: (groupId, name, path) =>
    ipcRenderer.invoke('store:createWorkspace', groupId, name, path),
  deleteWorkspace: (id) => ipcRenderer.invoke('store:deleteWorkspace', id),
  updateWorkspace: (id, patch) => ipcRenderer.invoke('store:updateWorkspace', id, patch),
  moveWorkspace: (workspaceId, toGroupId, toIndex) =>
    ipcRenderer.invoke('store:moveWorkspace', workspaceId, toGroupId, toIndex),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  onMenu: (cb) => {
    const actions = [
      'menu:settings',
      'menu:new-project',
      'menu:new-group',
      'menu:skills',
      'menu:routines',
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

  routinesList: (workspaceId) => ipcRenderer.invoke('routines:list', workspaceId),
  routinesCreate: (workspaceId, workspacePath, prompt, intervalMinutes) =>
    ipcRenderer.invoke('routines:create', workspaceId, workspacePath, prompt, intervalMinutes),
  routinesSetEnabled: (id, enabled) => ipcRenderer.invoke('routines:setEnabled', id, enabled),
  routinesDelete: (id) => ipcRenderer.invoke('routines:delete', id),
  routinesRunNow: (id) => ipcRenderer.send('routines:runNow', id),
  onRoutinesChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('routines:changed', listener)
    return () => ipcRenderer.removeListener('routines:changed', listener)
  },

  skillsList: (projectPath) => ipcRenderer.invoke('skills:list', projectPath),
  skillsInstallStarters: () => ipcRenderer.invoke('skills:installStarters'),

  agentStart: (opts) => ipcRenderer.invoke('agent:start', opts),
  agentSend: (id, text) => ipcRenderer.send('agent:send', id, text),
  agentStop: (id) => ipcRenderer.send('agent:stop', id),
  onAgentEvent: (id, cb) => {
    const channel = `agent:event:${id}`
    const listener = (_e: Electron.IpcRendererEvent, event: Record<string, unknown>): void =>
      cb(event)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onAgentExit: (id, cb) => {
    const channel = `agent:exit:${id}`
    const listener = (_e: Electron.IpcRendererEvent, code: number): void => cb(code)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onHookEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: HookEvent): void => cb(ev)
    ipcRenderer.on('hook:event', listener)
    return () => ipcRenderer.removeListener('hook:event', listener)
  },
  onFocusWorkspace: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('hook:focus-workspace', listener)
    return () => ipcRenderer.removeListener('hook:focus-workspace', listener)
  },
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
