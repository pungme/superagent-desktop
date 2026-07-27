import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { SlideOverPanel } from './SlideOverPanel'

interface SettingsProps {
  onClose: () => void
}

export function Settings({ onClose }: SettingsProps): React.JSX.Element {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const hooksEnabled = useStore((s) => s.hooksEnabled)
  const setHooksEnabled = useStore((s) => s.setHooksEnabled)
  const [devMode, setDevMode] = useState(localStorage.getItem('cove.devMode') === '1')
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    // Version-only detection — avoids the slow `claude -p` login probe.
    window.cove.envVersion().then((e) => setVersion(e.claudeVersion))
  }, [])

  const toggleHooks = async (): Promise<void> => {
    if (hooksEnabled) {
      await window.cove.hooksUninstall()
      setHooksEnabled(false)
    } else {
      const res = await window.cove.hooksInstall()
      if (res.ok) setHooksEnabled(true)
    }
  }

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
            <strong>Status badges</strong>
            <span>Show when Claude is working or needs you.</span>
          </div>
          <label className="switch">
            <input type="checkbox" checked={hooksEnabled} onChange={toggleHooks} />
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
        <span>SuperAgent · Claude Code {version ?? ''}</span>
      </div>
    </SlideOverPanel>
  )
}
