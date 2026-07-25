import { create } from 'zustand'
import type { TreeGroup } from '../../preload'

export type WorkspaceStatus = 'idle' | 'working' | 'needs-you'

interface CoveState {
  tree: TreeGroup[]
  activeWorkspaceId: string | null
  statuses: Record<string, WorkspaceStatus>
  ports: Record<string, number[]>
  browserOpen: Record<string, boolean>

  refresh: () => Promise<void>
  setActive: (id: string) => void
  setStatus: (workspaceId: string, status: WorkspaceStatus) => void
  addPort: (workspaceId: string, port: number) => void
  toggleBrowser: (workspaceId: string) => void
  sessionIds: Record<string, string>
  hooksEnabled: boolean
  setHooksEnabled: (v: boolean) => void
  startHookListener: () => void

  addGroup: () => Promise<void>
  renameGroup: (id: string, name: string) => Promise<void>
  toggleCollapse: (id: string, collapsed: boolean) => Promise<void>
  addWorkspace: (groupId: string) => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  moveWorkspace: (workspaceId: string, toGroupId: string, toIndex: number) => Promise<void>
}

export const useStore = create<CoveState>((set, get) => ({
  tree: [],
  activeWorkspaceId: null,
  statuses: {},
  ports: {},
  browserOpen: {},
  sessionIds: {},
  hooksEnabled: false,

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
      return { ports: { ...s.ports, [workspaceId]: [...cur, port].slice(-5) } }
    }),
  toggleBrowser: (workspaceId) =>
    set((s) => ({
      browserOpen: { ...s.browserOpen, [workspaceId]: !s.browserOpen[workspaceId] }
    })),
  setHooksEnabled: (v) => set({ hooksEnabled: v }),

  startHookListener: () => {
    window.cove.hooksStatus().then((v) => set({ hooksEnabled: v }))
    window.cove.onHookEvent((e) => {
      if (!e.workspaceId) return
      if (e.status) {
        set((s) => ({ statuses: { ...s.statuses, [e.workspaceId]: e.status! } }))
      }
      if (e.sessionId) {
        set((s) => ({ sessionIds: { ...s.sessionIds, [e.workspaceId]: e.sessionId! } }))
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
  addWorkspace: async (groupId) => {
    const picked = await window.cove.pickFolder()
    if (!picked) return
    const { tree, workspaceId } = await window.cove.createWorkspace(
      groupId,
      picked.name,
      picked.path
    )
    set({ tree, activeWorkspaceId: workspaceId })
  },
  removeWorkspace: async (id) => {
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
