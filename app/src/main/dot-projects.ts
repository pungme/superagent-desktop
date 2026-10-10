import { DESKTOP_WORKSPACE_ID, getTree, lastUsedByWorkspace } from './store'

export interface DotProject {
  id: string
  name: string
  /** 'computer' for the Mac itself; otherwise the project's own kind. */
  kind: string
  path: string
  /** When a conversation in it was last touched (epoch ms), 0 if never. */
  usedAt: number
  pinned: boolean
}

/**
 * What the dot's picker offers, in the order it shows them: the Computer first,
 * then projects with a pinned chat, then the rest by when they were last used.
 * Browser tabs are not projects to ask in, so they are left out.
 */
export function orderDotProjects(
  projects: Omit<DotProject, 'usedAt' | 'pinned'>[],
  used: Record<string, { usedAt: number; pinned: boolean }>
): DotProject[] {
  const rows = projects.map((p) => ({
    ...p,
    usedAt: used[p.id]?.usedAt ?? 0,
    pinned: used[p.id]?.pinned ?? false
  }))
  rows.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) || b.usedAt - a.usedAt || a.name.localeCompare(b.name)
  )
  return [
    {
      id: DESKTOP_WORKSPACE_ID,
      name: 'Computer',
      kind: 'computer',
      path: '',
      usedAt: used[DESKTOP_WORKSPACE_ID]?.usedAt ?? 0,
      pinned: false
    },
    ...rows
  ]
}

export function dotProjects(): DotProject[] {
  const projects = getTree()
    .flatMap((g) => g.workspaces)
    .filter((w) => w.kind !== 'browser' && w.id !== DESKTOP_WORKSPACE_ID)
    .map((w) => ({ id: w.id, name: w.name, kind: String(w.kind), path: w.path }))
  return orderDotProjects(projects, lastUsedByWorkspace())
}
