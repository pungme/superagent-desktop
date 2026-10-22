/**
 * A 'cove:workspace-idle' listener for one project: it reacts when that project
 * went idle, or when the event names no project (a deliberate "refresh
 * everything"). Every row of the sidebar used to refresh — git branch, worktree
 * list, icon — whenever ANY agent anywhere finished a turn: with two dozen
 * projects and eighty chats, each turn's end started a burst of git processes
 * and synchronous work in the main process, and the app stalled while agents
 * worked (2026-10-22).
 */
export function idleFor(workspaceId: string | undefined, run: () => void): (e: Event) => void {
  return (e: Event): void => {
    const id = (e as CustomEvent<{ workspaceId?: string } | undefined>).detail?.workspaceId
    if (!id || !workspaceId || id === workspaceId) run()
  }
}
