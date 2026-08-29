import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { DesktopChat } from './DesktopChat'

/**
 * Chats, and nothing else: the conversations down the side, the current one
 * beside them, filling the whole content area. The same conversations the
 * Computer's Chat window holds — this is them without the desktop around
 * them, for when you just want to talk.
 */
export function ChatsView(): React.JSX.Element {
  const [home, setHome] = useState<{ workspaceId: string; cwd: string } | null>(null)
  const loadChats = useStore((s) => s.loadChats)
  useEffect(() => {
    let alive = true
    void window.cove.desktopChatHome?.().then((h) => {
      if (!alive || !h) return
      setHome(h)
      void loadChats(h.workspaceId)
    })
    return () => {
      alive = false
    }
  }, [loadChats])
  if (!home) return <div className="chats-view chats-view-empty">Starting…</div>
  return (
    <div className="chats-view">
      <DesktopChat workspaceId={home.workspaceId} cwd={home.cwd} />
    </div>
  )
}
