import { useState } from 'react'
import { useStore } from '../state'

/**
 * Which of a list's chats stay mounted: the one on screen, the last few you
 * were in, and any still busy.
 *
 * A chat's agent lives inside its mounted <EasyChat>, and unmounting it stops
 * the agent at once. Keeping only the on-screen chat plus the ones flagged busy
 * tore sessions down in the gaps the flag doesn't cover: just after you send
 * (before the agent reports it's working), or while it runs background work the
 * app can't see. The last few chats stay mounted too, so switching away never
 * stops a session the moment you look elsewhere. Bounded, so it can't leak.
 * Shared by the project view and the Computer's Chats, which used to differ.
 */
export function useMountedChats<T extends { id: string }>(
  chats: T[] | undefined,
  activeChatId: string | undefined,
  keep = 3
): T[] {
  const busy = useStore((s) => s.busy)
  // React's adjust-state-in-render idiom: no effect, no extra frame.
  const [recent, setRecent] = useState<string[]>(() => (activeChatId ? [activeChatId] : []))
  if (activeChatId && recent[0] !== activeChatId) {
    setRecent([activeChatId, ...recent.filter((id) => id !== activeChatId)].slice(0, keep))
  }
  return (chats ?? []).filter(
    (c) =>
      c.id === activeChatId ||
      recent.includes(c.id) ||
      busy[c.id]?.generating ||
      (busy[c.id]?.background ?? 0) > 0
  )
}
