import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardCard } from '../../../preload'
import { useStore } from '../state'

type Status = BoardCard['status']

const STAGES: { key: Status; label: string }[] = [
  { key: 'todo', label: 'Todo' },
  { key: 'doing', label: 'Doing' },
  { key: 'testing', label: 'Testing' },
  { key: 'done', label: 'Done' }
]

/** Where a card goes when you click its dot: todo → doing → testing → done → todo. */
function nextStage(s: Status): Status {
  const i = STAGES.findIndex((x) => x.key === s)
  return STAGES[(i + 1) % STAGES.length].key
}

/**
 * The project's list, kept by whoever is working — you or the agent.
 *
 * A list rather than a board: four columns spent most of the window on empty
 * space, and a project's work reads better as one column you can scan than as
 * four you have to compare. Same table the board_* tools write, redrawn on
 * board:changed, so a card the agent moves moves here while you watch.
 */
export function BoardPanel({
  workspaceId,
  onClose
}: {
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const [cards, setCards] = useState<BoardCard[]>([])
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const chats = useStore((s) => s.chats[workspaceId])
  const selectChat = useStore((s) => s.selectChat)
  const chatTitle = (id: string | null): string | null =>
    (id && chats?.find((c) => c.id === id)?.title) || null

  const refresh = useCallback(async (): Promise<void> => {
    setCards(await window.cove.boardList(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    void refresh()
    return window.cove.onBoardChanged((p) => {
      if (p.workspaceId === workspaceId) void refresh()
    })
  }, [workspaceId, refresh])

  const add = async (): Promise<void> => {
    const title = draft.trim()
    setDraft('')
    if (!title) return
    await window.cove.boardAdd(workspaceId, title, { status: 'todo' })
    await refresh()
    inputRef.current?.focus()
  }

  const cycle = async (c: BoardCard): Promise<void> => {
    const to = nextStage(c.status)
    setCards((cs) => cs.map((x) => (x.id === c.id ? { ...x, status: to } : x)))
    await window.cove.boardMove(c.id, to, null)
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
        <h2>List</h2>
        <span className="board-sub">
          {cards.length === 0
            ? 'Claude adds work here as it goes — or type your own below'
            : `${done} of ${cards.length} done`}
        </span>
        <div className="board-head-spacer" />
        <button className="board-close" onClick={onClose} title="Close the list">
          ✕
        </button>
      </div>

      <div className="board-list">
        {STAGES.map((stage) => {
          const mine = cards.filter((c) => c.status === stage.key)
          if (mine.length === 0) return null
          return (
            <section key={stage.key} className="board-stage">
              <header className="board-stage-head">
                <span className={`board-stage-name s-${stage.key}`}>{stage.label}</span>
                <span className="board-stage-count">{mine.length}</span>
              </header>
              {mine.map((c) => (
                <article key={c.id} className={`board-row s-${c.status}`}>
                  <button
                    className="board-row-dot"
                    title={`Move to ${STAGES.find((s) => s.key === nextStage(c.status))?.label}`}
                    onClick={() => void cycle(c)}
                  />
                  <div className="board-row-main">
                    <div className="board-row-title" title={c.title}>
                      {c.title}
                    </div>
                    {(c.body || chatTitle(c.chatId) || c.branch) && (
                      <div className="board-row-meta">
                        {c.body && <span className="board-row-body">{c.body}</span>}
                        {chatTitle(c.chatId) && (
                          <button
                            className="board-row-chat"
                            title="Open the conversation this came from"
                            onClick={() => {
                              selectChat(workspaceId, c.chatId!)
                              onClose()
                            }}
                          >
                            {chatTitle(c.chatId)}
                          </button>
                        )}
                        {c.branch && <span className="board-row-branch">⎇ {c.branch}</span>}
                      </div>
                    )}
                  </div>
                  <button className="board-row-x" title="Remove" onClick={() => void remove(c.id)}>
                    ✕
                  </button>
                </article>
              ))}
            </section>
          )
        })}

        <div className="board-add-row">
          <input
            ref={inputRef}
            className="board-add-input"
            value={draft}
            placeholder="Add something to do…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
              if (e.key === 'Escape') setDraft('')
            }}
          />
        </div>
      </div>
    </div>
  )
}
