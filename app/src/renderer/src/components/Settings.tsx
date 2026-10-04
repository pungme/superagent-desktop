import { MailConnection } from './MailConnection'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Account } from '../../../preload'
import { useStore, ACCENTS, ICON_COLOURS, type Accent } from '../state'
import { PhoneSettings } from './PhoneSettings'
import { REPLAY_INTRO_EVENT } from '../firstRun'
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
  },
  antigravity: {
    signIn: 'Sign in with your Google account.',
    terminal: 'agy',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  }
}

interface SettingsProps {
  initialSection?: 'general' | 'connections'
  onClose: () => void
}

type SectionId = 'general' | 'agents' | 'connections' | 'phone' | 'advanced' | 'about'

/** Each section: its name in the list, and the line under its heading. */
const SECTIONS: { id: SectionId; label: string; blurb: string }[] = [
  { id: 'general', label: 'General', blurb: 'How Superagent looks, and when it notifies you.' },
  {
    id: 'agents',
    label: 'Agents',
    blurb: 'The coding agents on this Mac, the accounts they run on, and how new chats start.'
  },
  { id: 'connections', label: 'Connections', blurb: 'The apps your agents can reach.' },
  { id: 'phone', label: 'Phone', blurb: 'Follow this Mac from your iPhone.' },
  { id: 'advanced', label: 'Advanced', blurb: 'Storage, developer tools, and starting over.' },
  { id: 'about', label: 'About', blurb: 'This version, and updates.' }
]

/**
 * The section list's icons: one family, drawn as lines in the text colour. They
 * were a mix of emoji and symbol characters, which came out in three sizes and
 * two styles, and the emoji ignored the theme.
 */
const NAV_ICONS: Record<SectionId, React.JSX.Element> = {
  general: (
    <>
      <path d="M3 5h6M13 5h4M3 10h2M9 10h8M3 15h8M15 15h2" />
      <circle cx="11" cy="5" r="2" />
      <circle cx="7" cy="10" r="2" />
      <circle cx="13" cy="15" r="2" />
    </>
  ),
  connections: (
    <>
      <path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L10 5" />
      <path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1" />
    </>
  ),
  agents: (
    <>
      <path d="M10 2.5l1.7 4.3 4.3 1.7-4.3 1.7L10 14.5l-1.7-4.3L4 8.5l4.3-1.7z" />
      <path d="M15.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  phone: (
    <>
      <rect x="6" y="2.5" width="8" height="15" rx="2" />
      <path d="M9 15h2" />
    </>
  ),
  advanced: (
    <>
      <path d="M12.5 3.5a4 4 0 0 0-4.6 5.3L3 13.7 6.3 17l4.9-4.9a4 4 0 0 0 5.3-4.6l-2.6 2.6-2.4-.6-.6-2.4z" />
    </>
  ),
  about: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v5M10 6.2v.1" />
    </>
  )
}

function NavIcon({ id }: { id: SectionId }): React.JSX.Element {
  return (
    <svg
      className="settings-nav-icon"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {NAV_ICONS[id]}
    </svg>
  )
}

/** The small label above a group of settings. */
function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="settings-group-label">{children}</div>
}

/** When a usage window starts over: "6 PM" today, else "Mon 10 PM". */
function resetLabel(at: number, now: number): string {
  // To the nearest minute: a window reported as ending at 15:59:59.9 ends at 4.
  const d = new Date(Math.round(at / 60_000) * 60_000)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return at - now < 20 * 3_600_000
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** "just now", "12 min ago", "3 h ago": how old the numbers are. */
function ago(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/**
 * How much of an account's allowance is used, one meter per window — the same
 * numbers `/usage` shows, read from the CLI (main/usage.ts). A window that has
 * started over since it was read is shown empty rather than as it was.
 */
function AccountUsage({ usage }: { usage: NonNullable<Account['usage']> }): React.JSX.Element {
  // The moment the numbers were drawn: new numbers draw them again.
  const [now] = useState(() => Date.now())
  return (
    <span className="settings-account-usage" title={`Updated ${ago(usage.at, now)}`}>
      {usage.windows.map((w) => {
        const over = w.resetsAt !== null && w.resetsAt <= now
        const pct = over ? 0 : w.percent
        return (
          <span
            key={w.label}
            className={`settings-usage-window ${pct >= 90 ? 'high' : pct >= 75 ? 'warn' : ''}`}
          >
            <span className="settings-usage-label">{w.label}</span>
            <span className="settings-usage-bar">
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="settings-usage-pct">{pct}%</span>
            {w.resetsAt && !over && (
              <span className="settings-usage-reset">resets {resetLabel(w.resetsAt, now)}</span>
            )}
          </span>
        )
      })}
    </span>
  )
}

/** A labeled row: title + description on the left, a control on the right. */
/**
 * More than one subscription per agent. The CLI's own login is always there;
 * extra Claude accounts are tokens from `claude setup-token`, extra Codex
 * accounts sign in through the browser into their own home. (Antigravity has
 * the one login only.) When the account
 * a chat is on runs dry, the chat asks to switch — or just does, in auto.
 */
function AgentsPanel({
  env,
  envChecking,
  onRecheck
}: {
  env: Record<AgentProvider, ProviderStatus> | null
  envChecking: boolean
  onRecheck: () => void
}): React.JSX.Element {
  const [list, setListState] = useState<{
    claude: Account[]
    codex: Account[]
    antigravity: Account[]
    mode: 'ask' | 'auto'
  } | null>(null)
  // When the list was read: what "today" means for the reset times beside it.
  const [readAt, setReadAt] = useState(0)
  const setList = useCallback((l: NonNullable<typeof list>): void => {
    setListState(l)
    setReadAt(Date.now())
  }, [])
  const [adding, setAdding] = useState<AgentProvider | null>(null)
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const refresh = (recheck = false): Promise<void> => {
    if (recheck) setChecking(true)
    return window.cove
      .accountsList(recheck)
      .then(setList)
      .finally(() => setChecking(false))
  }
  useEffect(() => {
    void window.cove.accountsList().then(setList)
    // How much of each allowance is used: asked for on opening, and kept
    // current by every chat that runs (accounts:changed).
    void window.cove.accountsRefreshUsage().then(() => window.cove.accountsList().then(setList))
    return window.cove.onAccountsChanged?.(() => void window.cove.accountsList().then(setList))
  }, [setList])
  const fixHint = (a: Account): string =>
    a.kind === 'login'
      ? a.provider === 'claude'
        ? 'Sign in again with `claude auth login` in Terminal.'
        : a.provider === 'antigravity'
          ? 'Sign in again by running `agy` in Terminal.'
          : 'Sign in again with `codex login` in Terminal.'
      : a.kind === 'token'
        ? 'Make a new token with `claude setup-token` and add it again.'
        : 'Remove it and add it again to sign in afresh.'
  // With the day when it is not today: a weekly limit said "out until 10:00
  // PM" beside a 5-hour window at 6%, and read as a contradiction. It was
  // Monday's 10 PM.
  const timeLeft = (until: number | null): string =>
    until ? `out until ${resetLabel(until, readAt)}` : ''
  const startAdd = (p: AgentProvider): void => {
    setAdding(p)
    setName('')
    setToken('')
    setError(null)
  }
  const add = async (): Promise<void> => {
    if (!adding) return
    setError(null)
    try {
      if (adding === 'claude') {
        await window.cove.accountsAddClaude(name, token)
      } else {
        setBusy('Finish signing in in your browser…')
        await window.cove.accountsAddCodex(name)
      }
      setAdding(null)
      await refresh()
    } catch (e) {
      setError(
        String((e as Error)?.message ?? e).replace(
          /^Error invoking remote method '[^']*': (Error: )?/,
          ''
        )
      )
    } finally {
      setBusy(null)
    }
  }
  const remove = async (id: string): Promise<void> => {
    await window.cove.accountsRemove(id)
    await refresh()
  }
  /** Both questions at once: is each agent installed and signed in, and as whom. */
  const recheckAll = (): void => {
    onRecheck()
    void refresh(true)
  }
  const setMode = async (mode: 'ask' | 'auto'): Promise<void> => {
    await window.cove.accountsSetMode(mode)
    await refresh()
  }
  return (
    <div className="settings-accounts">
      {/* One card per agent: whether it is installed and signed in, and under
          that the accounts it can run on with how much of each is used. These
          were two lists — the agents, then further down the same agents again
          with their accounts — and a third of the page said things twice. */}
      {AGENT_PROVIDERS.map((p) => {
        const status = env?.[p]
        const pending = envChecking && !env
        const connected = !!status?.installed && !!status?.loggedIn
        const state = pending
          ? 'checking'
          : connected
            ? 'connected'
            : status?.installed
              ? 'signed-out'
              : 'missing'
        const copy = AGENT_COPY[p]
        return (
          <div key={p} className={`settings-agent settings-accounts-provider ${state}`}>
            <div className="settings-agent-head">
              <span className={`settings-agent-dot ${state}`} aria-hidden />
              <strong>{PROVIDER_PRODUCT[p]}</strong>
              <span className="settings-agent-version">
                {status?.installed ? `Version ${status.version}` : ''}
              </span>
              <span className="settings-agent-state">
                {pending
                  ? 'Checking…'
                  : connected
                    ? 'Connected'
                    : status?.installed
                      ? 'Not signed in'
                      : 'Not installed'}
              </span>
            </div>
            {!pending && !status?.installed && (
              <div className="settings-agent-detail">
                Not found on your PATH. Install it with <code>{copy.install}</code>
              </div>
            )}
            {status?.installed && !status.loggedIn && (
              <>
                <div className="settings-agent-detail">{copy.signIn}</div>
                <div className="settings-agent-actions">
                  <button
                    className="settings-agent-btn"
                    onClick={() => {
                      window.cove.openAgentLogin(p)
                    }}
                  >
                    Sign in
                  </button>
                  <button
                    className="settings-agent-btn ghost"
                    onClick={recheckAll}
                    disabled={envChecking || checking}
                  >
                    Re-check
                  </button>
                  <span className="settings-agent-hint">
                    Opens Terminal running <code>{copy.terminal}</code>.
                  </span>
                </div>
              </>
            )}
            {/* Its accounts: there at once, while the agent itself is still
                being asked whether it is installed — that answer takes seconds,
                and the list does not depend on it. Gone only when there turns
                out to be no agent to run them. */}
            {(pending || status?.installed) && (
              <ul className="settings-accounts-list">
                {(list?.[p] ?? []).map((a) => (
                  <li
                    key={a.id}
                    className={`settings-account ${a.limitedUntil ? 'limited' : ''} ${a.needsAuth ? 'needs-auth' : ''}`}
                  >
                    <span className="settings-account-who">
                      <span className="settings-account-name">{a.name}</span>
                      {(a.detail || a.needsAuth) && (
                        <span className="settings-account-detail">
                          {a.needsAuth ? `${a.needsAuth} — ${fixHint(a)}` : a.detail}
                        </span>
                      )}
                      {!a.needsAuth && a.usage && <AccountUsage key={a.usage.at} usage={a.usage} />}
                    </span>
                    <span className="settings-account-state">
                      {a.needsAuth
                        ? 'needs sign-in'
                        : a.limitedUntil
                          ? timeLeft(a.limitedUntil)
                          : a.kind === 'login'
                            ? ''
                            : 'ready'}
                    </span>
                    {a.kind !== 'login' && (
                      <button
                        className="settings-account-remove"
                        title="Remove this account"
                        onClick={() => void remove(a.id)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* Antigravity keeps its sign-in in the keychain, one per machine:
                there is no second home or token to add an account with. */}
            {(pending || status?.installed) && adding !== p && p !== 'antigravity' && (
              <button className="settings-account-add" onClick={() => startAdd(p)}>
                Add account…
              </button>
            )}
            {adding === p && (
              <div className="settings-accounts-add">
                {p === 'claude' ? (
                  <p className="settings-agent-hint">
                    In Terminal, run <code>claude setup-token</code>, sign in with the other
                    account, and paste the token it prints here.
                  </p>
                ) : (
                  <p className="settings-agent-hint">
                    Codex opens your browser to sign in; use the other account there.
                  </p>
                )}
                <input
                  className="settings-accounts-input"
                  placeholder="Name, e.g. Work"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                {p === 'claude' && (
                  <input
                    className="settings-accounts-input"
                    placeholder="sk-ant-oat01-…"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    spellCheck={false}
                  />
                )}
                {error && <p className="settings-accounts-error">{error}</p>}
                <div className="settings-accounts-actions">
                  <button
                    className="settings-agent-btn ghost"
                    onClick={() => setAdding(null)}
                    disabled={!!busy}
                  >
                    Cancel
                  </button>
                  <button
                    className="settings-agent-btn"
                    onClick={() => void add()}
                    disabled={!!busy || (p === 'claude' && !token.trim())}
                  >
                    {busy ?? (p === 'claude' ? 'Add' : 'Sign in…')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
      <div className="settings-agents-foot">
        <button
          className="settings-agent-btn ghost"
          onClick={recheckAll}
          disabled={envChecking || checking}
        >
          {envChecking || checking ? 'Checking…' : 'Re-check'}
        </button>
        <span className="settings-agent-hint">
          Superagent ships no AI of its own — it runs on whichever of these you already pay for. One
          is enough. A second account lets a chat carry on when the first hits its limit.
        </span>
      </div>
      <GroupLabel>When an account hits its limit</GroupLabel>
      <Row
        title="Switch accounts"
        desc="Ask shows a card in the chat with the accounts that still have allowance. Automatic switches on its own and says so."
      >
        <div className="mode-switch">
          {(['ask', 'auto'] as const).map((m) => (
            <button
              key={m}
              className={`mode-switch-btn ${(list?.mode ?? 'ask') === m ? 'active' : ''}`}
              onClick={() => void setMode(m)}
            >
              {m === 'ask' ? 'Ask' : 'Automatic'}
            </button>
          ))}
        </div>
      </Row>
    </div>
  )
}

function Row({
  title,
  desc,
  stacked,
  children
}: {
  title: string
  desc: string
  /** The control goes under the words, at full width: for one too big to sit beside them. */
  stacked?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`settings-row${stacked ? ' stacked' : ''}`}>
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

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`
  if (b >= 1024) return `${Math.round(b / 1024)} KB`
  return `${b} B`
}

export function Settings({
  onClose,
  initialSection = 'general'
}: SettingsProps): React.JSX.Element {
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
  const [section, setSection] = useState<SectionId>(initialSection)
  /** Measured on entering Advanced, not on every render — du walks gigabytes. */
  const [storage, setStorage] = useState<{ key: string; label: string; bytes: number }[] | null>(
    null
  )
  useEffect(() => {
    if (section !== 'advanced' || storage !== null) return
    void window.cove.storageUsage?.().then((s) => setStorage(s ?? []))
  }, [section, storage])
  const [clearing, setClearing] = useState(false)
  const clearCaches = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.cove.clearBrowserCaches?.()
    } finally {
      setClearing(false)
      // Null re-arms the measuring effect, so the numbers show what was freed.
      setStorage(null)
    }
  }
  // Conversations, broken down by project — collapsed by default (it's a
  // second SQL query on top of storageUsage's own, no need to run it until
  // someone actually wants to see it).
  const [showByProject, setShowByProject] = useState(false)
  const [byProject, setByProject] = useState<
    { workspaceId: string; name: string; bytes: number; chatCount: number }[] | null
  >(null)
  useEffect(() => {
    if (!showByProject || byProject !== null) return
    void window.cove.storageByProject?.().then((p) => setByProject(p ?? []))
  }, [showByProject, byProject])
  const [clearingProject, setClearingProject] = useState<string | null>(null)
  const clearProject = async (workspaceId: string, name: string): Promise<void> => {
    if (
      !window.confirm(
        `Clear every chat in "${name}"?\n\nTranscripts are wiped and each conversation starts fresh — the project, its files and its chats' titles are untouched. This can't be undone.`
      )
    )
      return
    setClearingProject(workspaceId)
    try {
      await window.cove.clearWorkspaceChats?.(workspaceId)
    } finally {
      setClearingProject(null)
      setByProject(null)
      setStorage(null)
    }
  }
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
  const [betaUpdates, setBetaUpdates] = useState(false)
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
    window.cove.updateGetBeta?.().then((v) => setBetaUpdates(!!v))
  }, [])

  const toggleBeta = (v: boolean): void => {
    setBetaUpdates(v)
    void window.cove.updateSetBeta?.(v)
    setUpdateMsg(
      v
        ? 'Beta updates on — checking for the newest beta.'
        : 'Beta updates off — you’ll stay on stable releases.'
    )
  }

  // Escape closes the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Irreversible, so a plain-words confirm first. The window's own memory
  // (localStorage) goes too; main wipes the rest and restarts the app.
  const resetApp = async (): Promise<void> => {
    const ok = window.confirm(
      'Reset Superagent?\n\nThis removes every project, group, chat and its history, the Todo ' +
        'board, routines and loops, then restarts Superagent like a new install.\n\nYour files ' +
        'and folders, paired phones and browser logins stay. This can’t be undone.'
    )
    if (!ok) return
    localStorage.clear()
    await window.cove.resetApp()
    // Tests stay in the same window (no relaunch); start it over.
    window.location.reload()
  }
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
              <NavIcon id={s.id} />
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {/* One heading for whichever section is showing: the list on the left
              says where you are, this says what it is for. */}
          <header className="settings-section-head">
            <h2>{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <p>{SECTIONS.find((s) => s.id === section)?.blurb}</p>
          </header>
          {section === 'general' && (
            <section className="settings-section">
              <GroupLabel>Look</GroupLabel>
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
              <GroupLabel>Notifications</GroupLabel>
              <Row
                title="When the agent finishes"
                desc="A banner when a turn completes while you're in another app."
              >
                <Toggle checked={notifyDone} onChange={toggleNotifyDone} />
              </Row>
              <Row
                title="When the agent needs you"
                desc="A banner when the agent is waiting on your input."
              >
                <Toggle checked={notifyNeedsYou} onChange={toggleNotifyNeedsYou} />
              </Row>
            </section>
          )}

          {section === 'connections' && (
            <section className="settings-section">
              <MailConnection />
            </section>
          )}

          {section === 'agents' && (
            <section className="settings-section">
              <AgentsPanel env={env} envChecking={envChecking} onRecheck={checkAgents} />
              <GroupLabel>New chats</GroupLabel>
              <Row
                title="Agent"
                desc="Where a new chat starts. Every chat keeps its own agent; change one from the Agent pill under its composer."
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
              <Row
                title="Permissions"
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

          {section === 'phone' && <PhoneSettings />}

          {section === 'advanced' && (
            <section className="settings-section">
              <Row
                stacked
                title="Storage"
                desc="What Superagent keeps on this Mac. Browsing data is sites the agent visited storing their own caches and logins, the way any browser profile grows."
              >
                <div className="storage-usage">
                  {storage === null ? (
                    <span className="storage-total">Measuring…</span>
                  ) : (
                    <>
                      <span className="storage-total">
                        {fmtBytes(storage.reduce((a, g) => a + g.bytes, 0))} total
                      </span>
                      <div className="storage-bar" aria-hidden>
                        {storage
                          .filter((g) => g.bytes > 0)
                          .map((g) => (
                            <span
                              key={g.key}
                              className={`storage-seg storage-${g.key}`}
                              style={{ flexGrow: g.bytes }}
                            />
                          ))}
                      </div>
                      {storage.map((g) => (
                        <div key={g.key} className="storage-row-group">
                          <div className="storage-row">
                            <span className={`storage-dot storage-${g.key}`} />
                            <span className="storage-label">{g.label}</span>
                            <span className="storage-bytes">{fmtBytes(g.bytes)}</span>
                            {g.key === 'conversations' && g.bytes > 0 && (
                              <button
                                className="storage-byproject-toggle"
                                onClick={() => setShowByProject((v) => !v)}
                              >
                                {showByProject ? 'Hide by project' : 'By project'}
                              </button>
                            )}
                          </div>
                          {g.key === 'conversations' && showByProject && (
                            <div className="storage-byproject">
                              {byProject === null ? (
                                <span className="storage-byproject-note">Measuring…</span>
                              ) : byProject.length === 0 ? (
                                <span className="storage-byproject-note">Nothing to show.</span>
                              ) : (
                                byProject.map((p) => (
                                  <div key={p.workspaceId} className="storage-byproject-row">
                                    <span className="storage-byproject-name">{p.name}</span>
                                    <span className="storage-byproject-count">
                                      {p.chatCount} chat{p.chatCount === 1 ? '' : 's'}
                                    </span>
                                    <span className="storage-byproject-bytes">
                                      {fmtBytes(p.bytes)}
                                    </span>
                                    <button
                                      className="storage-byproject-clear"
                                      disabled={clearingProject === p.workspaceId}
                                      onClick={() => void clearProject(p.workspaceId, p.name)}
                                    >
                                      {clearingProject === p.workspaceId ? 'Clearing…' : 'Clear'}
                                    </button>
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        className="storage-clear"
                        disabled={clearing}
                        onClick={() => void clearCaches()}
                      >
                        {clearing ? 'Clearing…' : 'Clear caches'}
                      </button>
                      <span className="storage-clear-note">
                        Removes rebuildable caches and service workers. Logins and site data stay.
                      </span>
                    </>
                  )}
                </div>
              </Row>
              <GroupLabel>Developer</GroupLabel>
              <Row title="Developer mode" desc="Show DevTools and verbose details.">
                <Toggle checked={devMode} onChange={toggleDev} />
              </Row>
              <GroupLabel>Start over</GroupLabel>
              <Row
                title="Reset Superagent"
                desc="Start fresh: removes every project, chat, board and routine. Your files, paired phones and browser logins stay."
              >
                <button className="storage-clear settings-reset" onClick={() => void resetApp()}>
                  Reset…
                </button>
              </Row>
            </section>
          )}

          {section === 'about' && (
            <section className="settings-section">
              <div className="settings-about">
                <div className="settings-about-id">
                  <div className="settings-about-app">Superagent</div>
                  <div className="settings-about-ver">Version {appVersion ?? '—'}</div>
                  <div className="settings-about-agents">{version || 'No agent found'}</div>
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
              <Row
                title="Beta updates"
                desc="Get pre-release builds early to try new things and help catch problems. They can be rough; turn this off to stay on stable releases only."
              >
                <Toggle checked={betaUpdates} onChange={toggleBeta} />
              </Row>
              <Row
                title="Intro"
                desc="The short film that plays the first time Superagent opens: what the app does, in half a minute."
              >
                <button
                  className="settings-update-check"
                  onClick={() => {
                    // Out of Settings first: the intro plays over the app.
                    onClose()
                    window.dispatchEvent(new CustomEvent(REPLAY_INTRO_EVENT))
                  }}
                >
                  Show the intro again
                </button>
              </Row>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
