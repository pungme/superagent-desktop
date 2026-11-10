import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FloatCommand, FloatState } from '../../../shared/float-chat'
import { ProviderLogo } from '../components/ProviderLogo'
import './float.css'

/**
 * Browser first: the chat floating over the page (main/float-chat.ts says why
 * it is a view of its own). Three ways to be:
 *
 *  - the mark: Superagent's icon with the agent's badge and ⌘\ under it; hovered,
 *    "Ask Superagent ⌘\" unrolls beside it. While it works a glow breathes round
 *    it with one line of what it is doing; an answer peeks out for a few seconds
 *    and leaves a blue dot.
 *  - open: the message box, with the conversation stacked above it, older
 *    messages fading. Stays until put away (⌄, ⌘\ or Esc).
 *  - the whole chat: a panel down the right of the page (⤢ or ⌘⇧\).
 *
 * The view is only as large as what it shows (a view takes every click in its
 * rectangle): it grows before an opening animation and shrinks after a closing one.
 */

type View = 'mark' | 'open' | 'full'

/** The room each state needs (the view's size; main keeps it inside the page). */
const ROOM = {
  mark: { w: 96, h: 108 },
  hover: { w: 330, h: 108 },
  busy: { w: 440, h: 108 },
  peek: { w: 500, h: 190 },
  full: { w: 440, h: 4000 },
  openW: 512
}
/** How long a closing animation runs before the view shrinks. */
const CLOSE_MS = 420
const PEEK_MS = 5000

function SaMark({
  provider,
  size
}: {
  provider: FloatState['provider']
  size: number
}): React.JSX.Element {
  return (
    <span className="fl-sa" style={{ width: size, height: size, borderRadius: size * 0.3 }}>
      <span className="fl-ag">
        <ProviderLogo provider={provider} size={Math.round(size * 0.3)} />
      </span>
    </span>
  )
}

export function FloatChat(): React.JSX.Element {
  const [st, setSt] = useState<FloatState | null>(null)
  const [view, setView] = useState<View>('mark')
  const [hover, setHover] = useState(false)
  const [peek, setPeek] = useState<string | null>(null)
  const [unread, setUnread] = useState(false)
  const [draft, setDraft] = useState('')
  const [panelH, setPanelH] = useState(140)
  const inputRef = useRef<HTMLInputElement>(null)
  const fullInputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const fullLogRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  useLayoutEffect(() => {
    viewRef.current = view
  }, [view])

  useEffect(() => window.cove.onFloatState(setSt), [])

  // An answer while only the mark shows: it peeks out, and leaves a dot.
  const lastAnswer = useRef<string | null>(null)
  const wasWorking = useRef(false)
  useEffect(() => {
    if (!st) return
    const answer = [...st.messages].reverse().find((m) => !m.me)
    if (wasWorking.current && !st.working && answer && answer.id !== lastAnswer.current) {
      if (viewRef.current === 'mark') {
        setPeek(answer.text)
        setUnread(true)
      }
    }
    if (answer) lastAnswer.current = answer.id
    wasWorking.current = st.working
  }, [st])
  useEffect(() => {
    if (!peek) return
    const t = setTimeout(() => setPeek(null), PEEK_MS)
    return () => clearTimeout(t)
  }, [peek])

  // The view's size follows what is on screen: at once when growing, after the
  // animation when shrinking.
  const needsYou = !!st?.needsYou && view === 'mark'
  const want =
    view === 'full'
      ? ROOM.full
      : view === 'open'
        ? { w: ROOM.openW, h: panelH + 56 }
        : peek || needsYou
          ? ROOM.peek
          : st?.working
            ? ROOM.busy
            : hover && !st?.working
              ? ROOM.hover
              : ROOM.mark
  const sent = useRef({ w: 0, h: 0 })
  useEffect(() => {
    const grow = want.w >= sent.current.w && want.h >= sent.current.h
    const apply = (): void => {
      sent.current = want
      window.cove.floatSize(want)
    }
    if (grow) {
      apply()
      return
    }
    const t = setTimeout(apply, CLOSE_MS)
    return () => clearTimeout(t)
  }, [want.w, want.h]) // eslint-disable-line react-hooks/exhaustive-deps

  // The open panel's height, so the view is no taller than it.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setPanelH(Math.ceil(el.getBoundingClientRect().height)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!st]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((to: View = 'open'): void => {
    const show = (): void => {
      setView(to)
      setPeek(null)
      setUnread(false)
      setHover(false)
      setTimeout(() => (to === 'full' ? fullInputRef : inputRef).current?.focus(), 60)
    }
    if (to === 'full' && viewRef.current !== 'full') {
      // The view is made as tall as the page first, and the panel slides in once
      // it is: slid in at once, its first moments were cut off by the view's
      // old, small size.
      sent.current = ROOM.full
      window.cove.floatSize(ROOM.full)
      setTimeout(show, 50)
    } else show()
  }, [])
  const close = useCallback((): void => {
    setView('mark')
    window.cove.floatAction({ type: 'focus-app' })
  }, [])
  const side = (): void => {
    setView('mark')
    window.cove.floatAction({ type: 'side' })
  }

  useEffect(
    () =>
      window.cove.onFloatCommand((cmd: FloatCommand) => {
        if (cmd === 'close') close()
        else if (cmd === 'full') viewRef.current === 'full' ? open('open') : open('full')
        else if (viewRef.current === 'mark') open('open')
        else close()
      }),
    [open, close]
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && viewRef.current !== 'mark') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // The newest message in view, as it arrives.
  const count = st?.messages.length ?? 0
  const lastText = st?.messages[count - 1]?.text
  useEffect(() => {
    for (const el of [logRef.current, fullLogRef.current]) if (el) el.scrollTop = el.scrollHeight
  }, [count, lastText, st?.working, view])

  const send = (text: string): void => {
    const t = text.trim()
    if (!t || !st) return
    window.cove.floatAction({ type: 'send', chatId: st.chatId, text: t })
    setDraft('')
  }

  if (!st) return <div className="fl-root" />
  const msgs = st.messages
  const n = msgs.length
  const status = st.status || 'Working'
  const list = (ref: React.RefObject<HTMLDivElement | null>, fade: boolean): React.JSX.Element => (
    <div className="fl-log" ref={ref}>
      {msgs.map((m, i) => {
        const age = n - 1 - i
        const opacity = !fade || age < 3 ? 1 : Math.max(0.3, 1 - (age - 2) * 0.17)
        return (
          <div key={m.id} className={`fl-m ${m.me ? 'me' : 'ai'}`} style={{ opacity }}>
            {m.text}
          </div>
        )
      })}
      {st.working && (
        <div className="fl-work">
          <span className="fl-spin" />
          <span className="fl-shim">{status}</span>
        </div>
      )}
    </div>
  )

  return (
    <div className={`fl-root view-${view}`}>
      {/* The mark */}
      <div
        className={`fl-mark ${view !== 'mark' ? 'gone' : ''} ${st.working ? 'working' : ''} ${unread ? 'unread' : ''} ${hover ? 'hover' : ''}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => open('open')}
        role="button"
        aria-label="Ask Superagent (⌘\)"
      >
        <span className="fl-lbl">
          Ask Superagent
          <span className="fl-keys">
            <b>⌘</b>
            <b>\</b>
          </span>
        </span>
        <span className="fl-ringwrap">
          <SaMark provider={st.provider} size={44} />
          <span className="fl-ring" />
          <span className="fl-badge" />
        </span>
        <span className="fl-hint">⌘ \</span>
      </div>
      <div className={`fl-live ${view === 'mark' && st.working && !peek ? '' : 'gone'}`}>
        <span className="fl-spin" />
        <span>{status}</span>
      </div>
      <div
        className={`fl-peek ${view === 'mark' && (peek || needsYou) ? '' : 'gone'}`}
        onClick={() => (needsYou ? side() : open('open'))}
      >
        {needsYou ? (
          <>
            <div>
              <b>{st.agent}</b> is asking you something.
            </div>
            <small>
              <span>Answer in the chat</span>
              <span>⌘⇧B</span>
            </small>
          </>
        ) : (
          <>
            <div className="fl-peek-text">{peek}</div>
            <small>
              <span>Click to reply</span>
              <span>⌘ \</span>
            </small>
            <div className="fl-bar">
              <i key={peek ?? ''} />
            </div>
          </>
        )}
      </div>

      {/* Open: the conversation stacked over the box */}
      <div className={`fl-panel ${view === 'open' ? '' : 'shut'}`} ref={panelRef}>
        <div className="fl-stack">{list(logRef, true)}</div>
        {st.needsYou && (
          <button className="fl-ask" onClick={side}>
            {st.agent} is asking you something. <u>Answer in the chat</u>
          </button>
        )}
        <div className="fl-box">
          <SaMark provider={st.provider} size={26} />
          <input
            ref={inputRef}
            value={draft}
            placeholder="Ask Superagent…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send(draft)
              }
            }}
          />
          <span className="fl-esc" title="Make it small again">
            esc
          </span>
          <button className="fl-xp" title="Make it small again (⌘\ or Esc)" onClick={close}>
            <svg viewBox="0 0 16 16">
              <path d="M4 6.5 8 10.5l4-4" />
            </svg>
          </button>
          <button className="fl-xp" title="Show the whole chat (⌘⇧\)" onClick={() => open('full')}>
            <svg viewBox="0 0 16 16">
              <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
            </svg>
          </button>
          <button
            className={`fl-go ${draft.trim() ? 'ready' : ''}`}
            aria-label="Send"
            onClick={() => send(draft)}
          >
            ↑
          </button>
        </div>
      </div>

      {/* The whole chat */}
      <div className={`fl-drawer ${view === 'full' ? '' : 'gone'}`}>
        <div className="fl-dhd">
          <SaMark provider={st.provider} size={22} />
          <span className="fl-dtitle">{st.agent}</span>
          <span className="fl-sp" />
          <button className="fl-hbtn" onClick={side} title="Put the chat beside the page (⌘⇧B)">
            Put beside the page
          </button>
          <button className="fl-hbtn" onClick={() => open('open')}>
            Hide
          </button>
        </div>
        <div className="fl-dbody">{list(fullLogRef, false)}</div>
        <div className="fl-dcomp">
          <input
            ref={fullInputRef}
            value={draft}
            placeholder="Ask Superagent…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send(draft)
              }
            }}
          />
          <button
            className={`fl-go ${draft.trim() ? 'ready' : ''}`}
            aria-label="Send"
            onClick={() => send(draft)}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
