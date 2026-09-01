import { useEffect, useState } from 'react'
import { useStore } from '../state'
import {
  AGENT_PROVIDERS,
  PROVIDER_PRODUCT,
  type AgentProvider
} from '../../../shared/agent-provider'

interface OnboardingProps {
  onDone: () => void
}

type ProviderStatus = { installed: boolean; version: string | null; loggedIn: boolean }
type EnvStatus = {
  claude: ProviderStatus
  codex: ProviderStatus
  claudeInstalled: boolean
  claudeVersion: string | null
  loggedIn: boolean
}

/** What each agent needs said about it on a first run. */
const COPY: Record<
  AgentProvider,
  {
    blurb: string
    link: string
    linkText: string
    manual: string
    signIn: string
    terminal: string
  }
> = {
  claude: {
    blurb: "Anthropic's coding agent, on your own Claude subscription.",
    link: 'https://claude.com/claude-code',
    linkText: "What's Claude Code? →",
    manual: 'curl -fsSL https://claude.ai/install.sh | bash',
    signIn: 'Sign in once with a Claude Pro/Max plan or API credits.',
    terminal: 'claude'
  },
  codex: {
    blurb: "OpenAI's coding agent, on your own ChatGPT plan.",
    link: 'https://developers.openai.com/codex/cli',
    linkText: "What's Codex? →",
    manual: 'npm install -g @openai/codex',
    signIn: 'Sign in once with a ChatGPT Plus/Pro plan or an API key.',
    terminal: 'codex login'
  }
}

function isReady(env: EnvStatus | null): boolean {
  return !!env && AGENT_PROVIDERS.some((p) => env[p].installed && env[p].loggedIn)
}

export function Onboarding({ onDone }: OnboardingProps): React.JSX.Element | null {
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [checking, setChecking] = useState(true)
  /** Which agent is installing right now, if any. */
  const [installing, setInstalling] = useState<AgentProvider | null>(null)
  // The latest line of installer output, shown as a live status.
  const [installLine, setInstallLine] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)
  const setProvider = useStore((s) => s.setProvider)

  const check = async (): Promise<void> => {
    setChecking(true)
    const status = await window.cove.envDetect()
    setEnv(status)
    setChecking(false)
  }

  // One-click install, then re-check so the step flips to ✓.
  const install = async (provider: AgentProvider): Promise<void> => {
    setInstalling(provider)
    setInstallError(null)
    setInstallLine(`Downloading ${PROVIDER_PRODUCT[provider]}…`)
    try {
      const res = await window.cove.installAgent(provider, (line) => {
        const last = line.trim().split('\n').filter(Boolean).pop()
        if (last) setInstallLine(last.slice(0, 120))
      })
      if (res.ok) {
        setInstallLine('Installed. Checking…')
        await check()
      } else {
        setInstallError(res.error || 'Install failed.')
      }
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : 'Install failed.')
    } finally {
      setInstalling(null)
    }
  }

  /**
   * A machine that already has an agent installed and signed in needs no setup,
   * so it never sees this screen — the first run just opens the app, with that
   * agent selected. Someone who installed Claude Code (or Codex) before opening
   * Superagent should not be asked to confirm what is plainly already true.
   */
  useEffect(() => {
    window.cove.envDetect().then((status) => {
      setEnv(status)
      setChecking(false)
      const usable = AGENT_PROVIDERS.filter((p) => status[p].installed && status[p].loggedIn)
      if (usable.length > 0) {
        // Only choose for them when there is nothing to choose: with both agents
        // ready, the default stands and the picker under the composer is theirs.
        if (usable.length === 1) setProvider(usable[0])
        onDone()
      }
    })
    // Runs once on mount; `checking` already starts true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ready = isReady(env)

  // Nothing to show while the auto-setup probe decides — a card that flashes up
  // and vanishes is worse than a beat of nothing.
  if (checking && !env) return null

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-logo">
          {/* The app icon, drawn rather than shipped as a PNG so it stays sharp
              at any size and the dot can animate independently of the tile. */}
          <svg viewBox="0 0 96 96" width="76" height="76" aria-hidden="true">
            <defs>
              <linearGradient id="sa-tile" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#2a2b31" />
                <stop offset="1" stopColor="#121317" />
              </linearGradient>
              <linearGradient id="sa-dot" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#ffffff" />
                <stop offset="1" stopColor="#e6e6ea" />
              </linearGradient>
            </defs>
            <rect width="96" height="96" rx="21.5" fill="url(#sa-tile)" />
            <rect
              className="onboarding-logo-dot"
              x="34"
              y="34"
              width="28"
              height="28"
              rx="7.7"
              fill="url(#sa-dot)"
            />
          </svg>
        </div>
        <h1>Welcome to Superagent</h1>
        <p className="onboarding-sub">A home for your coding agent.</p>

        <p className="onboarding-intro">
          Superagent ships no AI of its own — it runs on an agent you already pay for. Set up{' '}
          <b>either one</b> and you&rsquo;re ready; you can switch between them, per chat, at any
          time.
        </p>

        <div className="onboarding-agents">
          {AGENT_PROVIDERS.map((provider) => {
            const status = env?.[provider]
            const copy = COPY[provider]
            const busy = installing === provider
            return (
              <div
                key={provider}
                className={`onboarding-agent ${status?.installed && status?.loggedIn ? 'ok' : ''}`}
              >
                <div className="onboarding-agent-head">
                  <strong>{PROVIDER_PRODUCT[provider]}</strong>
                  {status?.installed && status?.loggedIn && (
                    <span className="onboarding-agent-badge">Ready</span>
                  )}
                </div>
                <p className="onboarding-agent-blurb">
                  {copy.blurb}{' '}
                  <a href={copy.link} target="_blank" rel="noopener noreferrer">
                    {copy.linkText}
                  </a>
                </p>

                <div className={`onboarding-step ${status?.installed ? 'ok' : 'todo'}`}>
                  <span className="step-icon">{status?.installed ? '✓' : '!'}</span>
                  <div className="step-body">
                    <strong>Installed</strong>
                    {status?.installed ? (
                      <span>Version {status.version}</span>
                    ) : busy ? (
                      <span className="onboarding-install-progress">
                        <span className="onboarding-spinner" /> {installLine || 'Installing…'}
                      </span>
                    ) : (
                      <span>
                        Not found.
                        <button
                          className="onboarding-install-btn"
                          onClick={() => install(provider)}
                          disabled={!!installing}
                        >
                          Install
                        </button>
                        {installError && installing === null && (
                          <span className="onboarding-install-error">
                            {installError}
                            <br />
                            Or run it yourself: <code>{copy.manual}</code>
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                <div
                  className={`onboarding-step ${
                    status?.loggedIn ? 'ok' : !status?.installed ? 'wait' : 'todo'
                  }`}
                >
                  <span className="step-icon">
                    {status?.loggedIn ? '✓' : status?.installed ? '!' : '·'}
                  </span>
                  <div className="step-body">
                    <strong>Signed in</strong>
                    {status?.loggedIn ? (
                      <span>You&rsquo;re signed in and ready.</span>
                    ) : status?.installed ? (
                      <span>
                        {copy.signIn}
                        <button
                          className="onboarding-install-btn"
                          onClick={() => window.cove.openAgentLogin(provider)}
                        >
                          Sign in
                        </button>
                        <span className="onboarding-hint">
                          Opens Terminal running <code>{copy.terminal}</code> — follow the prompts,
                          then Re-check.
                        </span>
                      </span>
                    ) : (
                      <span>Install it first.</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="onboarding-actions">
          <button className="onboarding-recheck" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
          <button
            className="onboarding-continue"
            onClick={() => {
              const usable = AGENT_PROVIDERS.filter((p) => env?.[p].installed && env?.[p].loggedIn)
              if (usable.length === 1) setProvider(usable[0])
              onDone()
            }}
            disabled={!ready}
          >
            {ready ? "Let's go" : 'Continue anyway'}
          </button>
        </div>
        {!ready && !checking && (
          <button className="onboarding-skip" onClick={onDone}>
            Skip setup for now
          </button>
        )}
      </div>
    </div>
  )
}
