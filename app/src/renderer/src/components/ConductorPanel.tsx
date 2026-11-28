import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConductorState } from '../../../preload'
import { titleWithoutKey, trackerKey, type ConductorSession } from '../../../shared/conductor'
import { useStore } from '../state'
import { when } from '../lib/relative-time'
import { SessionInspector } from './SessionInspector'

/**
 * A project's Conductor: the Main chat you keep writing to, and the worker sessions it has
 * started and routes to. Here you see them, open one to read or answer it, connect a chat that
 * was not started by Main, close or let one go, and choose how Main routes (Confirm or Auto).
 * Plan: .superagent/cto-mode/plan.md.
 */
const STATUS_LABEL: Record<ConductorSession['status'], string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  idle: 'Idle',
  closed: 'Closed'
}
/** An idle session that has reported back reads as Done (green), as in the mockup. */
function look(s: ConductorSession): { cls: string; word: string } {
  if (s.status === 'idle' && s.summary) return { cls: 'done', word: 'Done' }
  return { cls: s.status, word: STATUS_LABEL[s.status] }
}

export function ConductorPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [state, setState] = useState<ConductorState | null | undefined>(undefined)
  const [allUnlinked, setAllUnlinked] = useState(false)
  const [filter, setFilter] = useState<'active' | 'needs' | 'closed'>('active')
  // The card last opened: outlined, its wire dashed orange, as the mockup has it.
  const [picked, setPicked] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  // The session shown in the inspector, inside this column; null shows the cards.
  const [inspecting, setInspecting] = useState<string | null>(null)
  // Sessions that just appeared (Main spawned them): they animate in for a moment, and a spark
  // runs down the trunk from Main to each. The first look at the list animates nothing.
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<string[]>([])
  const cardsRef = useRef<HTMLDivElement>(null)
  const [spark, setSpark] = useState<{ key: string; y: number }[]>([])
  // The curves from Main's edge to each card: where each card's middle sits in the column.
  const [wires, setWires] = useState<{ id: string; y: number; status: string }[]>([])
  const [hover, setHover] = useState<string | null>(null)
  // Where the trunk leaves Main: the middle of what is on screen, so with many sessions the
  // curves fan out from the middle of the column, as in the mockup.
  const [originY, setOriginY] = useState<number | null>(null)
  const selectChat = useStore((s) => s.selectChat)
  const activeChatId = useStore((s) => s.activeChatId[workspaceId])
  // The session whose recent conversation is shown under its row, and what it says.
  const [peeking, setPeeking] = useState<string | null>(null)
  const [peekText, setPeekText] = useState('')
  const peek = (chatId: string): void => {
    if (peeking === chatId) return setPeeking(null)
    setPeeking(chatId)
    setPeekText('…')
    void window.cove.conductorPeek(chatId).then(setPeekText)
  }

  // Inspect, from a card in Main: open that session here.
  useEffect(() => {
    const on = (e: Event): void => {
      const id = (e as CustomEvent<{ chatId: string }>).detail?.chatId
      if (id) {
        setPicked(id)
        setInspecting(id)
      }
    }
    window.addEventListener('cove:conductor-inspect', on)
    return () => window.removeEventListener('cove:conductor-inspect', on)
  }, [])

  // Only a changed answer re-renders the column (it was a new object every five seconds).
  const lastJson = useRef('')
  const load = useCallback(() => {
    void window.cove.conductorGet(workspaceId).then((next) => {
      const json = JSON.stringify(next)
      if (json === lastJson.current) return
      lastJson.current = json
      setState(next)
    })
  }, [workspaceId])
  useEffect(() => {
    load()
    const off = window.cove.onConductorChanged((p) => p.workspaceId === workspaceId && load())
    // A worker starts and stops working without any change to the list: look again now and then,
    // but not while the window is hidden.
    const t = setInterval(() => {
      if (!document.hidden) load()
    }, 5000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [workspaceId, load])

  useEffect(() => {
    if (!state) return
    const ids = state.sessions.filter((x) => x.status !== 'closed').map((x) => x.chatId)
    if (seen.current === null) {
      seen.current = new Set(ids)
      return
    }
    const added = ids.filter((id) => !seen.current!.has(id))
    for (const id of ids) seen.current.add(id)
    if (!added.length) return
    setFresh((f) => [...f, ...added])
    // Not cleared when the list is read again (it is, every few seconds): each card's moment ends
    // on its own.
    window.setTimeout(() => setFresh((f) => f.filter((id) => !added.includes(id))), 2600)
  }, [state])
  // Where each new card sits, so the spark knows how far to run.
  useLayoutEffect(() => {
    const box = cardsRef.current
    if (!box || fresh.length === 0) return setSpark([])
    setSpark(
      fresh.flatMap((id) => {
        const el = box.querySelector<HTMLElement>(`[data-chat="${id}"]`)
        return el ? [{ key: id, y: el.offsetTop + 22 }] : []
      })
    )
  }, [fresh])

  // The cards' positions, for the wires: measured when the cards change or the column resizes,
  // not on every render (it used to re-observe the column each time).
  const cardKey = state
    ? state.sessions
        .map((x) => `${x.chatId}:${x.status}:${x.summary.length}:${x.approval ? 1 : 0}`)
        .join('|') + `|${filter}|${inspecting ? 1 : 0}`
    : ''
  useLayoutEffect(() => {
    const box = cardsRef.current
    if (!box) return
    const measure = (): void => {
      const cards = [...box.querySelectorAll<HTMLElement>('[data-chat]')]
      const next = cards.map((el) => ({
        id: el.dataset.chat!,
        y: el.offsetTop + Math.min(26, el.offsetHeight / 2),
        status: el.dataset.status ?? 'idle'
      }))
      setWires((cur) =>
        cur.length === next.length &&
        cur.every((w, i) => w.id === next[i].id && w.y === next[i].y && w.status === next[i].status)
          ? cur
          : next
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [cardKey])

  useEffect(() => {
    const box = cardsRef.current
    const list = box?.parentElement
    if (!box || !list) return
    let raf = 0
    const place = (): void => {
      raf = 0
      const mid = list.scrollTop + list.clientHeight * 0.42 - box.offsetTop
      setOriginY((cur) => (cur !== null && Math.abs(cur - mid) < 6 ? cur : Math.round(mid)))
    }
    const on = (): void => {
      if (!raf) raf = requestAnimationFrame(place)
    }
    place()
    list.addEventListener('scroll', on, { passive: true })
    const ro = new ResizeObserver(on)
    ro.observe(list)
    return () => {
      list.removeEventListener('scroll', on)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [cardKey])

  if (state === undefined) return <div className="cd" />
  if (state === null)
    return (
      <div className="cd" data-testid="conductor-panel">
        <p className="cd-hint">
          One Main chat for this project. Write to it as often as you like: it starts a session for
          each piece of work, sends your follow-ups to the right one, and asks when it is not sure.
        </p>
        <button
          className="cd-start"
          data-testid="conductor-start"
          onClick={() => void window.cove.conductorEnable(workspaceId, []).then(load)}
        >
          Start Conductor
        </button>
      </div>
    )

  const rank = (x: ConductorSession): number =>
    x.status === 'needs-you' ? 0 : x.status === 'working' ? 1 : 2
  // Nothing left in Closed (the last one was reopened): back to the active ones.
  const shown =
    filter === 'closed' && !state.sessions.some((x) => x.status === 'closed') ? 'active' : filter
  const live = state.sessions
    .filter((x) =>
      shown === 'closed'
        ? x.status === 'closed'
        : x.status !== 'closed' && (shown !== 'needs' || x.status === 'needs-you')
    )
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
  const liveCount = state.sessions.filter((x) => x.status !== 'closed').length
  const closed = state.sessions.filter((s) => s.status === 'closed')
  // Opening a session keeps this panel beside it (the side panel is remembered per conversation),
  // so going Main → #101 → #102 does not mean opening the Sessions tab again each time.
  const open = (chatId: string): void => {
    selectChat(workspaceId, chatId)
    // Asked for by name, as an agent's app_open_view does: every desk opens it if it is closed.
    setTimeout(
      () =>
        window.dispatchEvent(new CustomEvent('cove:app-pane', { detail: { pane: 'sessions' } })),
      60
    )
  }

  const row = (s: ConductorSession): React.JSX.Element => (
    <div
      key={s.chatId}
      className={`cd-card ${s.status} ${s.chatId === activeChatId ? 'here' : ''}${s.chatId === picked ? ' picked' : ''}${fresh.includes(s.chatId) ? ' fresh' : ''}`}
      data-chat={s.chatId}
      data-status={s.status}
      onMouseEnter={() => setHover(s.chatId)}
      onMouseLeave={() => setHover((h) => (h === s.chatId ? null : h))}
      data-testid="conductor-session"
    >
      <button
        className="cd-card-open"
        onClick={() => {
          setPicked(s.chatId)
          setInspecting(s.chatId)
        }}
      >
        <span className="cd-top">
          {trackerKey(s.title) && <b className="cd-ticket">{trackerKey(s.title)}</b>}
          <span className="cd-title">{titleWithoutKey(s.title) || 'Untitled'}</span>
          <span className={`cd-pill ${look(s).cls}`}>
            <i />
            {look(s).word}
          </span>
        </span>
        {(s.summary || s.preview) && !s.approval && (
          <span className="cd-summary">{s.summary || s.preview}</span>
        )}
        {s.approval && (
          <span className="cd-ask" data-testid="conductor-approval">
            <span className="cd-ask-text">Wants to: {s.approval.preview}</span>
            <span className="cd-ask-btns">
              <span
                role="button"
                tabIndex={0}
                data-testid="conductor-approve"
                onClick={(e) => {
                  e.stopPropagation()
                  void window.cove.conductorAnswer(workspaceId, s.approval!.requestId, true)
                }}
              >
                Approve
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  void window.cove.conductorAnswer(workspaceId, s.approval!.requestId, false)
                }}
              >
                Deny
              </span>
            </span>
          </span>
        )}
        <span className="cd-foot">
          {s.branch && (
            <code className="cd-branch">
              <svg
                viewBox="0 0 16 16"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <circle cx="4.5" cy="3.4" r="1.4" />
                <circle cx="4.5" cy="12.6" r="1.4" />
                <circle cx="11.5" cy="5" r="1.4" />
                <path d="M4.5 4.8v6.4M11.5 6.4c0 3.2-7 2.2-7 4.8" />
              </svg>
              {s.branch}
            </code>
          )}
          {s.unmerged ? <span>{s.unmerged} unmerged</span> : null}
          <span className="cd-when">
            {s.messages != null ? `${s.messages} ${s.messages === 1 ? 'msg' : 'msgs'} · ` : ''}
            {when(s.updatedAt)}
          </span>
        </span>
        {peeking === s.chatId && <pre className="cd-peek">{peekText}</pre>}
      </button>
      <span className="cd-actions">
        {s.status === 'closed' ? (
          <button onClick={() => void window.cove.conductorReopen(workspaceId, s.chatId)}>
            Reopen
          </button>
        ) : (
          <>
            <button
              title="Show its latest messages"
              aria-expanded={peeking === s.chatId}
              onClick={() => peek(s.chatId)}
            >
              Peek
            </button>
            <button
              title="Close this session"
              onClick={() => void window.cove.conductorClose(workspaceId, s.chatId)}
            >
              Close
            </button>
            <button
              title="Keep the chat, but not under Main"
              onClick={() => void window.cove.conductorDisconnect(workspaceId, s.chatId)}
            >
              Detach
            </button>
          </>
        )}
      </span>
    </div>
  )

  return (
    <div className="cd" data-testid="conductor-panel">
      {activeChatId !== state.chatId && (
        <>
          <div className="cd-head">
            {
              <button
                className="cd-main"
                onClick={() => open(state.chatId)}
                data-testid="conductor-main"
              >
                Open Main
              </button>
            }
            {/* In Main, routing is a pill in its composer. */}
            {activeChatId !== state.chatId && (
              <label className="cd-routing" title="How Main decides where a message goes">
                Routing
                <select
                  value={state.routing}
                  data-testid="conductor-routing"
                  onChange={(e) =>
                    void window.cove.conductorSetRouting(
                      workspaceId,
                      e.target.value as 'confirm' | 'auto'
                    )
                  }
                >
                  <option value="confirm">Confirm</option>
                  <option value="auto">Auto</option>
                </select>
              </label>
            )}
          </div>
          <p className="cd-mode" data-testid="conductor-mode-hint">
            {state.routing === 'auto'
              ? 'Auto: a clear task starts a session at once; Main asks only when a message could belong to two.'
              : 'Confirm: Main talks a new task over and asks before it starts a session.'}
          </p>
        </>
      )}
      {inspecting && state.sessions.some((x) => x.chatId === inspecting) ? (
        <SessionInspector
          workspaceId={workspaceId}
          session={state.sessions.find((x) => x.chatId === inspecting)!}
          onBack={() => setInspecting(null)}
          onOpenChat={() => open(inspecting)}
          onClose={() => {
            void window.cove.conductorClose(workspaceId, inspecting)
            setInspecting(null)
          }}
          onDetach={() => {
            void window.cove.conductorDisconnect(workspaceId, inspecting)
            setInspecting(null)
          }}
        />
      ) : (
        <div className="cd-list">
          <div className="cd-listhead">
            <span
              className="cd-h2"
              data-testid={activeChatId === state.chatId ? 'conductor-main-here' : undefined}
            >
              Sessions <span className="cd-count">{liveCount}</span>
            </span>
            {state.unlinked.length > 0 && (
              <button
                className="cd-connect-btn"
                data-testid="conductor-connect-open"
                onClick={() => setConnecting((v) => !v)}
              >
                ↪ Connect session
              </button>
            )}
            <span className="cd-seg">
              {(['active', 'needs', 'closed'] as const).map((f) => (
                <button key={f} className={shown === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {f === 'active'
                    ? 'Active'
                    : f === 'needs'
                      ? 'Needs you'
                      : `Closed (${closed.length})`}
                </button>
              ))}
            </span>
          </div>
          {connecting && state.unlinked.length > 0 && (
            <div className="cd-connect-pop">
              <div className="cd-h">Chats not connected to Main</div>
              {(allUnlinked ? state.unlinked : state.unlinked.slice(0, 6)).map((c) => (
                <div key={c.chatId} className="cd-row unlinked">
                  <button className="cd-open" onClick={() => open(c.chatId)}>
                    <span className="cd-title">{c.title || 'Untitled'}</span>
                  </button>
                  <span className="cd-actions">
                    <button
                      data-testid="conductor-connect"
                      onClick={() => void window.cove.conductorConnect(workspaceId, c.chatId)}
                    >
                      Connect
                    </button>
                  </span>
                </div>
              ))}
              {!allUnlinked && state.unlinked.length > 6 && (
                <button className="cd-h cd-fold" onClick={() => setAllUnlinked(true)}>
                  ▸ Show all {state.unlinked.length}
                </button>
              )}
            </div>
          )}
          {live.length === 0 && (
            <p className="cd-hint">
              {shown === 'closed'
                ? 'No closed sessions.'
                : shown === 'needs'
                  ? 'Nothing needs you.'
                  : 'No sessions yet. Tell Main what you want done.'}
            </p>
          )}
          <div className={`cd-cards${fresh.length ? ' spawning' : ''}`} ref={cardsRef}>
            <svg className="cd-wires" aria-hidden="true">
              {wires.map((w) => {
                // From Main's edge, at the first card's height, curving into each card.
                const lo = wires[0]?.y ?? 20
                const hi = wires[wires.length - 1]?.y ?? lo
                const oy = Math.min(hi, Math.max(lo, originY ?? lo))
                const x1 = 84
                return (
                  <path
                    key={w.id}
                    className={`cd-wire ${w.status}${hover === w.id ? ' hot' : ''}${picked === w.id ? ' picked' : ''}${fresh.includes(w.id) ? ' fresh' : ''}`}
                    d={`M0 ${oy} C ${x1 * 0.55} ${oy}, ${x1 * 0.45} ${w.y}, ${x1} ${w.y}`}
                  />
                )
              })}
            </svg>
            <span
              className="cd-mainnode"
              title="Main"
              style={{
                top:
                  Math.min(
                    wires[wires.length - 1]?.y ?? 20,
                    Math.max(wires[0]?.y ?? 20, originY ?? wires[0]?.y ?? 20)
                  ) - 4
              }}
            />
            {spark.map((k) => (
              <i
                key={k.key}
                className="cd-spark"
                style={{ '--to': `${k.y}px` } as React.CSSProperties}
              />
            ))}
            {live.map(row)}
          </div>
        </div>
      )}
    </div>
  )
}
