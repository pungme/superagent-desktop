import { useCallback, useEffect, useState } from 'react'
import type { ConductorState } from '../../../preload'
import { ticketLabel, type ConductorSession } from '../../../shared/conductor'
import { useStore } from '../state'

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

export function ConductorPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [state, setState] = useState<ConductorState | null | undefined>(undefined)
  const [showClosed, setShowClosed] = useState(false)
  const selectChat = useStore((s) => s.selectChat)

  const load = useCallback(() => {
    void window.cove.conductorGet(workspaceId).then(setState)
  }, [workspaceId])
  useEffect(() => {
    load()
    const off = window.cove.onConductorChanged((p) => p.workspaceId === workspaceId && load())
    // A worker starts and stops working without any change to the list: look again now and then.
    const t = setInterval(load, 5000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [workspaceId, load])

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

  const live = state.sessions.filter((s) => s.status !== 'closed')
  const closed = state.sessions.filter((s) => s.status === 'closed')
  const open = (chatId: string): void => selectChat(workspaceId, chatId)

  const row = (s: ConductorSession): React.JSX.Element => (
    <div key={s.chatId} className={`cd-row ${s.status}`} data-testid="conductor-session">
      <button className="cd-open" onClick={() => open(s.chatId)}>
        <span className="cd-top">
          {s.ticket != null && <b className="cd-ticket">{ticketLabel(s.ticket)}</b>}
          <span className="cd-title">{s.title || 'Untitled'}</span>
          <span className={`cd-state ${s.status}`}>
            <i />
            {STATUS_LABEL[s.status]}
          </span>
        </span>
        {(s.summary || s.branch) && (
          <span className="cd-sub">
            {s.branch ? `${s.branch}${s.unmerged ? ` · ${s.unmerged} unmerged` : ''}` : ''}
            {s.branch && s.summary ? ' · ' : ''}
            {s.summary}
          </span>
        )}
      </button>
      <span className="cd-actions">
        {s.status === 'closed' ? (
          <button onClick={() => void window.cove.conductorReopen(workspaceId, s.chatId)}>
            Reopen
          </button>
        ) : (
          <>
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
      <div className="cd-head">
        <button className="cd-main" onClick={() => open(state.chatId)} data-testid="conductor-main">
          Open Main
        </button>
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
      </div>
      <div className="cd-list">
        {live.length === 0 && (
          <p className="cd-hint">No sessions yet. Tell Main what you want done.</p>
        )}
        {live.map(row)}
        {state.unlinked.length > 0 && (
          <>
            <div className="cd-h">Not connected to Main</div>
            {state.unlinked.map((c) => (
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
          </>
        )}
        {closed.length > 0 && (
          <>
            <button className="cd-h cd-fold" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? '▾' : '▸'} Closed ({closed.length})
            </button>
            {showClosed && closed.map(row)}
          </>
        )}
      </div>
    </div>
  )
}
