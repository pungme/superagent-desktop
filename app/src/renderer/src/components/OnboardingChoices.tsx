import { useEffect, useState } from 'react'

/** Set once the choices have been put to the user, so they are asked once. */
export const CHOICES_ASKED_KEY = 'cove.choicesAsked'

/**
 * Setting up, after the tour: the few ways Superagent behaves that are worth
 * a decision rather than a default found later in Settings. What happens when
 * an account runs out, whether it keeps working with the lid closed, the dot,
 * and computer use. Each is the same switch Settings has; nothing here is
 * required, and Continue with nothing touched leaves the defaults.
 */
export function ChoicesStep({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'ask' | 'auto'>('ask')
  const [lid, setLid] = useState(false)
  const [lidError, setLidError] = useState('')
  const [hasLid, setHasLid] = useState(true)
  const [floor, setFloor] = useState(20)
  const [dot, setDot] = useState(true)
  const [computer, setComputer] = useState(false)
  const [computerOk, setComputerOk] = useState(true)

  useEffect(() => {
    void window.cove.accountsList?.().then((l) => setMode(l?.mode === 'auto' ? 'auto' : 'ask'))
    void window.cove.lidAwake?.().then((on) => setLid(!!on))
    void window.cove.hasLid?.().then((yes) => setHasLid(yes !== false))
    void window.cove.batteryFloor?.().then(setFloor)
    void window.cove.dotEnabled?.().then((on) => setDot(on !== false))
    void window.cove.computerStatus?.().then((s) => {
      setComputer(!!s?.enabled)
      setComputerOk(s?.supported !== false)
    })
  }, [])

  const done = (): void => {
    localStorage.setItem(CHOICES_ASKED_KEY, '1')
    onDone()
  }

  const toggleLid = async (on: boolean): Promise<void> => {
    setLidError('')
    setLid(on)
    const res = await window.cove.setLidAwake(on)
    if (res.ok) setLid(res.enabled)
    else {
      setLid(!on)
      setLidError(res.error)
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card choices-card">
        <p className="onboarding-sub">Step 2 of 3 · All of it can be changed in Settings</p>
        <h1>How should it behave?</h1>
        <p className="onboarding-intro">
          A few things worth deciding now. Leave them as they are and nothing surprising happens.
        </p>

        <div className="choices">
          <div className="choice">
            <div className="choice-text">
              <b>When an account runs out</b>
              <span>
                With more than one account, a chat can carry on with the next. Ask shows you the
                accounts that still have allowance; Automatic switches on its own and says so.
              </span>
            </div>
            <div className="mode-switch" role="group" aria-label="When an account runs out">
              {(['ask', 'auto'] as const).map((m) => (
                <button
                  key={m}
                  className={`mode-switch-btn ${mode === m ? 'active' : ''}`}
                  aria-pressed={mode === m}
                  onClick={() => {
                    setMode(m)
                    void window.cove.accountsSetMode(m)
                  }}
                >
                  {m === 'ask' ? 'Ask' : 'Automatic'}
                </button>
              ))}
            </div>
          </div>

          {hasLid && (
            <div className="choice">
              <div className="choice-text">
                <b>Keep working with the lid closed</b>
                <span>
                  Agents carry on when you close your MacBook. macOS asks for your password once.
                  The Mac stays awake, and warm, in a bag.
                </span>
                {lidError && (
                  <span role="alert" className="choice-error">
                    {lidError}
                  </span>
                )}
                {lid && (
                  <label className="choice-sub">
                    Let it sleep when the battery is
                    <select
                      className="settings-select"
                      aria-label="Battery level under which a closed Mac sleeps"
                      value={floor}
                      onChange={(e) =>
                        void window.cove.setBatteryFloor(Number(e.target.value)).then(setFloor)
                      }
                    >
                      <option value={0}>never mind the battery</option>
                      <option value={10}>under 10%</option>
                      <option value={20}>under 20%</option>
                      <option value={30}>under 30%</option>
                      <option value={50}>under 50%</option>
                    </select>
                  </label>
                )}
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="Keep working with the lid closed"
                  checked={lid}
                  onChange={(e) => void toggleLid(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>
          )}

          <div className="choice">
            <div className="choice-text">
              <b>
                The dot <em className="choice-beta">Beta</em>
              </b>
              <span>
                A small tile in the corner of your screen, over every app. Press ⌥ Space and ask,
                with Superagent&rsquo;s window open or closed.
              </span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                aria-label="Show the dot on my screen"
                checked={dot}
                onChange={(e) => {
                  setDot(e.target.checked)
                  void window.cove.setDotEnabled(e.target.checked).then(setDot)
                }}
              />
              <span className="switch-slider" />
            </label>
          </div>

          {computerOk && (
            <div className="choice">
              <div className="choice-text">
                <b>
                  Computer use <em className="choice-beta">Beta</em>
                </b>
                <span>
                  Lets an agent see the screen and click and type in your other apps. It asks before
                  the first time, again for each app, and ⌥ Esc stops it. macOS will ask for two
                  permissions when it is first used. Off unless you turn it on.
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="Let agents use this Mac"
                  checked={computer}
                  onChange={(e) => {
                    setComputer(e.target.checked)
                    void window.cove
                      .setComputerUse(e.target.checked)
                      .then((s) => setComputer(!!s.enabled))
                  }}
                />
                <span className="switch-slider" />
              </label>
            </div>
          )}
        </div>

        <div className="onboarding-actions">
          <button className="onboarding-continue" onClick={done}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
