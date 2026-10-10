/**
 * Where the user has been in the app, so "go back" has somewhere to go: each
 * conversation shown, in order. Seeing the same one twice in a row is one
 * visit; going back removes the place you are leaving, as a browser does not,
 * because here there is no "forward" to keep it for.
 */
export interface Visit {
  workspaceId: string
  chatId: string
}

const same = (a: Visit, b: Visit): boolean =>
  a.workspaceId === b.workspaceId && a.chatId === b.chatId

/** The history with this place visited. Kept short: nobody goes back fifty times. */
export function visited(history: Visit[], now: Visit, max = 30): Visit[] {
  if (!now.workspaceId) return history
  const last = history[history.length - 1]
  if (last && same(last, now)) return history
  return [...history, now].slice(-max)
}

/**
 * Going back: the place before the one on screen, and the history without the
 * one being left. Null when there is nowhere earlier.
 */
export function goBack(history: Visit[]): { to: Visit; history: Visit[] } | null {
  if (history.length < 2) return null
  const rest = history.slice(0, -1)
  return { to: rest[rest.length - 1], history: rest }
}
