import { useEffect, useState } from 'react'
import { useStore } from '../state'

interface SettingsProps {
  onClose: () => void
}

type SectionId = 'general' | 'notifications' | 'advanced' | 'about'

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: '⚙︎' },
  { id: 'notifications', label: 'Notifications', icon: '🔔' },
  { id: 'advanced', label: 'Advanced', icon: '🧪' },
  { id: 'about', label: 'About', icon: 'ⓘ' }
]

/** A labeled row: title + description on the left, a control on the right. */
function Row({
  title,
  desc,
  children
}: {
  title: string
  desc: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <strong>{title}</strong>
        <span>{desc}</span>
      </div>
      {children}
    </div>
  )
}

function Toggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-slider" />
    </label>
  )
}

export function Settings({ onClose }: SettingsProps): React.JSX.Element {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const permissionMode = useStore((s) => s.permissionMode)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const [section, setSection] = useState<SectionId>('general')
  const [devMode, setDevMode] = useState(localStorage.getItem('cove.devMode') === '1')
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
  const progress = useStore((s) => s.updateProgress)
  const updateError = useStore((s) => s.updateError)
  const agentProvider = useStore((s) => s.agentProvider)
  const setAgentProvider = useStore((s) => s.setAgentProvider)

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    setUpdateMsg(null)
    const r = await window.cove.updateCheck()
    setChecking(false)
    if (r.error) setUpdateMsg(r.error)
    else {
      useStore.setState({ updateError: null })
      if (r.latest && r.latest !== r.current)
        setUpdateMsg(`${r.latest} is downloading — you'll get a restart prompt when it's ready.`)
      else setUpdateMsg(`You're on the latest version.`)
    }
  }

  useEffect(() => {
    window.cove.envVersion().then((e) => setVersion(e.claudeVersion))
    window.cove.appVersion().then(setAppVersion)
  }, [])

  // Escape closes the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleDev = (v: boolean): void => {
    localStorage.setItem('cove.devMode', v ? '1' : '0')
    setDevMode(v)
  }

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <h1>Settings</h1>
        <button className="settings-done" onClick={onClose}>
          Done
        </button>
      </header>
      <div className="settings-page-body">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${section === s.id ? 'on' : ''}`}
              onClick={() => setSection(s.id)}
            >
              <span className="settings-nav-icon" aria-hidden>
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'general' && (
            <section className="settings-section">
              <Row
                title="AI Agent CLI"
                desc="Choose which AI agent CLI drives your workspace sessions."
              >
                <div className="mode-switch">
                  <button
                    className={`mode-switch-btn ${agentProvider === 'claude' ? 'active' : ''}`}
                    onClick={() => setAgentProvider('claude')}
                  >
                    Claude Code
                  </button>
                  <button
                    className={`mode-switch-btn ${agentProvider === 'antigravity' ? 'active' : ''}`}
                    onClick={() => setAgentProvider('antigravity')}
                  >
                    Antigravity (agy)
                  </button>
                </div>
              </Row>
              <Row title="Appearance" desc="Light, dark, or match your system.">
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
              </Row>
              <Row
                title="Agent permissions"
                desc={
                  permissionMode === 'bypassPermissions'
                    ? 'Full access — runs commands and edits files without asking, like your terminal.'
                    : 'Edits only — file changes go through, but commands may be refused.'
                }
              >
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
              </Row>
            </section>
          )}

          {section === 'notifications' && (
            <section className="settings-section">
              <Row
                title="Notify when Claude finishes"
                desc="A banner when a turn completes while you're in another app."
              >
                <Toggle checked={notifyDone} onChange={toggleNotifyDone} />
              </Row>
              <Row
                title="Notify when Claude needs you"
                desc="A banner when the agent is waiting on your input."
              >
                <Toggle checked={notifyNeedsYou} onChange={toggleNotifyNeedsYou} />
              </Row>
            </section>
          )}

          {section === 'advanced' && (
            <section className="settings-section">
              <Row title="Developer mode" desc="Show DevTools and verbose details.">
                <Toggle checked={devMode} onChange={toggleDev} />
              </Row>
            </section>
          )}

          {section === 'about' && (
            <section className="settings-section">
              <div className="settings-about">
                <div className="settings-about-app">SuperAgent</div>
                <div className="settings-about-ver">
                  Version {appVersion ?? '—'}
                  <span className="settings-about-sep">·</span>
                  Claude Code {version ?? '—'}
                </div>
                <div className="settings-about-update">
                  <button
                    className="settings-update-check"
                    onClick={checkUpdates}
                    disabled={checking || !!progress}
                  >
                    {progress ? 'Downloading…' : checking ? 'Checking…' : 'Check for updates'}
                  </button>
                  {progress ? (
                    <span className="settings-update-msg">
                      Downloading {progress.version ?? 'update'} — {Math.round(progress.percent)}%
                    </span>
                  ) : updateError ? (
                    <span className="settings-update-msg">Update failed: {updateError}</span>
                  ) : (
                    updateMsg && <span className="settings-update-msg">{updateMsg}</span>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
