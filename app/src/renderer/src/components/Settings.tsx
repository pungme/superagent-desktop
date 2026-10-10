import type { ComputerStatus } from '../../../preload'
import {
  DOT_HOTKEYS,
  NO_DOT_HOTKEY,
  TALK_HOTKEYS,
  dotHotkeyLabel,
  talkHotkeyLabel
} from '../../../shared/dot-hotkey'
import { APP_HOTKEYS, NO_APP_HOTKEY, appHotkeyLabel } from '../../../shared/app-hotkey'
import { resetLabel } from '../../../shared/usage-reset'
import { MailConnection } from './MailConnection'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Account } from '../../../preload'
import { useStore, ACCENTS, ICON_COLOURS, applyAccent, iconFill } from '../state'
import { IconEditor } from './IconEditor'
import type { IconPlace } from '../app-icon'
import { PhoneSettings } from './PhoneSettings'
import { REPLAY_INTRO_EVENT } from '../firstRun'
import { REPLAY_TOUR_EVENT } from '../tour/tour-keys'
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
    <div className="settings-account-usage" title={`Updated ${ago(usage.at, now)}`}>
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
            <span className="settings-usage-reset">
              {w.resetsAt && !over ? `resets ${resetLabel(w.resetsAt, now)}` : ''}
            </span>
          </span>
        )
      })}
    </div>
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
                    {/* One line for who it is and what state it is in, the
                        meters under it in a grid of their own: with the state
                        in a column beside the meters, a long "out until" took
                        their width and each account wrapped differently. */}
                    <div className="settings-account-top">
                      <span className="settings-account-name">{a.name}</span>
                      {(a.needsAuth || a.limitedUntil) && (
                        <span className="settings-account-badge">
                          {a.needsAuth ? 'Needs sign-in' : timeLeft(a.limitedUntil)}
                        </span>
                      )}
                      {a.kind !== 'login' && (
                        <button
                          className="settings-account-remove"
                          title="Remove this account"
                          onClick={() => void remove(a.id)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    {(a.detail || a.needsAuth) && (
                      <span className="settings-account-detail">
                        {a.needsAuth ? `${a.needsAuth} — ${fixHint(a)}` : a.detail}
                      </span>
                    )}
                    {!a.needsAuth && a.usage && <AccountUsage key={a.usage.at} usage={a.usage} />}
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
  // 'default', one of the named colours, or any #rrggbb of your own.
  const [iconColour, setIconColour] = useState<string>(
    () => localStorage.getItem('cove.iconColour') || 'default'
  )
  const [iconPhoto, setIconPhoto] = useState(() => !!localStorage.getItem('cove.iconPhoto'))
  /** A small picture of the icon as it is, for the swatch that stands for it. */
  const [iconThumbUrl, setIconThumbUrl] = useState(() => localStorage.getItem('cove.iconThumb'))
  /** The picture being placed, while the editor is open. */
  const [placing, setPlacing] = useState<{
    image: HTMLImageElement
    url: string
    place: IconPlace
  } | null>(null)
  const iconFileRef = useRef<HTMLInputElement>(null)
  const [accentCustom, setAccentCustom] = useState(() => localStorage.getItem('cove.accentCustom'))

  /** A colour replaces the dark of the icon; the white square stays. */
  const chooseIconColour = async (a: string): Promise<void> => {
    for (const k of ['cove.iconPhoto', 'cove.iconPlace', 'cove.iconThumb'])
      localStorage.removeItem(k)
    localStorage.setItem('cove.iconColour', a)
    setIconPhoto(false)
    setIconThumbUrl(null)
    setIconColour(a)
    const { renderAppIcon } = await import('../app-icon')
    // 'default' means the shipped icon, so hand back nothing and let main
    // restore the real one rather than redrawing an imitation of it.
    const fill = iconFill(a)
    const png = fill ? await renderAppIcon(fill) : null
    await window.cove.setAppIcon?.(png)
  }

  /** A picture was picked: open it in the editor. Nothing changes until "Use this icon". */
  const pickIconPhoto = async (file?: File): Promise<void> => {
    if (!file) return
    const { loadImage, loadImageUrl, shrinkForKeeping, CENTRED } = await import('../app-icon')
    try {
      // Kept small enough to store: it has to survive a restart.
      const url = shrinkForKeeping(await loadImage(file))
      if (!url) return
      setPlacing({ image: await loadImageUrl(url), url, place: CENTRED })
    } catch {
      // Not an image, or too large to decode — the icon simply does not change.
    }
  }

  /** The picture swatch: place the picture you have again, or pick one. */
  const openIconPhoto = async (): Promise<void> => {
    const url = localStorage.getItem('cove.iconPhoto')
    if (!url) return iconFileRef.current?.click()
    const { loadImageUrl, clampPlace } = await import('../app-icon')
    try {
      let place: unknown = null
      try {
        place = JSON.parse(localStorage.getItem('cove.iconPlace') ?? 'null')
      } catch {
        // an unreadable placement is just "centred"
      }
      setPlacing({ image: await loadImageUrl(url), url, place: clampPlace(place as IconPlace) })
    } catch {
      iconFileRef.current?.click()
    }
  }

  /** The picture goes where the dark was, as placed, with the white square on top. */
  const applyIconPhoto = async (place: IconPlace): Promise<void> => {
    if (!placing) return
    const { renderAppIcon, iconThumb } = await import('../app-icon')
    const png = await renderAppIcon(placing.image, place)
    if (!png) return
    const thumb = iconThumb(placing.image, place)
    try {
      localStorage.setItem('cove.iconPhoto', placing.url)
      localStorage.setItem('cove.iconPlace', JSON.stringify(place))
      localStorage.setItem('cove.iconThumb', thumb)
      localStorage.removeItem('cove.iconColour')
    } catch {
      // Out of room to keep it: it still applies now, and is gone on restart.
    }
    setIconPhoto(true)
    setIconThumbUrl(thumb)
    setPlacing(null)
    await window.cove.setAppIcon?.(png)
  }
  // Keep working with the lid closed: off unless turned on; the main process
  // owns it, since it is a system setting that needs an administrator.
  // The floating dot (main/dot.ts): on unless turned off.
  const [dotOn, setDotOn] = useState(true)
  useEffect(() => {
    void window.cove.dotEnabled?.().then((on) => setDotOn(!!on))
  }, [])
  const [dotKey, setDotKey] = useState<{ hotkey: string; ok: boolean }>({
    hotkey: DOT_HOTKEYS[0].accelerator,
    ok: true
  })
  useEffect(() => {
    void window.cove.dotHotkey?.().then(setDotKey)
    return window.cove.onDotHotkey?.(setDotKey)
  }, [])
  const [talkKey, setTalkKey] = useState<{ hotkey: string; ok: boolean }>({
    hotkey: TALK_HOTKEYS[0].accelerator,
    ok: true
  })
  useEffect(() => {
    void window.cove.talkHotkey?.().then(setTalkKey)
    return window.cove.onTalkHotkey?.(setTalkKey)
  }, [])
  const [appKey, setAppKey] = useState<{ hotkey: string; ok: boolean }>({
    hotkey: APP_HOTKEYS[0].accelerator,
    ok: true
  })
  useEffect(() => {
    void window.cove.appHotkey?.().then(setAppKey)
    return window.cove.onAppHotkey?.(setAppKey)
  }, [])
  const toggleDot = async (on: boolean): Promise<void> => {
    setDotOn(on)
    setDotOn(await window.cove.setDotEnabled(on))
  }
  // Computer use (main/computer-use.ts): off unless turned on, and then it
  // needs two permissions only macOS can give.
  const [computer, setComputer] = useState<ComputerStatus>({
    supported: true,
    enabled: false,
    screen: false,
    accessibility: false,
    helper: true
  })
  useEffect(() => {
    void window.cove.computerStatus?.().then(setComputer)
  }, [])
  // The permissions are granted in another app; notice when they have been.
  useEffect(() => {
    if (!computer.enabled || (computer.screen && computer.accessibility)) return
    const t = setInterval(() => void window.cove.computerStatus().then(setComputer), 2000)
    return () => clearInterval(t)
  }, [computer.enabled, computer.screen, computer.accessibility])
  // What agents have done with the Mac, shown on request.
  const [computerLog, setComputerLog] = useState<
    { at: number; chat: string; what: string; kind?: string }[] | null
  >(null)
  const toggleComputerLog = (): void => {
    if (computerLog) setComputerLog(null)
    else void window.cove.computerLog().then(setComputerLog)
  }
  const toggleComputer = async (on: boolean): Promise<void> => {
    setComputer((c) => ({ ...c, enabled: on }))
    setComputer(await window.cove.setComputerUse(on))
  }
  // What macOS reports as granted can lag behind what works (until a restart),
  // so there is a way to really try.
  const [computerCheck, setComputerCheck] = useState<Awaited<
    ReturnType<typeof window.cove.computerCheck>
  > | null>(null)
  const [computerChecking, setComputerChecking] = useState(false)
  const checkComputer = async (): Promise<void> => {
    setComputerChecking(true)
    setComputerCheck(await window.cove.computerCheck())
    setComputerChecking(false)
  }
  const grantComputer = async (which: 'screen' | 'accessibility'): Promise<void> => {
    // macOS's own prompt the first time; its settings page in any case, since
    // after a refusal the prompt never comes back.
    setComputer(await window.cove.computerRequest(which))
    await window.cove.computerOpenSettings(which)
  }
  const [lidAwake, setLidAwakeState] = useState(false)
  const [lidAwakeError, setLidAwakeError] = useState('')
  useEffect(() => {
    void window.cove.lidAwake?.().then((on) => setLidAwakeState(!!on))
  }, [])
  const toggleLidAwake = async (on: boolean): Promise<void> => {
    setLidAwakeError('')
    // Shown at once; put back if macOS says no or the password is cancelled.
    setLidAwakeState(on)
    const res = await window.cove.setLidAwake(on)
    if (res.ok) setLidAwakeState(res.enabled)
    else {
      setLidAwakeState(!on)
      setLidAwakeError(res.error)
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
                  <ColourWell
                    className="icon-swatch"
                    value={/^#/.test(iconColour) && !iconPhoto ? iconColour : null}
                    title="Any colour"
                    label="Pick any colour for the icon"
                    onPick={(hex) => void chooseIconColour(hex)}
                  >
                    <span className="icon-swatch-dot" />
                  </ColourWell>
                  {/* With a picture in use this swatch IS that icon, so Settings
                      shows what the Dock shows; pressing it places it again. */}
                  <button
                    className={`accent-swatch icon-swatch icon-swatch-photo ${iconPhoto ? 'active' : ''}`}
                    style={
                      iconPhoto && iconThumbUrl
                        ? { backgroundImage: `url(${iconThumbUrl})`, backgroundSize: 'cover' }
                        : undefined
                    }
                    onClick={() => void openIconPhoto()}
                    title={iconPhoto ? 'Your picture — click to adjust' : 'Use a picture'}
                    aria-label="Use your own picture as the icon"
                    aria-pressed={iconPhoto}
                  >
                    {!(iconPhoto && iconThumbUrl) && <span className="icon-swatch-dot" />}
                  </button>
                  <input
                    ref={iconFileRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      void pickIconPhoto(e.target.files?.[0])
                      e.target.value = '' // allow re-picking the same file
                    }}
                  />
                </div>
              </Row>
              {placing && (
                <IconEditor
                  image={placing.image}
                  initial={placing.place}
                  onUse={(place) => void applyIconPhoto(place)}
                  onCancel={() => setPlacing(null)}
                  onAnother={() => iconFileRef.current?.click()}
                />
              )}
              <Row title="Accent" desc="The colour on your messages, and on whatever is selected.">
                <div className="accent-swatches">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      className={`accent-swatch accent-${a} ${accent === a && !accentCustom ? 'active' : ''}`}
                      onClick={() => {
                        setAccentCustom(null)
                        setAccent(a)
                      }}
                      title={a === 'default' ? 'Default' : a[0].toUpperCase() + a.slice(1)}
                      aria-label={a === 'default' ? 'Default accent' : `${a} accent`}
                      aria-pressed={accent === a && !accentCustom}
                    />
                  ))}
                  <ColourWell
                    value={accentCustom}
                    title="Any colour"
                    label="Pick any colour for the accent"
                    onPick={(hex) => {
                      localStorage.setItem('cove.accentCustom', hex)
                      setAccentCustom(hex)
                      applyAccent(accent)
                    }}
                  />
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
              <GroupLabel>Shortcut</GroupLabel>
              <Row
                title="Bring Superagent forward"
                desc={
                  appKey.ok
                    ? 'From any app: brings this window to the front. Press it again to put it away and go back to where you were.'
                    : `${appHotkeyLabel(appKey.hotkey)} is already used by another app, so it does nothing here. Pick another.`
                }
              >
                <select
                  className={`settings-select ${appKey.ok ? '' : 'warn'}`}
                  aria-label="Shortcut that brings Superagent forward"
                  value={appKey.hotkey}
                  onChange={(e) => void window.cove.setAppHotkey(e.target.value).then(setAppKey)}
                >
                  {APP_HOTKEYS.map((h) => (
                    <option key={h.accelerator} value={h.accelerator}>
                      {h.label}
                    </option>
                  ))}
                  <option value={NO_APP_HOTKEY}>None</option>
                </select>
              </Row>
              <GroupLabel>The dot</GroupLabel>
              <Row
                title="Show Superagent as a floating dot"
                desc="A small tile in the corner of your screen, over every app. Click it, or press its shortcut, to ask something or hand it a job, in the Computer or any project, without opening this window."
              >
                <Toggle checked={dotOn} onChange={(v) => void toggleDot(v)} />
              </Row>
              {dotOn && (
                <Row
                  title="Shortcut"
                  desc={
                    dotKey.ok
                      ? 'Opens the dot from anywhere, and closes it again.'
                      : `${dotHotkeyLabel(dotKey.hotkey)} is already used by another app, so it does nothing here. Pick another, or click the dot.`
                  }
                >
                  <select
                    className={`settings-select ${dotKey.ok ? '' : 'warn'}`}
                    aria-label="Shortcut for the dot"
                    value={dotKey.hotkey}
                    onChange={(e) => void window.cove.setDotHotkey(e.target.value).then(setDotKey)}
                  >
                    {DOT_HOTKEYS.map((h) => (
                      <option key={h.accelerator} value={h.accelerator}>
                        {h.label}
                      </option>
                    ))}
                    <option value={NO_DOT_HOTKEY}>None</option>
                  </select>
                </Row>
              )}
              {dotOn && (
                <Row
                  title="Talk to it"
                  desc={
                    talkKey.ok
                      ? 'From anywhere: press once and speak, press again to send what you said. Transcribed on this Mac.'
                      : `${talkHotkeyLabel(talkKey.hotkey)} is already used by another app, so it does nothing here. Pick another, or use the microphone button on the dot.`
                  }
                >
                  <select
                    className={`settings-select ${talkKey.ok ? '' : 'warn'}`}
                    aria-label="Shortcut for talking to the dot"
                    value={talkKey.hotkey}
                    onChange={(e) =>
                      void window.cove.setTalkHotkey(e.target.value).then(setTalkKey)
                    }
                  >
                    {TALK_HOTKEYS.map((h) => (
                      <option key={h.accelerator} value={h.accelerator}>
                        {h.label}
                      </option>
                    ))}
                    <option value={NO_DOT_HOTKEY}>None</option>
                  </select>
                </Row>
              )}
              <GroupLabel>Computer use</GroupLabel>
              <Row
                title="Let agents use this Mac"
                desc={
                  computer.stopKeyRefused
                    ? 'An agent can see your screen and work the mouse and keyboard in any app. Each conversation asks you first. Another app has ⌥Esc, so it will NOT stop computer use here: use the Stop button in the chat or on the dot.'
                    : "An agent can see your screen and work the mouse and keyboard in any app, for what only an app's own window can do. Each conversation asks you first, and ⌥Esc stops it from anywhere."
                }
              >
                <Toggle checked={computer.enabled} onChange={(v) => void toggleComputer(v)} />
              </Row>
              {computer.enabled &&
                (
                  [
                    ['screen', 'Screen Recording', 'So it can see the screen.'],
                    ['accessibility', 'Accessibility', 'So it can move the pointer and type.']
                  ] as const
                ).map(([which, name, why]) => (
                  <Row
                    key={which}
                    title={name}
                    desc={
                      computer[which]
                        ? `${why} Granted.`
                        : `${why} Not granted yet: allow Superagent in System Settings, then come back. macOS may ask you to restart Superagent.`
                    }
                  >
                    {computer[which] ? (
                      <span className="settings-granted">Granted</span>
                    ) : (
                      <button
                        className="settings-agent-btn"
                        onClick={() => void grantComputer(which)}
                      >
                        Grant…
                      </button>
                    )}
                  </Row>
                ))}
              {computer.enabled && (
                <Row
                  title="Check it works"
                  desc={
                    !computerCheck
                      ? 'Takes one screenshot and asks macOS whether Superagent may act. Nothing is clicked or typed.'
                      : computerCheck.see && computerCheck.act
                        ? `It can see the screen (${computerCheck.size}) and use the mouse and keyboard.`
                        : computerCheck.error ||
                          'It is not ready yet. Grant the permissions above, then restart Superagent.'
                  }
                >
                  <button
                    className="settings-agent-btn"
                    disabled={computerChecking}
                    onClick={() => void checkComputer()}
                  >
                    {computerChecking ? 'Checking…' : 'Check'}
                  </button>
                </Row>
              )}
              {computer.enabled && (
                <Row
                  title="Show where it is about to act"
                  desc="A ring appears where an agent is about to click, drag or scroll, a moment before it does. It takes no clicks and is not in the agent's own screenshots."
                >
                  <Toggle
                    checked={computer.ring !== false}
                    onChange={(v) => void window.cove.setComputerRing(v).then(setComputer)}
                  />
                </Row>
              )}
              {computer.enabled && (
                <Row
                  title="Show it only the apps you allowed"
                  desc="In an agent's screenshots, every other app's window, notifications and the desktop are covered in grey. It sees an app once you have allowed it there. Off: it sees the whole screen, apart from the apps on the list below."
                >
                  <Toggle
                    checked={computer.focused === true}
                    onChange={(v) => void window.cove.setComputerFocused(v).then(setComputer)}
                  />
                </Row>
              )}
              {computer.enabled && (
                <Row
                  title="Apps it stays out of"
                  desc={`Never ${(computer.builtInDenied ?? []).slice(0, 3).join(', ') || 'password managers'}, other password managers, a password prompt or the lock screen. Add any app you want left alone. In every other app it asks you the first time.`}
                >
                  <div className="settings-keepout">
                    {(computer.denied ?? []).map((a) => (
                      <span key={a.id} className="settings-keepout-app">
                        {a.name}
                        <button
                          aria-label={`Let computer use work in ${a.name} again`}
                          title="Remove"
                          onClick={() => void window.cove.computerUndeny(a.id).then(setComputer)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <button
                      className="settings-agent-btn"
                      onClick={() => void window.cove.computerDenyPick().then(setComputer)}
                    >
                      Add app…
                    </button>
                  </div>
                </Row>
              )}
              {computer.enabled && (
                <Row
                  title="Apps with a standing answer"
                  desc="Always: it works there without asking each conversation. Look only: it may see the app and read its controls, but never click or type in it. Click a name to switch between the two."
                >
                  <div className="settings-keepout">
                    {(computer.rules ?? []).map((a) => (
                      <span key={a.id} className={`settings-keepout-app rule-${a.level}`}>
                        <button
                          className="settings-rule-level"
                          title={
                            a.level === 'allow'
                              ? 'Always allowed. Click for look only.'
                              : 'Look only. Click for always allowed.'
                          }
                          onClick={() =>
                            void window.cove
                              .computerRule(a, a.level === 'allow' ? 'look' : 'allow')
                              .then(setComputer)
                          }
                        >
                          {a.name} · {a.level === 'allow' ? 'always' : 'look only'}
                        </button>
                        <button
                          aria-label={`Ask about ${a.name} again`}
                          title="Remove"
                          onClick={() => void window.cove.computerRule(a, null).then(setComputer)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <button
                      className="settings-agent-btn"
                      onClick={() => void window.cove.computerRulePick('allow').then(setComputer)}
                    >
                      Always allow…
                    </button>
                    <button
                      className="settings-agent-btn ghost"
                      onClick={() => void window.cove.computerRulePick('look').then(setComputer)}
                    >
                      Look only…
                    </button>
                  </div>
                </Row>
              )}
              {computer.enabled && (
                <Row
                  title="What it has done"
                  desc="Every look and every action an agent took on this Mac, with when and in which conversation. What it typed is not kept, only that it typed."
                >
                  <button className="settings-agent-btn ghost" onClick={toggleComputerLog}>
                    {computerLog ? 'Hide' : 'Show'}
                  </button>
                </Row>
              )}
              {computer.enabled && computerLog && (
                <div
                  className="settings-computer-log"
                  role="log"
                  aria-label="What computer use has done"
                >
                  {computerLog.length === 0 && (
                    <div className="settings-computer-log-empty">Nothing yet.</div>
                  )}
                  {computerLog.map((e, i) => (
                    <div key={i} className={`settings-computer-log-row ${e.kind ?? 'did'}`}>
                      <time>
                        {new Date(e.at).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </time>
                      <span className="what">{e.what}</span>
                      <span className="chat">{e.chat}</span>
                    </div>
                  ))}
                </div>
              )}
              <GroupLabel>Power</GroupLabel>
              <Row
                title="Keep working with the lid closed"
                desc="Agents carry on when you close your MacBook. macOS asks for your password once. While Superagent is open your Mac will not sleep, so it stays awake, and warm, in a bag."
              >
                <Toggle checked={lidAwake} onChange={(v) => void toggleLidAwake(v)} />
              </Row>
              {lidAwakeError && (
                <p role="alert" className="settings-row-error">
                  {lidAwakeError}
                </p>
              )}
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
                            {g.key === 'logs' && g.bytes > 0 && (
                              <button
                                className="storage-byproject-toggle"
                                onClick={() =>
                                  void window.cove.clearLogs().then(() => setStorage(null))
                                }
                              >
                                Clear
                              </button>
                            )}
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
              <Row
                title="How it works"
                desc="Five short scenes: your chats on one rail, the agent seeing what it builds, how it gets your attention, the dot, and using your Mac."
              >
                <button
                  className="settings-update-check"
                  onClick={() => {
                    onClose()
                    window.dispatchEvent(new CustomEvent(REPLAY_TOUR_EVENT))
                  }}
                >
                  Show me
                </button>
              </Row>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A swatch that opens the system colour picker: any colour at all, beside the
 * handful on offer. Shows the rainbow until one is chosen, then that colour.
 */
function ColourWell({
  value,
  onPick,
  title,
  label,
  className = '',
  children
}: {
  value: string | null
  onPick: (hex: string) => void
  title: string
  label: string
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <label
      className={`accent-swatch colour-well ${className} ${value ? 'active' : ''}`}
      style={value ? { background: value, color: value } : undefined}
      title={title}
    >
      {children}
      <input
        type="color"
        aria-label={label}
        value={value ?? '#7c6cf0'}
        // On every move of the picker, so the choice is seen as it is made.
        onInput={(e) => onPick((e.target as HTMLInputElement).value)}
        onChange={(e) => onPick(e.target.value)}
      />
    </label>
  )
}
