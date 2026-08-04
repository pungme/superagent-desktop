import { useEffect, useState } from 'react'

/**
 * Shown once a newer release has finished downloading in the background
 * (`update:ready` from the main-process auto-updater). Offers an immediate
 * restart-into-the-update; dismissing just hides the bar — the update still
 * installs on the next quit (autoInstallOnAppQuit).
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    return window.cove.onUpdateReady((v) => {
      setVersion(v)
      setDismissed(false)
    })
  }, [])

  if (!version || dismissed) return null

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" />
      <span className="update-banner-text">
        SuperAgent <b>{version}</b> is ready to install.
      </span>
      <button className="update-banner-action" onClick={() => window.cove.installUpdate()}>
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
