import { create } from 'zustand'
import { useEffect } from 'react'
import type { TreeGroup } from '../../preload'

export type WorkspaceStatus = 'idle' | 'working' | 'needs-you'

interface CoveState {
  tree: TreeGroup[]
  activeWorkspaceId: string | null
  statuses: Record<string, WorkspaceStatus>
  ports: Record<string, number[]>
  browserOpen: Record<string, boolean>
  filesOpen: Record<string, boolean>

  // Count of open HTML overlays (slide-overs, modals). While > 0 the native
  // browser view is hidden so it can't cover them.
  overlayCount: number
  enterOverlay: () => void
  exitOverlay: () => void

  refresh: () => Promise<void>
  setActive: (id: string) => void
  setStatus: (workspaceId: string, status: WorkspaceStatus) => void
  addPort: (workspaceId: string, port: number) => void
  toggleBrowser: (workspaceId: string) => void
  toggleFiles: (workspaceId: string) => void
  hooksEnabled: boolean
  setHooksEnabled: (v: boolean) => void
  startHookListener: () => void

  previewUrls: Record<string, string>
  reloadOnIdle: Record<string, boolean>
  toast: { workspaceId: string; port: number } | null
  openPreview: (workspaceId: string, port: number) => void
  dismissToast: () => void
  setReloadOnIdle: (workspaceId: string, v: boolean) => void

  browsingWorkspaceId: string | null
  stopBrowsing: () => void
  startBrowsingListener: () => void

  agentIds: Record<string, string>
  registerAgent: (workspaceId: string, agentId: string) => void
  sendToClaude: (workspaceId: string, text: string) => void

  theme: 'system' | 'light' | 'dark'
  setTheme: (t: 'system' | 'light' | 'dark') => void
  applyTheme: () => void

  addGroup: () => Promise<void>
  renameGroup: (id: string, name: string) => Promise<void>
  toggleCollapse: (id: string, collapsed: boolean) => Promise<void>
  addWorkspace: (groupId: string) => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  moveWorkspace: (workspaceId: string, toGroupId: string, toIndex: number) => Promise<void>

  // New-project chooser (Code vs Browser project).
  newProjectGroupId: string | null
  closeNewProject: () => void
  createCodeProject: (groupId: string) => Promise<void>
  createBrowserProject: (groupId: string) => Promise<void>
}

export const useStore = create<CoveState>((set, get) => ({
  tree: [],
  activeWorkspaceId: null,
  statuses: {},
  ports: {},
  browserOpen: {},
  filesOpen: {},
  overlayCount: 0,
  enterOverlay: () => set((s) => ({ overlayCount: s.overlayCount + 1 })),
  exitOverlay: () => set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
  hooksEnabled: false,
  previewUrls: {},
  reloadOnIdle: {},
  toast: null,
  browsingWorkspaceId: null,
  agentIds: {},
  theme: (localStorage.getItem('cove.theme') as 'system' | 'light' | 'dark') || 'system',

  refresh: async () => {
    const tree = await window.cove.storeTree()
    set({ tree })
    const active = get().activeWorkspaceId
    const allIds = tree.flatMap((g) => g.workspaces.map((w) => w.id))
    if (!active || !allIds.includes(active)) {
      set({ activeWorkspaceId: allIds[0] ?? null })
    }
  },

  setActive: (id) => set({ activeWorkspaceId: id }),
  setStatus: (workspaceId, status) =>
    set((s) => ({ statuses: { ...s.statuses, [workspaceId]: status } })),
  addPort: (workspaceId, port) =>
    set((s) => {
      const cur = s.ports[workspaceId] ?? []
      if (cur.includes(port)) return s
      // First time we see this port → surface a toast offering to open the preview.
      return {
        ports: { ...s.ports, [workspaceId]: [...cur, port].slice(-5) },
        toast: { workspaceId, port }
      }
    }),
  toggleFiles: (workspaceId) =>
    set((s) => ({
      filesOpen: { ...s.filesOpen, [workspaceId]: !s.filesOpen[workspaceId] }
    })),

  toggleBrowser: (workspaceId) =>
    set((s) => ({
      browserOpen: { ...s.browserOpen, [workspaceId]: !s.browserOpen[workspaceId] }
    })),
  setHooksEnabled: (v) => set({ hooksEnabled: v }),

  openPreview: (workspaceId, port) =>
    set((s) => ({
      activeWorkspaceId: workspaceId,
      browserOpen: { ...s.browserOpen, [workspaceId]: true },
      previewUrls: { ...s.previewUrls, [workspaceId]: `http://localhost:${port}` },
      toast: null
    })),
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
    window.cove.onBrowserActivity((workspaceId) => {
      set({ browsingWorkspaceId: workspaceId })
      if (timer) clearTimeout(timer)
      // Auto-clear the indicator a few seconds after the last tool call.
      timer = setTimeout(() => set({ browsingWorkspaceId: null }), 4000)
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
  registerAgent: (workspaceId, agentId) =>
    set((s) => ({ agentIds: { ...s.agentIds, [workspaceId]: agentId } })),
  sendToClaude: (workspaceId, text) => {
    // Send as a chat message to the streaming agent (the single Chat mode).
    const agentId = get().agentIds[workspaceId]
    if (agentId) {
      window.cove.agentSend(agentId, text)
      window.dispatchEvent(
        new CustomEvent('cove:easy-user-message', { detail: { workspaceId, text } })
      )
    }
  },

  startHookListener: () => {
    window.cove.hooksStatus().then((v) => set({ hooksEnabled: v }))
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
  toggleCollapse: async (id, collapsed) => {
    const tree = await window.cove.updateGroup(id, { collapsed: collapsed ? 1 : 0 })
    set({ tree })
  },
  // Opens the Code-vs-Browser chooser rather than immediately picking a folder.
  addWorkspace: async (groupId) => {
    set({ newProjectGroupId: groupId })
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
