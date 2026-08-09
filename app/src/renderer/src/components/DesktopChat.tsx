import { useState } from 'react'
import { useStore } from '../state'
import { EasyChat } from './EasyChat'

/** "Today 14:02" for today, otherwise a short date. */
function when(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/**
 * The Chat app: conversations down the side, the current one beside them.
 *
 * A project's chats are reachable from its own sidebar tree, but the desktop
 * chat had nowhere to keep them — so it was one endless conversation with a
 * "New chat" button that quietly abandoned the old one. This is the same set of
 * operations any chat app has: start one, go back to one, rename it, throw it
 * away.
 */
export function DesktopChat({
  workspaceId,
  cwd
}: {
  workspaceId: string
  cwd: string
}): React.JSX.Element {
  const chats = useStore((s) => s.chats[workspaceId])
  const activeChatId = useStore((s) => s.activeChatId[workspaceId])
  const newChat = useStore((s) => s.newChat)
  const selectChat = useStore((s) => s.selectChat)
  const removeChat = useStore((s) => s.removeChat)
  const renameChat = useStore((s) => s.renameChat)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const active = chats?.find((c) => c.id === activeChatId)
  const ordered = [...(chats ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  return (
    <div className="dchat">
      <aside className="dchat-list">
        <button className="dchat-new" onClick={() => void newChat(workspaceId)}>
          + New chat
        </button>
        <div className="dchat-items">
          {ordered.map((c) => (
            <div
              key={c.id}
              className={`dchat-item ${c.id === activeChatId ? 'on' : ''}`}
              onClick={() => selectChat(workspaceId, c.id)}
              onDoubleClick={() => {
                setDraft(c.title ?? '')
                setEditing(c.id)
              }}
              title={c.title ?? 'New chat'}
            >
              {editing === c.id ? (
                <input
                  className="dchat-rename"
                  value={draft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    const n = draft.trim()
                    if (n && n !== c.title) void renameChat(workspaceId, c.id, n)
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <>
                  <span className="dchat-item-title">{c.title ?? 'New chat'}</span>
                  <span className="dchat-item-when">{when(c.updatedAt)}</span>
                  <button
                    className="dchat-item-x"
                    title="Delete this conversation"
                    onClick={(e) => {
                      e.stopPropagation()
                      // A conversation is work; deleting one should take a
                      // decision, not a stray click on a small ✕.
                      if (window.confirm(`Delete "${c.title ?? 'New chat'}"?`)) {
                        void removeChat(workspaceId, c.id)
                      }
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
          {ordered.length === 0 && <div className="dchat-empty">No conversations yet.</div>}
        </div>
      </aside>

      <div className="dchat-main">
        {activeChatId ? (
          <EasyChat
            key={activeChatId}
            cwd={active?.cwd || cwd}
            workspaceId={workspaceId}
            chatId={activeChatId}
            initialSessionId={active?.claudeSessionId ?? null}
          />
        ) : (
          <div className="desktop-app-empty">Starting…</div>
        )}
      </div>
    </div>
  )
}
