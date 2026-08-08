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
  /** The row being dragged, and the row it would land above. */
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  /** The stage being hovered when the drop would append rather than insert. */
  const [overStage, setOverStage] = useState<Status | null>(null)
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

  /** Drop onto a row inserts above it; drop onto a stage appends to the end. */
  const drop = async (status: Status, beforeId: string | null): Promise<void> => {
    const id = dragId
    setDragId(null)
    setOverId(null)
    setOverStage(null)
    if (!id || id === beforeId) return
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, status } : c)))
    await window.cove.boardMove(id, status, beforeId)
    await refresh()
  }

  const endDrag = (): void => {
    setDragId(null)
    setOverId(null)
    setOverStage(null)
  }

  /**
   * Hand an item to the agent: move it to doing, then send it as the prompt and
   * get out of the way so you can watch. The body goes too when there is one —
   * that is where the specification lives.
   */
  const workOn = async (c: BoardCard): Promise<void> => {
    const text = c.body ? `${c.title}\n\n${c.body}` : c.title
    if (c.status !== 'doing') await window.cove.boardMove(c.id, 'doing', null)
    await refresh()
    window.dispatchEvent(
      new CustomEvent('cove:work-on', { detail: { workspaceId, text } })
    )
    onClose()
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
          // Empty stages stay hidden normally, but during a drag they have to
          // be visible — otherwise there is nowhere to drop something into a
          // stage that happens to be empty.
          if (mine.length === 0 && !dragId) return null
          return (
            <section
              key={stage.key}
              className={`board-stage ${overStage === stage.key ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setOverStage(stage.key)
                setOverId(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                void drop(stage.key, null)
              }}
            >
              <header className="board-stage-head">
                <span className={`board-stage-name s-${stage.key}`}>{stage.label}</span>
                <span className="board-stage-count">{mine.length}</span>
              </header>
              {mine.map((c) => (
                <article
                  key={c.id}
                  className={`board-row s-${c.status} ${dragId === c.id ? 'dragging' : ''} ${
                    overId === c.id && dragId && dragId !== c.id ? 'insert-above' : ''
                  }`}
                  draggable
                  onDragStart={() => setDragId(c.id)}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    // Claim it from the stage, or every drop would append.
                    e.preventDefault()
                    e.stopPropagation()
                    setOverId(c.id)
                    setOverStage(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void drop(stage.key, c.id)
                  }}
                >
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
                  <div className="board-row-actions">
                    {c.status !== 'done' && (
                      <button
                        className="board-row-work"
                        title="Send this to Claude and start on it"
                        onClick={() => void workOn(c)}
                      >
                        Work on this
                      </button>
                    )}
                    <button
                      className="board-row-x"
                      title="Remove"
                      onClick={() => void remove(c.id)}
                    >
                      ✕
                    </button>
                  </div>
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
