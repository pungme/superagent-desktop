import { useEffect, useState } from 'react'
import type { ConductorState } from '../../../preload'
import { titleWithoutKey, trackerKey } from '../../../shared/conductor'

/**
 * Inside a project's Main chat: the sessions that are waiting on you, with what they ask and
 * Approve / Deny, so a worker's question reaches you where you are already writing. Nothing
 * shows while no session waits, and nothing shows in any chat that is not a Main.
 */
export function ConductorEscalations({
  workspaceId,
  chatId
}: {
  workspaceId: string
  chatId: string
}): React.JSX.Element | null {
  const [state, setState] = useState<ConductorState | null>(null)
  useEffect(() => {
    const look = (): void => void window.cove.conductorGet(workspaceId).then(setState)
    look()
    return window.cove.onConductorChanged((p) => p.workspaceId === workspaceId && look())
  }, [workspaceId])
  if (!state || state.chatId !== chatId) return null
  const asking = state.sessions.filter((s) => s.status === 'needs-you' && s.approval)
  if (!asking.length) return null
  return (
    <div className="cd-escalations" data-testid="conductor-escalations">
      {asking.map((s) => (
        <div key={s.chatId} className="cd-esc">
          <span className="cd-esc-text">
            <b>{trackerKey(s.title) ?? titleWithoutKey(s.title)}</b>{' '}
            {s.title && s.ticket != null ? `${s.title} ` : ''}
            wants to: {s.approval!.preview}
          </span>
          <span className="cd-esc-btns">
            <button
              onClick={() =>
                void window.cove.conductorAnswer(workspaceId, s.approval!.requestId, true)
              }
            >
              Approve
            </button>
            <button
              onClick={() =>
                void window.cove.conductorAnswer(workspaceId, s.approval!.requestId, false)
              }
            >
              Deny
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}
