import { useEffect, useState } from 'react'

interface OnboardingProps {
  onDone: () => void
}

type EnvStatus = { claudeInstalled: boolean; claudeVersion: string | null; loggedIn: boolean }

export function Onboarding({ onDone }: OnboardingProps): React.JSX.Element {
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [checking, setChecking] = useState(true)

  const check = async (): Promise<void> => {
    setChecking(true)
    const status = await window.cove.envDetect()
    setEnv(status)
    setChecking(false)
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
        <div className="onboarding-logo">🌊</div>
        <h1>Welcome to Cove</h1>
        <p className="onboarding-sub">A friendly home for Claude Code.</p>

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
              ) : (
                <span>
                  Not found. Install it, then re-check:
                  <code>npm install -g @anthropic-ai/claude-code</code>
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
                  Open a terminal and run <code>claude</code> once to sign in, then re-check.
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
