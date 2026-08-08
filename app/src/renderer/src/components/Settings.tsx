import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { SlideOverPanel } from './SlideOverPanel'

interface SettingsProps {
  onClose: () => void
}

export function Settings({ onClose }: SettingsProps): React.JSX.Element {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const permissionMode = useStore((s) => s.permissionMode)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const [devMode, setDevMode] = useState(localStorage.getItem('cove.devMode') === '1')
  const [deskArt, setDeskArt] = useState(localStorage.getItem('cove.deskArt') !== '0')
  // Banners pop over whatever you're doing — both kinds are optional.
  const [notifyDone, setNotifyDone] = useState(localStorage.getItem('cove.notifyDone') !== '0')
  const [notifyNeedsYou, setNotifyNeedsYou] = useState(
    localStorage.getItem('cove.notifyNeedsYou') !== '0'
  )
  const toggleNotifyDone = (v: boolean): void => {
    localStorage.setItem('cove.notifyDone', v ? '1' : '0')
    setNotifyDone(v)
    window.cove.setNotifyPrefs({ done: v })
  }
  const toggleNotifyNeedsYou = (v: boolean): void => {
    localStorage.setItem('cove.notifyNeedsYou', v ? '1' : '0')
    setNotifyNeedsYou(v)
    window.cove.setNotifyPrefs({ needsYou: v })
  }
  const [version, setVersion] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  // Store-backed, so reopening Settings mid-download still shows the truth.
  const progress = useStore((s) => s.updateProgress)
  const updateError = useStore((s) => s.updateError)

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    setUpdateMsg(null)
    const r = await window.cove.updateCheck()
    setChecking(false)
    if (r.error) setUpdateMsg(`Couldn't check: ${r.error}`)
    else if (r.latest && r.latest !== r.current)
      setUpdateMsg(`${r.latest} is downloading — you'll get a restart prompt when it's ready.`)
    else setUpdateMsg(`You're on the latest version.`)
  }

  useEffect(() => {
    // Version-only detection — avoids the slow `claude -p` login probe.
    window.cove.envVersion().then((e) => setVersion(e.claudeVersion))
    window.cove.appVersion().then(setAppVersion)
  }, [])

  const toggleDev = (v: boolean): void => {
    localStorage.setItem('cove.devMode', v ? '1' : '0')
    setDevMode(v)
  }

  // The desk's painting. On by default, off for anyone who'd rather their work
  // sat on plain grey — applied to <html> so it needs no re-render anywhere.
  const toggleDesk = (v: boolean): void => {
    localStorage.setItem('cove.deskArt', v ? '1' : '0')
    setDeskArt(v)
    document.documentElement.classList.toggle('no-desk-art', !v)
  }

  return (
    <SlideOverPanel title="Settings" onClose={onClose} variant="center">
      <div className="settings-body">
        <div className="settings-row">
          <div className="settings-label">
            <strong>Appearance</strong>
            <span>Light, dark, or match your system.</span>
          </div>
          <div className="mode-switch">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button
                key={t}
                className={`mode-switch-btn ${theme === t ? 'active' : ''}`}
                onClick={() => setTheme(t)}
              >
                {t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Auto'}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <strong>Agent permissions</strong>
            <span>
              {permissionMode === 'bypassPermissions'
                ? 'Full access — runs commands and edits files without asking, like your terminal.'
                : 'Edits only — file changes go through, but commands may be refused.'}
            </span>
          </div>
          <div className="mode-switch">
            <button
              className={`mode-switch-btn ${permissionMode === 'bypassPermissions' ? 'active' : ''}`}
              onClick={() => setPermissionMode('bypassPermissions')}
            >
              Full
            </button>
            <button
              className={`mode-switch-btn ${permissionMode === 'acceptEdits' ? 'active' : ''}`}
              onClick={() => setPermissionMode('acceptEdits')}
            >
              Edits
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <strong>Notify when Claude finishes</strong>
            <span>A banner when a turn completes while you're in another app.</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={notifyDone}
              onChange={(e) => toggleNotifyDone(e.target.checked)}
            />
            <span className="switch-slider" />
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <strong>Notify when Claude needs you</strong>
            <span>A banner when the agent is waiting on your input.</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={notifyNeedsYou}
              onChange={(e) => toggleNotifyNeedsYou(e.target.checked)}
            />
            <span className="switch-slider" />
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <strong>Painting behind your work</strong>
            <span>Monet’s Water Lilies as the surface panes sit on. Off is plain grey.</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={deskArt}
              onChange={(e) => toggleDesk(e.target.checked)}
            />
            <span className="switch-slider" />
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <strong>Developer mode</strong>
            <span>Show DevTools and verbose details.</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={devMode}
              onChange={(e) => toggleDev(e.target.checked)}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>
      <div className="settings-footer">
        <span>
          SuperAgent {appVersion ?? ''} · Claude Code {version ?? ''}
          {progress ? (
            <span className="settings-update-msg">
              {' '}
              · Downloading {progress.version ?? 'update'} — {Math.round(progress.percent)}%
            </span>
          ) : updateError ? (
            <span className="settings-update-msg"> · Update failed: {updateError}</span>
          ) : (
            updateMsg && <span className="settings-update-msg"> · {updateMsg}</span>
          )}
        </span>
        <button
          className="settings-update-check"
          onClick={checkUpdates}
          // Locked while a download runs — pressing it again mid-download can only
          // confuse the updater. A failure clears the lock: the button IS the retry.
          disabled={checking || !!progress}
        >
          {progress ? 'Downloading…' : checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </SlideOverPanel>
  )
}
