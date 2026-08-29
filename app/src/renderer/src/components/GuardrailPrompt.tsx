import { useEffect, useState } from 'react'
import type { GuardrailAsk } from '../../../preload'

/**
 * The prompt-injection gate's face. When the agent reads a web page and then
 * tries to run a command or change a file that same turn, the main process holds
 * the tool and asks here. One prompt at a time; the rest queue behind it.
 *
 * The preview is rendered as plain text in a <pre> — it may contain the very
 * string a hostile page tried to plant, so it must never be interpreted as markup.
 */
export function GuardrailPrompt(): React.JSX.Element | null {
  const [queue, setQueue] = useState<GuardrailAsk[]>([])

  useEffect(() => {
    const offAsk = window.cove.onGuardrailAsk((a) =>
      setQueue((q) => (q.some((x) => x.requestId === a.requestId) ? q : [...q, a]))
    )
    // Someone/something else settled it (e.g. the main-side timeout) — drop it.
    const offRes = window.cove.onGuardrailResolved((requestId) =>
      setQueue((q) => q.filter((a) => a.requestId !== requestId))
    )
    return () => {
      offAsk?.()
      offRes?.()
    }
  }, [])

  const current = queue[0]

  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent): void => {
      // Escape is the safe default: deny.
      if (e.key === 'Escape') {
        window.cove.guardrailResolve(current.requestId, false, false)
        setQueue((q) => q.filter((a) => a.requestId !== current.requestId))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current])

  if (!current) return null

  const answer = (approve: boolean, trustRest: boolean): void => {
    window.cove.guardrailResolve(current.requestId, approve, trustRest)
    setQueue((q) => q.filter((a) => a.requestId !== current.requestId))
  }

  const isShell = current.toolName === 'Bash'
  const isPermission = current.kind === 'permission'

  return (
    <div className="guard-backdrop">
      <div className="guard-modal" role="alertdialog" aria-modal="true">
        <div className="guard-head">
          <span className="guard-shield" aria-hidden>
            🛡️
          </span>
          <strong>
            {isPermission ? `Claude wants to use ${current.toolName}` : 'Approve this action?'}
          </strong>
        </div>
        <p className="guard-why">
          {isPermission
            ? 'This chat is in Ask mode, so the agent checks with you before it acts. You can also answer this from your phone.'
            : `This turn read a web page, and a page can hide instructions meant to steer the agent. Superagent paused before it ${isShell ? 'runs a command' : 'changes a file'} so you can check it’s what you intended.`}
        </p>
        <pre className="guard-preview">{current.preview}</pre>
        <div className="guard-actions">
          <button className="guard-deny" onClick={() => answer(false, false)}>
            Deny
          </button>
          <div className="guard-spacer" />
          <button className="guard-once" onClick={() => answer(true, false)}>
            Approve once
          </button>
          <button className="guard-trust" onClick={() => answer(true, true)}>
            Approve rest of turn
          </button>
        </div>
      </div>
    </div>
  )
}
