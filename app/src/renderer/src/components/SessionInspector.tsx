import { useEffect, useRef, useState } from 'react'
import { titleWithoutKey, trackerKey, type ConductorSession } from '../../../shared/conductor'
import { useStore } from '../state'

type Msg = { role: 'user' | 'agent' | 'tool'; text: string; failed?: boolean }

const STATUS: Record<ConductorSession['status'], string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  idle: 'Idle',
  closed: 'Closed'
}

/**
 * One session, inside the Conductor view (the mockup's third column): its latest messages and a
 * box to write to it directly, without leaving Main. "Open chat" goes to the whole conversation.
 */
export function SessionInspector({
  workspaceId,
  session,
  onBack,
  onOpenChat,
  onClose,
  onDetach
}: {
  workspaceId: string
  session: ConductorSession
  onBack: () => void
  onOpenChat: () => void
  onClose: () => void
  onDetach: () => void
}): React.JSX.Element {
  const [msgs, setMsgs] = useState<Msg[] | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.cove.conductorMessages(session.chatId).then((m) => alive && setMsgs(m))
    }
    load()
    const t = window.setInterval(load, 2500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [session.chatId])
  // Keep the newest message in view as they arrive.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs?.length])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    const r = await window.cove.conductorSend(session.chatId, text)
    setSending(false)
    if (r.ok) {
      setDraft('')
      setMsgs((m) => [...(m ?? []), { role: 'user', text }])
    } else setError(r.error ?? 'Not sent')
  }

  const key = trackerKey(session.title)
  return (
    <div className="cd-insp" data-testid="conductor-inspector">
      <div className="cd-insp-head">
        <button className="cd-insp-back" onClick={onBack} title="Back to the sessions">
          ‹ Sessions
        </button>
        <span className="cd-insp-acts">
          <button
            data-testid="conductor-inspector-live"
            title="The session's own chat, live, beside Main"
            onClick={() => {
              if (!useStore.getState().openBeside(workspaceId, session.chatId)) onOpenChat()
            }}
          >
            Live beside Main
          </button>
          <button onClick={onOpenChat}>Open chat</button>
          {session.status !== 'closed' && (
            <>
              <button onClick={onDetach} title="Keep the chat, but not under Main">
                Detach
              </button>
              <button onClick={onClose}>Close</button>
            </>
          )}
        </span>
      </div>
      <div className="cd-insp-title">
        {key && <b className="cd-ticket">{key}</b>}
        {session.branch && <code className="cd-branch">{session.branch}</code>}
        <span className={`cd-state ${session.status}`}>
          <i />
          {STATUS[session.status]}
        </span>
      </div>
      <h3 className="cd-insp-name">{titleWithoutKey(session.title) || 'Untitled'}</h3>
      <div className="cd-insp-body" ref={bodyRef}>
        {msgs === null ? (
          <p className="cd-hint">Loading…</p>
        ) : msgs.length === 0 ? (
          <p className="cd-hint">Nothing in this conversation yet.</p>
        ) : (
          msgs.map((m, i) =>
            m.role === 'tool' ? (
              <div key={i} className={`cd-insp-tool${m.failed ? ' failed' : ''}`}>
                {m.text}
              </div>
            ) : (
              <div key={i} className={`cd-insp-msg ${m.role}`}>
                <span className="cd-insp-who">{m.role === 'user' ? 'You / Main' : 'Session'}</span>
                <div className="cd-insp-bubble">{m.text}</div>
              </div>
            )
          )
        )}
      </div>
      <form
        className="cd-insp-send"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message this session directly…"
          data-testid="conductor-inspector-input"
        />
        <button type="submit" disabled={!draft.trim() || sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {error && <p className="cd-insp-error">{error}</p>}
    </div>
  )
}
