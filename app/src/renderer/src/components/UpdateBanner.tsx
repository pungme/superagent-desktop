import { useEffect, useState } from 'react'
import { useStore } from '../state'

/**
 * Shown once a newer release has finished downloading in the background
 * (`update:ready` from the main-process auto-updater). Offers an immediate
 * restart-into-the-update; dismissing just hides the bar — the update still
 * installs on the next quit (autoInstallOnAppQuit).
 *
 * Installing quits the app, and quitting kills every agent, so a restart taken
 * mid-turn silently throws away whatever Claude was doing (and any command it
 * left running in the background). When something is in flight we ask first —
 * a confirmation rather than a disabled button, so a wedged agent can't hold the
 * update hostage. Either way the update still lands on the next quit.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const busy = useStore((s) => s.busy)

  useEffect(() => {
    return window.cove.onUpdateReady((v) => {
      setVersion(v)
      setDismissed(false)
      setConfirming(false)
    })
  }, [])

  if (!version || dismissed) return null

  const entries = Object.values(busy)
  const workingChats = entries.filter((b) => b.generating).length
  const backgroundTasks = entries.reduce((n, b) => n + b.background, 0)
  const inFlight = workingChats > 0 || backgroundTasks > 0

  const install = (): void => window.cove.installUpdate()
  const onRestart = (): void => {
    if (inFlight) setConfirming(true)
    else install()
  }

  // "2 chats and 1 background task" — only naming what's actually running.
  const parts: string[] = []
  if (workingChats > 0) {
    parts.push(`Claude is still working in ${workingChats} ${workingChats === 1 ? 'chat' : 'chats'}`)
  }
  if (backgroundTasks > 0) {
    parts.push(
      `${backgroundTasks} background ${backgroundTasks === 1 ? 'task is' : 'tasks are'} running`
    )
  }

  if (confirming) {
    return (
      <div className="update-banner update-banner-warn" role="alertdialog">
        <span className="update-banner-dot update-banner-dot-warn" />
        <span className="update-banner-text">
          {parts.join(' and ')}. Restarting stops {workingChats + backgroundTasks === 1 ? 'it' : 'them'}.
        </span>
        <button className="update-banner-action" onClick={install}>
          Restart anyway
        </button>
        <button className="update-banner-secondary" onClick={() => setConfirming(false)}>
          Keep working
        </button>
      </div>
    )
  }

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" />
      <span className="update-banner-text">
        SuperAgent <b>{version}</b> is ready to install.
      </span>
      <button className="update-banner-action" onClick={onRestart}>
        Restart to update
      </button>
      <button
        className="update-banner-close"
        onClick={() => setDismissed(true)}
        title="Later (installs on next quit)"
      >
        ×
      </button>
    </div>
  )
}
