import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardCard } from '../../../preload'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useStore } from '../state'
import { Markdown } from './Markdown'

type Status = BoardCard['status']

/** What a card says, as a prompt: the title, and the body where the spec lives. */
export const cardText = (c: BoardCard): string => (c.body ? `${c.title}\n\n${c.body}` : c.title)
/** Marks a drag as carrying a board card, so only the composer reacts to it. */
export const CARD_MIME = 'application/x-superagent-card'

const STAGES: { key: Status; label: string }[] = [
  { key: 'todo', label: 'Todo' },
  { key: 'doing', label: 'Doing' },
  { key: 'testing', label: 'Testing' },
  { key: 'done', label: 'Done' }
]

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
  /** The item opened as a ticket, if any. */
  const [openId, setOpenId] = useState<string | null>(null)
  /** The item whose stage picker is open, if any. */
  const [menuId, setMenuId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const chats = useStore((s) => s.chats[workspaceId])
  const selectChat = useStore((s) => s.selectChat)
  const chatTitle = (id: string | null): string | null =>
    (id && chats?.find((c) => c.id === id)?.title) || null

  // Escape peels one layer at a time: the open ticket, then whatever you had
  // half-typed, then the list. Nothing you would have to retype is skipped.
  useEscapeClose(openId ? () => setOpenId(null) : draft ? () => setDraft('') : onClose)

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

  /** Move a card straight to a stage the user picked, no cycling through the rest. */
  const moveTo = async (c: BoardCard, to: Status): Promise<void> => {
    setMenuId(null)
    if (to === c.status) return
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
    const text = cardText(c)
    if (c.status !== 'doing') await window.cove.boardMove(c.id, 'doing', null)
    await refresh()
    window.dispatchEvent(new CustomEvent('cove:work-on', { detail: { workspaceId, text } }))
    onClose()
  }

  const save = async (
    id: string,
    patch: { title?: string; body?: string; tags?: string[] }
  ): Promise<void> => {
    await window.cove.boardUpdate(id, patch)
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
        <h2>Todo</h2>
        <span className="board-sub">
          {cards.length === 0
            ? 'Claude adds work here as it goes — or type your own below'
            : `${done} of ${cards.length} done`}
        </span>
        <div className="board-head-spacer" />
        <button className="board-close" onClick={onClose} title="Close the to-do">
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
                  className={`board-row s-${c.status} ${
                    dragId === c.id ? 'dragging' : ''
                  } ${overId === c.id && dragId && dragId !== c.id ? 'insert-above' : ''}`}
                  draggable={openId !== c.id}
                  onDragStart={(e) => {
                    setDragId(c.id)
                    // The same text `workOn` sends, but carried on the drag so
                    // it can land in the composer instead of going straight to
                    // the agent — dropping it lets you add to it first, which
                    // is the difference between handing over a card and asking
                    // for something slightly different from what it says.
                    e.dataTransfer.setData(CARD_MIME, cardText(c))
                    e.dataTransfer.setData('text/plain', cardText(c))
                    e.dataTransfer.effectAllowed = 'copyMove'
                  }}
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
                  <div className="board-row-stage">
                    <button
                      className="board-row-dot"
                      title="Change stage"
                      onClick={() => setMenuId(menuId === c.id ? null : c.id)}
                    />
                    {menuId === c.id && (
                      <>
                        {/* Click anywhere else dismisses the picker. */}
                        <div className="board-stage-backdrop" onClick={() => setMenuId(null)} />
                        <div className="board-stage-menu" role="menu">
                          {STAGES.map((s) => (
                            <button
                              key={s.key}
                              role="menuitemradio"
                              aria-checked={s.key === c.status}
                              className={`board-stage-opt s-${s.key} ${
                                s.key === c.status ? 'current' : ''
                              }`}
                              onClick={() => void moveTo(c, s.key)}
                            >
                              <span className={`board-stage-swatch s-${s.key}`} />
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <div
                    className="board-row-main"
                    onClick={() => setOpenId(openId === c.id ? null : c.id)}
                  >
                    {/* The open ticket carries the title, so showing it here too
                        just prints the same line twice. */}
                    {openId !== c.id && (
                      <div className="board-row-title" title={c.title}>
                        {c.title}
                      </div>
                    )}
                    {openId !== c.id && (c.repo || c.tags.length > 0) && (
                      <div className="board-row-tags">
                        {c.repo && (
                          <span
                            className="board-tag board-tag-repo"
                            title="Filed on this repo's own board"
                          >
                            {c.repo}
                          </span>
                        )}
                        {c.tags.map((t) => (
                          <span key={t} className="board-tag">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    {openId !== c.id && (c.body || chatTitle(c.chatId) || c.branch) && (
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
                  {openId === c.id && (
                    <Ticket card={c} onSave={save} onClose={() => setOpenId(null)} />
                  )}
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
            }}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * An item opened up: the title and description you can edit, and pictures.
 *
 * Rendered under its row rather than in a modal — the list stays visible and
 * you keep your place. Edits save on blur; there is no Save button because
 * there is nothing to cancel.
 */
function Ticket({
  card,
  onSave,
  onClose
}: {
  card: BoardCard
  onSave: (id: string, patch: { title?: string; body?: string; tags?: string[] }) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(card.title)
  const [body, setBody] = useState(card.body)
  const [tags, setTags] = useState<string[]>(card.tags)
  const [tagDraft, setTagDraft] = useState('')
  // The body renders as markdown (the agent writes tables, checklists, ✅/❌);
  // click it to drop into a plain textarea and edit the source. A card with no
  // body opens straight into edit mode so there is something to type into.
  const [editing, setEditing] = useState(card.body.trim() === '')
  const [thumbs, setThumbs] = useState<{ path: string; data: string }[]>([])
  const [over, setOver] = useState(false)

  const addTag = (raw: string): void => {
    const t = raw.trim().slice(0, 32)
    setTagDraft('')
    if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return
    const next = [...tags, t]
    setTags(next)
    void onSave(card.id, { tags: next })
  }
  const removeTag = (t: string): void => {
    const next = tags.filter((x) => x !== t)
    setTags(next)
    void onSave(card.id, { tags: next })
  }

  // Pictures live on disk outside the app, so they arrive as data URIs.
  useEffect(() => {
    let alive = true
    void Promise.all(
      card.images.map(async (p) => ({ path: p, data: (await window.cove.boardImageData(p)) ?? '' }))
    ).then((list) => {
      if (alive) setThumbs(list.filter((t) => t.data))
    })
    return () => {
      alive = false
    }
  }, [card.images])

  const addFiles = async (files: File[]): Promise<void> => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      const bytes = new Uint8Array(await f.arrayBuffer())
      await window.cove.boardAddImage(card.id, f.name || 'pasted.png', bytes)
    }
  }

  return (
    <div
      className={`ticket ${over ? 'over' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        void addFiles([...e.dataTransfer.files])
      }}
    >
      <input
        className="ticket-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== card.title && void onSave(card.id, { title })}
      />

      <div className="ticket-tags">
        {tags.map((t) => (
          <span key={t} className="board-tag editable">
            {t}
            <button className="board-tag-x" title="Remove label" onClick={() => removeTag(t)}>
              ✕
            </button>
          </span>
        ))}
        <input
          className="ticket-tag-input"
          value={tagDraft}
          placeholder={tags.length ? '+ label' : '+ add a label'}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addTag(tagDraft)
            } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
              removeTag(tags[tags.length - 1])
            }
          }}
          onBlur={() => tagDraft && addTag(tagDraft)}
        />
      </div>

      {editing ? (
        <textarea
          className="ticket-body"
          value={body}
          autoFocus
          placeholder="What needs doing, how you'll know it's done, where to start… markdown works (tables, checklists), and you can paste a screenshot straight in."
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => {
            if (body !== card.body) void onSave(card.id, { body })
            if (body.trim()) setEditing(false)
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
        />
      ) : (
        <div
          className="ticket-body-rendered"
          title="Click to edit"
          onClick={() => setEditing(true)}
        >
          <Markdown text={body} />
        </div>
      )}

      {thumbs.length > 0 && (
        <div className="ticket-shots">
          {thumbs.map((t) => (
            <div key={t.path} className="ticket-shot">
              <img
                src={t.data}
                alt=""
                title="Open full size"
                onClick={() => void window.cove.filesOpenExternal(t.path)}
              />
              <button
                className="ticket-shot-x"
                title="Remove this picture"
                onClick={() => void window.cove.boardRemoveImage(card.id, t.path)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ticket-foot">
        <span>Drop or paste a picture to attach it</span>
        <button className="ticket-done" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
