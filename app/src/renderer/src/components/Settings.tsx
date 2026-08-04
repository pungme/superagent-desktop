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
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    // Version-only detection — avoids the slow `claude -p` login probe.
    window.cove.envVersion().then((e) => setVersion(e.claudeVersion))
  }, [])

  const toggleDev = (v: boolean): void => {
    localStorage.setItem('cove.devMode', v ? '1' : '0')
    setDevMode(v)
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
        <span>SuperAgent · Claude Code {version ?? ''}</span>
      </div>
    </SlideOverPanel>
  )
}
