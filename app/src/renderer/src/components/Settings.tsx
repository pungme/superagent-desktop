import { useEffect, useRef, useState } from 'react'
import { useStore, ACCENTS, ICON_COLOURS, type Accent } from '../state'
import { PhoneSettings } from './PhoneSettings'
import {
  AGENT_PROVIDERS,
  PROVIDER_LABEL,
  PROVIDER_PRODUCT,
  type AgentProvider
} from '../../../shared/agent-provider'

type ProviderStatus = { installed: boolean; version: string | null; loggedIn: boolean }
type EnvStatus = Record<AgentProvider, ProviderStatus> & { loggedIn: boolean }

/** How each agent is signed in, and where to get it. */
const AGENT_COPY: Record<AgentProvider, { signIn: string; terminal: string; install: string }> = {
  claude: {
    signIn: 'Sign in with a Claude Pro/Max plan or API credits.',
    terminal: 'claude',
    install: 'curl -fsSL https://claude.ai/install.sh | bash'
  },
  codex: {
    signIn: 'Sign in with a ChatGPT Plus/Pro plan or an API key.',
    terminal: 'codex login',
    install: 'npm install -g @openai/codex'
  }
}

/**
 * One agent's connection state: installed, signed in, and what to do about it.
 *
 * Superagent needs only one of them, so this reports each independently rather
 * than as a single "is it set up" answer.
 */
function AgentCard({
  provider,
  status,
  checking,
  onRecheck
}: {
  provider: AgentProvider
  status: ProviderStatus | undefined
  checking: boolean
  onRecheck: () => void
}): React.JSX.Element {
  const copy = AGENT_COPY[provider]
  const connected = !!status?.installed && !!status?.loggedIn
  const state = checking
    ? 'checking'
    : connected
      ? 'connected'
      : status?.installed
        ? 'signed-out'
        : 'missing'
  return (
    <div className={`settings-agent ${state}`}>
      <div className="settings-agent-head">
        <span className={`settings-agent-dot ${state}`} aria-hidden />
        <strong>{PROVIDER_PRODUCT[provider]}</strong>
        <span className="settings-agent-state">
          {checking
            ? 'Checking…'
            : connected
              ? 'Connected'
              : status?.installed
                ? 'Not signed in'
                : 'Not installed'}
        </span>
      </div>
      <div className="settings-agent-detail">
        {status?.installed ? (
          <>
            Version {status.version}
            {!status.loggedIn && (
              <>
                {' · '}
                {copy.signIn}
              </>
            )}
          </>
        ) : (
          <>
            Not found on your PATH. Install it with <code>{copy.install}</code>
          </>
        )}
      </div>
      {status?.installed && !status.loggedIn && (
        <div className="settings-agent-actions">
          <button
            className="settings-agent-btn"
            onClick={() => {
              window.cove.openAgentLogin(provider)
            }}
          >
            Sign in
          </button>
          <button className="settings-agent-btn ghost" onClick={onRecheck} disabled={checking}>
            Re-check
          </button>
          <span className="settings-agent-hint">
            Opens Terminal running <code>{copy.terminal}</code>.
          </span>
        </div>
      )}
    </div>
  )
}

interface SettingsProps {
  onClose: () => void
}

type SectionId = 'general' | 'agents' | 'phone' | 'notifications' | 'advanced' | 'about'

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: '⚙︎' },
  { id: 'agents', label: 'Agents', icon: '◇' },
  { id: 'phone', label: 'Phone', icon: '📱' },
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
  const accent = useStore((s) => s.accent)
  const [iconColour, setIconColour] = useState<Accent>(
    () => (localStorage.getItem('cove.iconColour') as Accent) || 'default'
  )
  const [iconPhoto, setIconPhoto] = useState(() => !!localStorage.getItem('cove.iconPhoto'))
  const iconFileRef = useRef<HTMLInputElement>(null)

  /** A colour replaces the dark of the icon; the white square stays. */
  const chooseIconColour = async (a: Accent): Promise<void> => {
    localStorage.removeItem('cove.iconPhoto')
    localStorage.setItem('cove.iconColour', a)
    setIconPhoto(false)
    setIconColour(a)
    const { renderAppIcon } = await import('../app-icon')
    // 'default' means the shipped icon, so hand back nothing and let main
    // restore the real one rather than redrawing an imitation of it.
    const png = a === 'default' ? null : await renderAppIcon(ICON_COLOURS[a])
    await window.cove.setAppIcon?.(png)
  }

  /** The picture goes where the dark was, cropped to cover, white square on top. */
  const pickIconPhoto = async (file?: File): Promise<void> => {
    if (!file) return
    const { renderAppIcon, loadImage } = await import('../app-icon')
    try {
      const img = await loadImage(file)
      const png = await renderAppIcon(img)
      if (!png) return
      // Kept as a data URL so it survives a restart; the icon is redrawn from it
      // at launch rather than the PNG being stored, which stays smaller.
      const reader = new FileReader()
      reader.onload = () => {
        localStorage.setItem('cove.iconPhoto', String(reader.result))
        localStorage.removeItem('cove.iconColour')
        setIconPhoto(true)
      }
      reader.readAsDataURL(file)
      await window.cove.setAppIcon?.(png)
    } catch {
      // Not an image, or too large to decode — the icon simply does not change.
    }
  }
  const setAccent = useStore((s) => s.setAccent)
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
  // Which agents are connected — installed AND signed in. Fetched when the
  // Agents section is opened rather than on mount: the sign-in probe costs a
  // real (tiny) call on Claude's side, and Settings usually opens for something
  // else entirely.
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [envChecking, setEnvChecking] = useState(false)
  const provider = useStore((s) => s.provider)
  const setProvider = useStore((s) => s.setProvider)
  const checkAgents = (): void => {
    setEnvChecking(true)
    window.cove
      .envDetect()
      .then((e) => setEnv(e as EnvStatus))
      .finally(() => setEnvChecking(false))
  }
  const [version, setVersion] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const progress = useStore((s) => s.updateProgress)
  const updateError = useStore((s) => s.updateError)

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
    // Both agents' versions, so About shows what is actually on this machine.
    window.cove.envVersion().then((e) =>
      setVersion(
        AGENT_PROVIDERS.filter((p) => e[p].installed)
          .map((p) => `${PROVIDER_PRODUCT[p]} ${e[p].version}`)
          .join(' · ')
      )
    )
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
              onClick={() => {
                setSection(s.id)
                // Probe on the way in, not on mount: the sign-in check costs a
                // real (tiny) call on Claude's side, and Settings usually opens
                // for something else entirely.
                if (s.id === 'agents' && !env && !envChecking) checkAgents()
              }}
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
                title="App icon"
                desc="Recolour it, or use your own picture. Changes the Dock icon while the app runs."
              >
                <div className="accent-swatches">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      className={`accent-swatch icon-swatch ${iconColour === a && !iconPhoto ? 'active' : ''}`}
                      style={{ background: ICON_COLOURS[a], color: ICON_COLOURS[a] }}
                      onClick={() => void chooseIconColour(a)}
                      title={a === 'default' ? 'Original' : a[0].toUpperCase() + a.slice(1)}
                      aria-label={a === 'default' ? 'Original icon' : `${a} icon`}
                      aria-pressed={iconColour === a && !iconPhoto}
                    >
                      <span className="icon-swatch-dot" />
                    </button>
                  ))}
                  <button
                    className={`accent-swatch icon-swatch icon-swatch-photo ${iconPhoto ? 'active' : ''}`}
                    onClick={() => iconFileRef.current?.click()}
                    title="Use a picture"
                    aria-label="Use your own picture as the icon"
                  >
                    <span className="icon-swatch-dot" />
                  </button>
                  <input
                    ref={iconFileRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => void pickIconPhoto(e.target.files?.[0])}
                  />
                </div>
              </Row>
              <Row title="Accent" desc="The colour on your messages, and on whatever is selected.">
                <div className="accent-swatches">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      className={`accent-swatch accent-${a} ${accent === a ? 'active' : ''}`}
                      onClick={() => setAccent(a)}
                      title={a === 'default' ? 'Default' : a[0].toUpperCase() + a.slice(1)}
                      aria-label={a === 'default' ? 'Default accent' : `${a} accent`}
                      aria-pressed={accent === a}
                    />
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

          {section === 'agents' && (
            <section className="settings-section">
              <div className="settings-agents">
                {AGENT_PROVIDERS.map((p) => (
                  <AgentCard
                    key={p}
                    provider={p}
                    status={env?.[p]}
                    checking={envChecking && !env}
                    onRecheck={checkAgents}
                  />
                ))}
              </div>
              <Row
                title="Default for new chats"
                desc="Every chat keeps its own agent — this is just where new ones start. Change a single chat from the Agent pill under its composer."
              >
                <div className="mode-switch">
                  {AGENT_PROVIDERS.map((p) => (
                    <button
                      key={p}
                      className={`mode-switch-btn ${provider === p ? 'active' : ''}`}
                      onClick={() => setProvider(p)}
                    >
                      {PROVIDER_LABEL[p]}
                    </button>
                  ))}
                </div>
              </Row>
              <div className="settings-agents-foot">
                <button
                  className="settings-agent-btn ghost"
                  onClick={checkAgents}
                  disabled={envChecking}
                >
                  {envChecking ? 'Checking…' : 'Re-check both'}
                </button>
                <span className="settings-agent-hint">
                  Superagent ships no AI of its own — it runs on whichever of these you already pay
                  for. One is enough.
                </span>
              </div>
            </section>
          )}

          {section === 'notifications' && (
            <section className="settings-section">
              <Row
                title="Notify when the agent finishes"
                desc="A banner when a turn completes while you're in another app."
              >
                <Toggle checked={notifyDone} onChange={toggleNotifyDone} />
              </Row>
              <Row
                title="Notify when the agent needs you"
                desc="A banner when the agent is waiting on your input."
              >
                <Toggle checked={notifyNeedsYou} onChange={toggleNotifyNeedsYou} />
              </Row>
            </section>
          )}

          {section === 'phone' && <PhoneSettings />}

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
                <div className="settings-about-app">Superagent</div>
                <div className="settings-about-ver">
                  Version {appVersion ?? '—'}
                  <span className="settings-about-sep">·</span>
                  {version || 'no agent found'}
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
