import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardCard } from '../../../preload'
import { useStore } from '../state'

type Status = BoardCard['status']

const COLUMNS: { key: Status; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'Next' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' }
]

/**
 * The project's board, kept by whoever is working — you or the agent.
 *
 * It reads the same table the board_* tools write, and redraws on the
 * board:changed broadcast, so a card the agent moves mid-turn moves here while
 * you watch. Drag a card between columns to move it yourself.
 */
export function BoardPanel({
  workspaceId,
  onClose
}: {
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const [cards, setCards] = useState<BoardCard[]>([])
  const [adding, setAdding] = useState<Status | null>(null)
  const [draft, setDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<Status | null>(null)
  /** The card the drag is currently hovering — the new card lands above it. */
  const [overCard, setOverCard] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const chats = useStore((s) => s.chats[workspaceId])
  const selectChat = useStore((s) => s.selectChat)
  // A card names the conversation that raised it, but only one still open is
  // worth offering as a link.
  const chatTitle = (id: string | null): string | null =>
    (id && chats?.find((c) => c.id === id)?.title) || null

  const refresh = useCallback(async (): Promise<void> => {
    setCards(await window.cove.boardList(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    void refresh()
    // The agent edits the same board — redraw when it does.
    return window.cove.onBoardChanged((p) => {
      if (p.workspaceId === workspaceId) void refresh()
    })
  }, [workspaceId, refresh])

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  const submit = async (status: Status): Promise<void> => {
    const title = draft.trim()
    setDraft('')
    if (!title) {
      setAdding(null)
      return
    }
    await window.cove.boardAdd(workspaceId, title, { status })
    await refresh()
    // Stay open so a list of things can be typed straight in.
    inputRef.current?.focus()
  }

  /** `beforeId` is the card it was dropped onto; null appends to the column. */
  const drop = async (status: Status, beforeId: string | null): Promise<void> => {
    const id = dragId
    setDragId(null)
    setOverCol(null)
    setOverCard(null)
    if (!id || beforeId === id) return
    const card = cards.find((c) => c.id === id)
    if (!card) return
    // Dropping a card back where it already is isn't a move.
    if (card.status === status && beforeId === null) {
      const last = cards.filter((c) => c.status === status).pop()
      if (last?.id === id) return
    }
    // Optimistic: the card lands where it was dropped, then the write confirms.
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, status } : c)))
    await window.cove.boardMove(id, status, beforeId)
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    setCards((cs) => cs.filter((c) => c.id !== id))
    await window.cove.boardRemove(id)
    await refresh()
  }

  const done = cards.filter((c) => c.status === 'done').length

  return (
    <div className="board-panel">
      <div className="board-head">
        <h2>Board</h2>
        <span className="board-sub">
          {cards.length === 0
            ? 'Nothing on it yet'
            : `${done} of ${cards.length} done · Claude keeps this up to date as it works`}
        </span>
        <div className="board-head-spacer" />
        <button className="board-close" onClick={onClose} title="Close the board">
          ✕
        </button>
      </div>

      <div className="board-cols">
        {COLUMNS.map((col) => {
          const mine = cards.filter((c) => c.status === col.key)
          return (
            <section
              key={col.key}
              className={`board-col ${overCol === col.key ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setOverCol(col.key)
              }}
              onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
              onDrop={() => void drop(col.key, null)}
            >
              <header className="board-col-head">
                <span className="board-col-name">{col.label}</span>
                <span className="board-col-count">{mine.length}</span>
                <button
                  className="board-add"
                  title={`Add to ${col.label}`}
                  onClick={() => {
                    setAdding(col.key)
                    setDraft('')
                  }}
                >
                  +
                </button>
              </header>

              <div className="board-col-body">
                {adding === col.key && (
                  <input
                    ref={inputRef}
                    className="board-draft"
                    value={draft}
                    placeholder="What needs doing?"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void submit(col.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submit(col.key)
                      if (e.key === 'Escape') {
                        setDraft('')
                        setAdding(null)
                      }
                    }}
                  />
                )}
                {mine.map((c) => (
                  <article
                    key={c.id}
                    className={`board-card ${dragId === c.id ? 'dragging' : ''} ${
                      overCard === c.id && dragId && dragId !== c.id ? 'insert-above' : ''
                    }`}
                    draggable
                    onDragStart={() => setDragId(c.id)}
                    onDragEnd={() => {
                      setDragId(null)
                      setOverCol(null)
                      setOverCard(null)
                    }}
                    onDragOver={(e) => {
                      // Stop the column handler from also claiming this, or the
                      // drop would always append instead of landing here.
                      e.preventDefault()
                      e.stopPropagation()
                      setOverCol(col.key)
                      setOverCard(c.id)
                    }}
                    onDrop={(e) => {
                      e.stopPropagation()
                      void drop(col.key, c.id)
                    }}
                  >
                    <div className="board-card-title">{c.title}</div>
                    {c.body && <div className="board-card-body">{c.body}</div>}
                    {(chatTitle(c.chatId) || c.branch) && (
                      <div className="board-card-meta">
                        {chatTitle(c.chatId) && (
                          <button
                            className="board-card-chat"
                            title="Open the conversation this came from"
                            onClick={() => {
                              selectChat(workspaceId, c.chatId!)
                              onClose()
                            }}
                          >
                            from {chatTitle(c.chatId)}
                          </button>
                        )}
                        {c.branch && <span className="board-card-branch">⎇ {c.branch}</span>}
                      </div>
                    )}
                    <button
                      className="board-card-x"
                      title="Remove this card"
                      onClick={() => void remove(c.id)}
                    >
                      ✕
                    </button>
                  </article>
                ))}
                {mine.length === 0 && adding !== col.key && (
                  <div className="board-col-empty">—</div>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
