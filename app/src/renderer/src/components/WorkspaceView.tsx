import { useEffect, useMemo } from 'react'
import { useStore } from '../state'
import { useMountedChats } from '../hooks/useMountedChats'
import { ChatDesk, type DeskTile } from './ChatDesk'
import type { Workspace } from '../../../preload'

/** A conversation of this project in a window of the split, and where it sits. */
export interface WorkspaceTile extends DeskTile {
  chatId: string
}

/**
 * A project: its conversations, each on its own desk (ChatDesk).
 *
 * The desks are one stable list keyed by conversation, so showing a chat,
 * hiding it, or moving it between the windows of a split never remounts it —
 * a chat's agent lives inside its mounted <EasyChat>, and remounting stops it.
 *
 * Without `tiles` this is the one-conversation view it always was: the active
 * chat fills the project, the last few and any busy ones stay mounted, hidden.
 * With `tiles` (split view) every chat of this project that is in the split is
 * placed at its window's rectangle, and the rest stay mounted, hidden.
 */
export function WorkspaceView({
  ws,
  visible = true,
  tiles
}: {
  ws: Workspace
  visible?: boolean
  tiles?: WorkspaceTile[]
}): React.JSX.Element {
  const activeChatId = useStore((s) => s.activeChatId[ws.id])
  const chats = useStore((s) => s.chats[ws.id])
  const loadChats = useStore((s) => s.loadChats)
  useEffect(() => {
    loadChats(ws.id)
  }, [ws.id, loadChats])

  // A browser project needs a conversation to own its browser pane. Code-folder
  // projects are allowed to remain empty until the user explicitly starts a
  // chat; creating one merely because the folder became active produced the
  // unwanted nested "New chat / no branch yet" row.
  const newChat = useStore((s) => s.newChat)
  const chatsLoaded = chats !== undefined
  useEffect(() => {
    if (ws.kind !== 'browser' || !chatsLoaded || (chats?.length ?? 0) > 0) return
    void newChat(ws.id)
  }, [ws.kind, chatsLoaded, chats?.length, ws.id, newChat])

  // The on-screen chat, the last few you were in, and any still busy stay
  // mounted — unmounting one stops its agent. See useMountedChats.
  const recent = useMountedChats(chats, activeChatId)
  const tileOf = useMemo(() => new Map((tiles ?? []).map((t) => [t.chatId, t])), [tiles])
  const mounted = useMemo(() => {
    const keep = new Set(recent.map((c) => c.id))
    for (const id of tileOf.keys()) keep.add(id)
    return (chats ?? []).filter((c) => keep.has(c.id))
  }, [chats, recent, tileOf])

  if (tiles) {
    return (
      <>
        {mounted.map((c) => {
          const t = tileOf.get(c.id)
          return (
            <ChatDesk
              key={c.id}
              ws={ws}
              chatId={c.id}
              visible={visible && !!t}
              focused={visible && !!t?.focused}
              hidden={!t}
              tile={t}
            />
          )
        })}
      </>
    )
  }

  const shown = mounted.some((c) => c.id === activeChatId)
  return (
    <>
      {mounted.map((c) => (
        <ChatDesk
          key={c.id}
          ws={ws}
          chatId={c.id}
          visible={visible && c.id === activeChatId}
          hidden={c.id !== activeChatId}
        />
      ))}
      {/* No conversation on screen yet (none chosen, none loaded, or a project
          without one): the desk still shows the toolbar, the browser of a
          browser project, and the way to start a chat. */}
      {!shown && <ChatDesk key="__project" ws={ws} chatId={activeChatId} visible={visible} />}
    </>
  )
}
