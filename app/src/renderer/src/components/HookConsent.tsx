import { useState } from 'react'
import { useStore } from '../state'

/**
 * One-time consent banner to enable status detection.
 * Adds SuperAgent's hooks to ~/.claude/settings.json (additive, reversible).
 */
export function HookConsent(): React.JSX.Element | null {
  const hooksEnabled = useStore((s) => s.hooksEnabled)
  const setHooksEnabled = useStore((s) => s.setHooksEnabled)
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('cove.hookConsentDismissed') === '1'
  )
  const [busy, setBusy] = useState(false)

  if (hooksEnabled || dismissed) return null

  const enable = async (): Promise<void> => {
    setBusy(true)
    const res = await window.cove.hooksInstall()
    setBusy(false)
    if (res.ok) setHooksEnabled(true)
  }

  const notNow = (): void => {
    localStorage.setItem('cove.hookConsentDismissed', '1')
    setDismissed(true)
  }

  return (
    <div className="consent-banner">
      <div className="consent-text">
        <strong>Turn on status badges?</strong>
        <span>
          SuperAgent can show when Claude is working or needs you, and notify you when a background
          project finishes. This adds a small, reversible hook to your Claude Code settings.
        </span>
      </div>
      <div className="consent-actions">
        <button className="consent-secondary" onClick={notNow} disabled={busy}>
          Not now
        </button>
        <button className="consent-primary" onClick={enable} disabled={busy}>
          {busy ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  )
}
