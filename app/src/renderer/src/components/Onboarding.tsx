import { useEffect, useState } from 'react'

interface OnboardingProps {
  onDone: () => void
}

type EnvStatus = { claudeInstalled: boolean; claudeVersion: string | null; loggedIn: boolean }

export function Onboarding({ onDone }: OnboardingProps): React.JSX.Element {
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  // The latest line of installer output, shown as a live status.
  const [installLine, setInstallLine] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)

  const check = async (): Promise<void> => {
    setChecking(true)
    const status = await window.cove.envDetect()
    setEnv(status)
    setChecking(false)
  }

  // One-click install via Anthropic's native installer (no npm needed), then
  // re-check so the step flips to ✓.
  const install = async (): Promise<void> => {
    setInstalling(true)
    setInstallError(null)
    setInstallLine('Downloading Claude Code…')
    try {
      const res = await window.cove.installClaude((line) => {
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
      setInstalling(false)
    }
  }

  // Runs once on mount; `checking` already starts true, so we fetch without
  // a synchronous setState in the effect body.
  useEffect(() => {
    window.cove.envDetect().then((status) => {
      setEnv(status)
      setChecking(false)
    })
  }, [])

  const ready = env?.claudeInstalled && env?.loggedIn

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
        <p className="onboarding-sub">The desktop home for Claude Code.</p>

        <p className="onboarding-intro">
          Superagent runs on <b>Claude Code</b> — Anthropic&rsquo;s AI coding agent that works on
          your own Claude subscription. New to it? These two steps get you set up.{' '}
          <a href="https://claude.com/claude-code" target="_blank" rel="noopener noreferrer">
            What&rsquo;s Claude Code? →
          </a>
        </p>

        <div className="onboarding-steps">
          <div
            className={`onboarding-step ${env?.claudeInstalled ? 'ok' : checking ? '' : 'todo'}`}
          >
            <span className="step-icon">{env?.claudeInstalled ? '✓' : checking ? '…' : '!'}</span>
            <div className="step-body">
              <strong>Claude Code installed</strong>
              {env?.claudeInstalled ? (
                <span>Version {env.claudeVersion}</span>
              ) : checking ? (
                <span>Checking…</span>
              ) : installing ? (
                <span className="onboarding-install-progress">
                  <span className="onboarding-spinner" /> {installLine || 'Installing…'}
                </span>
              ) : (
                <span>
                  Not found — install it in one click (no terminal needed).
                  <button className="onboarding-install-btn" onClick={install}>
                    Install Claude Code
                  </button>
                  {installError && (
                    <span className="onboarding-install-error">
                      {installError}
                      <br />
                      Or run it yourself:{' '}
                      <code>curl -fsSL https://claude.ai/install.sh | bash</code>
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          <div
            className={`onboarding-step ${env?.loggedIn ? 'ok' : !env?.claudeInstalled ? 'wait' : checking ? '' : 'todo'}`}
          >
            <span className="step-icon">
              {env?.loggedIn ? '✓' : checking ? '…' : env?.claudeInstalled ? '!' : '·'}
            </span>
            <div className="step-body">
              <strong>Signed in</strong>
              {env?.loggedIn ? (
                <span>You&rsquo;re signed in and ready.</span>
              ) : env?.claudeInstalled ? (
                <span>
                  Sign in once with a Claude Pro/Max plan or API credits, then re-check.
                  <button
                    className="onboarding-install-btn"
                    onClick={() => window.cove.openClaudeLogin()}
                  >
                    Sign in
                  </button>
                  <span className="onboarding-hint">
                    Opens Terminal running <code>claude</code> — follow the prompts, then Re-check.
                  </span>
                </span>
              ) : (
                <span>Install Claude Code first.</span>
              )}
            </div>
          </div>
        </div>

        <div className="onboarding-actions">
          <button className="onboarding-recheck" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
          <button className="onboarding-continue" onClick={onDone} disabled={!ready}>
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
