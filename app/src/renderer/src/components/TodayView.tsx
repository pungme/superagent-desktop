import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardCard, CalendarEvent, Chat } from '../../../preload'
import { useStore } from '../state'

/**
 * Today: the day on one screen, where Computer used to be.
 *
 * Three columns: the calendar (Superagent's own, the same events as the
 * Calendar app), every project's open to-dos (the project boards), and the
 * agents (what waits on you, what is running, what just finished). The box at
 * the bottom asks the agent that is not tied to a project, in a new chat under
 * Chats. A to-do can be handed to an agent: it gets a chat of its own in its
 * project (main/today.ts).
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const minutes = (iso: string): number =>
  iso.length < 16 ? 0 : Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
const hhmm = (m: number): string => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`

function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

export function TodayView({ visible }: { visible: boolean }): React.JSX.Element {
  const now = useNow()
  const today = ymd(now)
  const tree = useStore((s) => s.tree)
  const busy = useStore((s) => s.busy)
  const unread = useStore((s) => s.unread)
  const asks = useStore((s) => s.guardrailAsks)
  const resolveAsk = useStore((s) => s.resolveGuardrailAsk)
  const setActive = useStore((s) => s.setActive)
  const selectChat = useStore((s) => s.selectChat)
  const setOverlay = useStore((s) => s.setOverlay)

  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [cards, setCards] = useState<BoardCard[]>([])
  const [chats, setChats] = useState<Chat[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTodo, setNewTodo] = useState('')
  const [handing, setHanding] = useState<string | null>(null)

  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of tree) for (const w of g.workspaces) m.set(w.id, w.name)
    return m
  }, [tree])
  const projects = useMemo(
    () => tree.flatMap((g) => g.workspaces).filter((w) => w.kind === 'app'),
    [tree]
  )
  const [todoProject, setTodoProject] = useState('')
  const project = todoProject || projects[0]?.id || ''

  const load = useCallback(async (): Promise<void> => {
    const [ev, cs, all] = await Promise.all([
      window.cove.calendarList(
        today,
        ymd(new Date(new Date(`${today}T12:00`).getTime() + 86_400_000))
      ),
      window.cove.todayCards(),
      window.cove.chatListAll()
    ])
    setEvents(ev)
    setCards(cs)
    setChats(all)
  }, [today])

  useEffect(() => {
    if (!visible) return
    // Off the effect's own turn: the first read lands like every later one.
    const first = setTimeout(() => void load(), 0)
    const t = setInterval(() => void load(), 5000)
    const onBoard = (): void => void load()
    const off = window.cove.onBoardChanged?.(onBoard)
    return () => {
      clearTimeout(first)
      clearInterval(t)
      off?.()
    }
  }, [visible, load])

  const open = (workspaceId: string, chatId: string): void => {
    setOverlay(null)
    setActive(workspaceId)
    selectChat(workspaceId, chatId)
  }

  // --- calendar --------------------------------------------------------------
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const allDay = events.filter((e) => e.allDay)
  const timed = events
    .filter((e) => !e.allDay && e.start.slice(0, 10) === today)
    .sort((a, b) => minutes(a.start) - minutes(b.start))
  const nowIndex = timed.findIndex((e) => minutes(e.start) > nowMin)

  // --- agents ----------------------------------------------------------------
  const chatById = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats])
  const working = chats.filter((c) => busy[c.id]?.generating)
  const finished = chats
    .filter((c) => unread[c.id] && !busy[c.id]?.generating)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    const r = await window.cove.todayAsk(text)
    setSending(false)
    if (!r.ok) return setError(r.error)
    setDraft('')
    open(r.workspaceId, r.chatId)
  }

  const hand = async (c: BoardCard): Promise<void> => {
    setHanding(c.id)
    setError(null)
    const r = await window.cove.todayHand(c.id)
    setHanding(null)
    if (!r.ok) setError(r.error)
    void load()
  }

  const addTodo = async (): Promise<void> => {
    const title = newTodo.trim()
    if (!title || !project) return
    await window.cove.boardAdd(project, title)
    setNewTodo('')
    void load()
  }

  const dateLine = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  const needsYou = asks.length

  return (
    <div className="today">
      <header className="today-head">
        <h1>Today</h1>
        <span className="today-sub">
          {dateLine} · {timed.length + allDay.length}{' '}
          {timed.length + allDay.length === 1 ? 'event' : 'events'} · {cards.length} to-do
          {cards.length === 1 ? '' : 's'} · {working.length} working
          {needsYou ? ` · ${needsYou} need${needsYou === 1 ? 's' : ''} you` : ''}
        </span>
      </header>

      <div className="today-cols">
        <section className="today-col" aria-label="Calendar">
          <h2>Calendar</h2>
          {allDay.map((e) => (
            <div key={e.id} className="today-ev allday">
              <time>All day</time>
              <div className="today-ev-b">{e.title}</div>
            </div>
          ))}
          {timed.length === 0 && allDay.length === 0 && (
            <p className="today-empty">Nothing on the calendar today.</p>
          )}
          {timed.map((e, i) => {
            const start = minutes(e.start)
            const end = e.end ? minutes(e.end) : start + 30
            return (
              <div key={e.id}>
                {i === nowIndex && (
                  <div className="today-now">
                    {hhmm(nowMin)}
                    <i />
                  </div>
                )}
                <div className={`today-ev ${end <= nowMin ? 'past' : ''}`}>
                  <time>{hhmm(start)}</time>
                  <div
                    className="today-ev-b"
                    style={e.color ? ({ '--ev': e.color } as React.CSSProperties) : undefined}
                  >
                    {e.title}
                    <small>
                      {Math.max(end - start, 0) >= 60
                        ? `${Math.round(((end - start) / 60) * 10) / 10} h`
                        : `${end - start} min`}
                      {e.notes ? ` · ${e.notes.split('\n')[0].slice(0, 60)}` : ''}
                    </small>
                  </div>
                </div>
              </div>
            )
          })}
          {timed.length > 0 && nowIndex === -1 && (
            <div className="today-now">
              {hhmm(nowMin)}
              <i />
            </div>
          )}
        </section>

        <section className="today-col" aria-label="To-do">
          <h2>To-do</h2>
          {cards.length === 0 && <p className="today-empty">No open to-dos in any project.</p>}
          {cards.map((c) => {
            const chat = c.chatId ? chatById.get(c.chatId) : undefined
            const running = !!(c.chatId && busy[c.chatId]?.generating)
            return (
              <div key={c.id} className="today-td">
                <button
                  className="today-ck"
                  aria-label={`Done: ${c.title}`}
                  onClick={() => void window.cove.boardMove(c.id, 'done', null).then(load)}
                />
                <div className="today-td-t">
                  <span>{c.title}</span>
                  <small>
                    {names.get(c.workspaceId) ?? 'Project'}
                    {c.status !== 'todo' ? ` · ${c.status === 'doing' ? 'Doing' : 'Testing'}` : ''}
                  </small>
                </div>
                {running && chat ? (
                  <button
                    className="today-pill working"
                    onClick={() => open(chat.workspaceId, chat.id)}
                  >
                    Agent working
                  </button>
                ) : chat ? (
                  <button className="today-pill" onClick={() => open(chat.workspaceId, chat.id)}>
                    Open chat
                  </button>
                ) : (
                  <button
                    className="today-pill strong"
                    disabled={handing === c.id}
                    onClick={() => void hand(c)}
                  >
                    {handing === c.id ? 'Handing…' : 'Hand to agent'}
                  </button>
                )}
              </div>
            )
          })}
          {projects.length > 0 && (
            <form
              className="today-new"
              onSubmit={(e) => {
                e.preventDefault()
                void addTodo()
              }}
            >
              <input
                value={newTodo}
                onChange={(e) => setNewTodo(e.target.value)}
                placeholder="+ New to-do"
                aria-label="New to-do"
              />
              {newTodo.trim() && (
                <select
                  value={project}
                  onChange={(e) => setTodoProject(e.target.value)}
                  aria-label="Project"
                >
                  {projects.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              )}
            </form>
          )}
        </section>

        <section className="today-col" aria-label="Agents">
          <h2>Agents</h2>
          {asks.map((a) => (
            <div key={a.requestId} className="today-ag need">
              <div className="today-ag-l">
                <i className="today-dot need" />
                <b>{names.get(a.workspaceId) ?? 'Chats'}</b>
                <span>needs you</span>
              </div>
              <p>{a.preview.split('\n')[0].slice(0, 160)}</p>
              <div className="today-acts">
                <button
                  className="today-pill strong"
                  onClick={() => resolveAsk(a.requestId, true, false)}
                >
                  Allow
                </button>
                <button
                  className="today-pill"
                  onClick={() => resolveAsk(a.requestId, false, false)}
                >
                  Deny
                </button>
                <button
                  className="today-pill"
                  onClick={() => {
                    setOverlay(null)
                    setActive(a.workspaceId)
                  }}
                >
                  Open
                </button>
              </div>
            </div>
          ))}
          {working.map((c) => (
            <button key={c.id} className="today-ag" onClick={() => open(c.workspaceId, c.id)}>
              <div className="today-ag-l">
                <i className="today-dot working" />
                <b>{c.title || 'New chat'}</b>
                <span>working</span>
              </div>
              <p>
                {names.get(c.workspaceId) ?? 'Chats'}
                {busy[c.id]?.doing ? ` · ${busy[c.id]!.doing!.slice(0, 120)}` : ''}
              </p>
            </button>
          ))}
          {finished.map((c) => (
            <button key={c.id} className="today-ag" onClick={() => open(c.workspaceId, c.id)}>
              <div className="today-ag-l">
                <i className="today-dot" />
                <b>{c.title || 'New chat'}</b>
                <span>done</span>
              </div>
              <p>{names.get(c.workspaceId) ?? 'Chats'} · finished while you were away</p>
            </button>
          ))}
          {asks.length === 0 && working.length === 0 && finished.length === 0 && (
            <p className="today-empty">No agent is working right now.</p>
          )}
        </section>
      </div>

      <form
        className="today-ask"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'Ask about your day, or anything: "what\'s left today?"'}
          aria-label="Ask"
          disabled={sending}
        />
        {error && <span className="today-err">{error}</span>}
        <button
          type="submit"
          className="today-go"
          disabled={!draft.trim() || sending}
          aria-label="Send"
        >
          ↑
        </button>
      </form>
    </div>
  )
}
