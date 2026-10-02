import { useEffect, useState } from 'react'
import type { MailConnectionStatus } from '../../../shared/mail'

export function MailConnection(): React.JSX.Element {
  const [status, setStatus] = useState<MailConnectionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.cove
      .mailStatus()
      .then((value) => {
        if (active) setStatus(value)
      })
      .catch(() => {
        if (active) setError('Could not check the Mail connection. Try reopening Settings.')
      })
    return () => {
      active = false
    }
  }, [])
  const change = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const next = await (status?.connected
        ? window.cove.mailDisconnect()
        : window.cove.mailConnect())
      setStatus(next)
      setError(next.error || '')
    } catch {
      setError('Could not update the Mail connection. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mail-connection">
      <div className="mail-connection-heading">
        <span className="mail-connection-icon" aria-hidden="true">
          ✉
        </span>
        <div>
          <strong>Apple Mail</strong>
          <span>{status?.connected ? 'Connected' : status ? 'Not connected' : 'Checking…'}</span>
        </div>
        <button
          className="settings-agent-btn"
          disabled={busy || !status?.supported}
          onClick={() => void change()}
        >
          {busy
            ? status?.connected
              ? 'Disconnecting…'
              : 'Connecting…'
            : status?.connected
              ? 'Disconnect'
              : 'Connect'}
        </button>
      </div>
      <p>
        Let your agent search and read messages from the accounts in Mail, and save unsent drafts
        for you to review.
      </p>
      <p className="mail-connection-note">
        Messages are read only when the agent calls a Mail tool. Requested content is shared with
        the agent you use. Superagent does not send mail.
      </p>
      {status && !status.supported && <p>Apple Mail requires macOS.</p>}
      {status?.connected && (
        <p className="mail-connection-note">
          Start a new chat to give your agent the Mail tools. Disconnecting blocks further calls in
          every chat.
        </p>
      )}
      {error && (
        <div role="alert" className="onboarding-install-error">
          {error}{' '}
          <button
            className="settings-agent-btn ghost"
            onClick={() => void window.cove.mailPermissions()}
          >
            Open Automation settings
          </button>
        </div>
      )}
    </div>
  )
}

export function ConnectionsStep({ onDone }: { onDone: () => void }): React.JSX.Element {
  return (
    <div className="onboarding">
      <div className="onboarding-card connections-card">
        <p className="onboarding-sub">Step 2 of 2 · Optional</p>
        <h1>Connect your apps</h1>
        <p className="onboarding-intro">
          Give your agent access to the apps you choose. You can connect or disconnect them later in
          Settings → Connections.
        </p>
        <MailConnection />
        <div className="onboarding-actions">
          <button className="onboarding-continue" onClick={onDone}>
            Continue to Superagent
          </button>
        </div>
        <button className="onboarding-skip" onClick={onDone}>
          Skip for now
        </button>
      </div>
    </div>
  )
}
