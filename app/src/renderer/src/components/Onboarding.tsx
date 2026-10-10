import { ConnectionsStep } from './MailConnection'
import { Tour } from '../tour/Tour'
import { TOUR_SEEN_KEY } from '../tour/tour-keys'
import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { ProviderLogo } from './ProviderLogo'
import {
  AGENT_PROVIDERS,
  PROVIDER_PRODUCT,
  type AgentProvider
} from '../../../shared/agent-provider'

/** After the agents: the tour, unless it has been seen (setting up a second time). */
const afterAgents = (): 'tour' | 'connections' =>
  localStorage.getItem(TOUR_SEEN_KEY) ? 'connections' : 'tour'

interface OnboardingProps {
  onDone: () => void
}

type ProviderStatus = { installed: boolean; version: string | null; loggedIn: boolean }
type EnvStatus = {
  claude: ProviderStatus
  codex: ProviderStatus
  antigravity: ProviderStatus
  claudeInstalled: boolean
  claudeVersion: string | null
  loggedIn: boolean
}

/** What each agent runs on, and how to install it by hand if the button fails. */
const COPY: Record<AgentProvider, { plan: string; manual: string }> = {
  claude: {
    plan: 'Anthropic · a Claude Pro or Max plan',
    manual: 'curl -fsSL https://claude.ai/install.sh | bash'
  },
  codex: {
    plan: 'OpenAI · a ChatGPT Plus or Pro plan',
    manual: 'npm install -g @openai/codex'
  },
  antigravity: {
    plan: 'Google · a Google AI plan',
    manual: 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  }
}

/** What a row is in the middle of, in the words shown under its name. */
type Busy = { provider: AgentProvider; what: 'install' | 'signin'; line: string }

function isReady(env: EnvStatus | null): boolean {
  return !!env && AGENT_PROVIDERS.some((p) => env[p]?.installed && env[p]?.loggedIn)
}

export function Onboarding({ onDone }: OnboardingProps): React.JSX.Element | null {
  // Connect an agent, see how the app works, then the optional connections.
  const [step, setStep] = useState<'agents' | 'tour' | 'connections'>('agents')
  const [checkError, setCheckError] = useState('')
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [failed, setFailed] = useState<{ provider: AgentProvider; message: string } | null>(null)
  const setProvider = useStore((s) => s.setProvider)

  const check = async (): Promise<EnvStatus | null> => {
    setChecking(true)
    setCheckError('')
    try {
      const status = await window.cove.envDetect()
      setEnv(status)
      return status
    } catch {
      setCheckError('Could not check your agents. Try again, or skip setup for now.')
      return null
    } finally {
      setChecking(false)
    }
  }

  // The one button on a row: install it if it is missing, then sign in, all
  // here. Signing in opens a Superagent window on the agent's own sign-in
  // page; nothing is handed to Terminal or the browser.
  const connect = async (provider: AgentProvider): Promise<void> => {
    setFailed(null)
    try {
      let status = env?.[provider]
      if (!status?.installed) {
        setBusy({ provider, what: 'install', line: 'Downloading…' })
        const res = await window.cove.installAgent(provider, (line) => {
          const last = line.trim().split('\n').filter(Boolean).pop()
          if (last) setBusy({ provider, what: 'install', line: last.slice(0, 80) })
        })
        if (!res.ok) {
          setFailed({ provider, message: res.error || 'The install did not finish.' })
          return
        }
        status = (await check())?.[provider]
        if (!status?.installed) {
          setFailed({ provider, message: 'Installed, but Superagent cannot find it yet.' })
          return
        }
      }
      if (!status.loggedIn) {
        setBusy({ provider, what: 'signin', line: 'Waiting for you to sign in…' })
        const res = await window.cove.signInAgent(provider)
        if (!res.ok) {
          if (!res.cancelled) setFailed({ provider, message: res.error })
          return
        }
        // Signed in: say so now, and let the slower check confirm it.
        setEnv((e) => (e ? { ...e, [provider]: { ...e[provider], loggedIn: true } } : e))
        void check()
      }
    } catch (e) {
      setFailed({ provider, message: e instanceof Error ? e.message : 'Something went wrong.' })
    } finally {
      setBusy(null)
    }
  }

  // Someone who already has an agent connected has nothing to do here: on to
  // the optional connections, without flashing this step up for a second first.
  useEffect(() => {
    let active = true
    window.cove
      .envDetect()
      .then((status) => {
        if (!active) return
        setEnv(status)
        setChecking(false)
        const usable = AGENT_PROVIDERS.filter((p) => status[p]?.installed && status[p]?.loggedIn)
        if (usable.length === 1) setProvider(usable[0])
        if (usable.length > 0) setStep(afterAgents())
      })
      .catch(() => {
        if (active) {
          setChecking(false)
          setCheckError('Could not check your agents. Try again, or skip setup for now.')
        }
      })
    return () => {
      active = false
    }
  }, [setProvider])

  if (step === 'tour') return <Tour onDone={() => setStep('connections')} />
  if (step === 'connections') return <ConnectionsStep onDone={onDone} />

  const ready = isReady(env)

  // While the probe decides, a quiet mark rather than a blank window: on a
  // first launch it takes several seconds (the intro usually covers it). No
  // card, since one that flashes up and vanishes is worse.
  if (checking && !env)
    return (
      <div className="onboarding onboarding-waiting" aria-busy="true">
        <div className="onboarding-waiting-mark" aria-hidden="true">
          <span />
        </div>
        <p>Checking your agent connections…</p>
      </div>
    )

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
            {/* The hairline keeps the dark tile's edge on a dark background. */}
            <rect
              x="0.75"
              y="0.75"
              width="94.5"
              height="94.5"
              rx="21"
              fill="url(#sa-tile)"
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="1.5"
            />
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
        <p className="onboarding-intro">
          Superagent runs on an AI agent you already have a plan for. Connect one to start; you can
          add the others later.
        </p>

        <div className="onboarding-agents">
          {AGENT_PROVIDERS.map((provider) => {
            const status = env?.[provider]
            const connected = !!status?.installed && !!status?.loggedIn
            const mine = busy?.provider === provider ? busy : null
            const error = failed?.provider === provider ? failed.message : null
            return (
              <div key={provider} className={`onboarding-agent ${connected ? 'ok' : ''}`}>
                <span className="onboarding-agent-logo">
                  <ProviderLogo provider={provider} size={20} />
                </span>
                <span className="onboarding-agent-text">
                  <span className="onboarding-agent-name">{PROVIDER_PRODUCT[provider]}</span>
                  {mine ? (
                    <span className="onboarding-agent-plan busy">
                      <span className="onboarding-spinner" />
                      {mine.what === 'install' ? `Installing… ${mine.line}` : mine.line}
                    </span>
                  ) : (
                    <span className="onboarding-agent-plan">{COPY[provider].plan}</span>
                  )}
                </span>
                {connected ? (
                  <span className="onboarding-agent-ready">
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M3.5 8.4l3 3 6-6.6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Connected
                  </span>
                ) : mine?.what === 'signin' ? (
                  <button
                    className="onboarding-agent-btn quiet"
                    onClick={() => window.cove.cancelAgentSignIn()}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    className="onboarding-agent-btn"
                    onClick={() => void connect(provider)}
                    disabled={!!busy}
                  >
                    {status?.installed ? 'Sign in' : 'Install'}
                  </button>
                )}
                {error && (
                  <span role="alert" className="onboarding-agent-error">
                    {error}
                    {!status?.installed && (
                      <>
                        {' '}
                        To install it yourself, run <code>{COPY[provider].manual}</code> and press
                        Check again.
                      </>
                    )}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        {checkError && (
          <p role="alert" className="onboarding-install-error">
            {checkError}
          </p>
        )}
        <div className="onboarding-actions">
          <button
            className="onboarding-continue"
            onClick={() => {
              const usable = AGENT_PROVIDERS.filter((p) => env?.[p].installed && env?.[p].loggedIn)
              if (usable.length === 1) setProvider(usable[0])
              setStep(afterAgents())
            }}
            disabled={!ready}
          >
            Continue
          </button>
        </div>
        <p className="onboarding-foot">
          <button
            className="onboarding-skip"
            onClick={() => {
              setFailed(null)
              void check()
            }}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
          {!ready && (
            <>
              {' · '}
              <button className="onboarding-skip" onClick={() => setStep(afterAgents())}>
                Skip for now
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
