import { useEffect, useState } from 'react'
import { TOUR_SEEN_KEY } from './tour-keys'
import './tour.css'
import './tour-scenes.css'

/**
 * How Superagent works, shown rather than told: five short scenes, each a
 * small animation of the app doing the thing, the same pictures the website
 * uses. Part of setting up, and there to be played again from Settings.
 */

const Lights = ({ title }: { title: string }): React.JSX.Element => (
  <div className="dq-top">
    <span className="tl r" />
    <span className="tl y" />
    <span className="tl g" />
    <span className="chrome-title">{title}</span>
  </div>
)

const Lines = ({ widths }: { widths: (number | [number, 'dk'])[] }): React.JSX.Element => (
  <>
    {widths.map((w, i) =>
      typeof w === 'number' ? (
        <span key={i} className="ln" style={{ width: `${w}%` }} />
      ) : (
        <span key={i} className="ln dk" style={{ width: `${w[0]}%` }} />
      )
    )}
  </>
)

function HomeScene(): React.JSX.Element {
  return (
    <div className="d7-desk">
      <div className="dq-win t-full">
        <Lights title="Superagent" />
        <div className="d9-body">
          <div className="d9-side">
            <div className="d9-grp">Projects</div>
            <div className="d9-row proj">landing-page</div>
            <div className="d9-row sub t1-row t1-a">
              Tighten the hero copy
              <b />
            </div>
            <div className="d9-row sub t1-row t1-b">
              Fix the flaky auth test
              <b />
            </div>
            <div className="d9-row proj">mobile-app</div>
            <div className="d9-row sub t1-row t1-c">
              Migrate to pnpm
              <b className="done" />
            </div>
            <div className="d9-row proj">shop-web</div>
          </div>
          <div className="d9-chat t1-panes">
            <div className="d9-chat t1-pane t1-pa">
              <div className="d9-ttl">
                Tighten the hero copy<small>landing-page · working</small>
              </div>
              <div className="d9-msg">Make the headline shorter.</div>
              <div className="d9-reply">
                Two lines instead of three. It is live in the pane next door.
              </div>
              <div className="t1-step">
                <i />
                Editing · Hero.tsx
              </div>
            </div>
            <div className="d9-chat t1-pane t1-pb">
              <div className="d9-ttl">
                Fix the flaky auth test<small>landing-page · working</small>
              </div>
              <div className="d9-msg">Why does login.spec fail one run in five?</div>
              <div className="d9-reply">
                It races the session cookie. Waiting for <code>/me</code> before the click fixes it.
              </div>
              <div className="t1-step">
                <i />
                Running a command · npm test
              </div>
            </div>
            <div className="d9-chat t1-pane t1-pc">
              <div className="d9-ttl">
                Migrate to pnpm<small>mobile-app · finished</small>
              </div>
              <div className="d9-msg">Move this repo to pnpm.</div>
              <div className="d9-reply">
                Done in 26 steps, 4 files changed. CI is green on its branch.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function BuildScene(): React.JSX.Element {
  return (
    <div className="d7-desk">
      <div className="dq-win t-full">
        <Lights title="Superagent — shop-web" />
        <div className="t2-body">
          <div className="t2-chat">
            <div className="d9-msg">Check that sign up still works.</div>
            <div className="dq-step t1-step t2-s1" style={{ color: 'var(--muted)' }}>
              <i />
              Opening · localhost:5173
            </div>
            <div className="dq-step t1-step t2-s2" style={{ color: 'var(--muted)' }}>
              <i />
              Clicking · Sign up
            </div>
            <div className="d9-reply t2-s3">
              It works: the form submits and the welcome page loads. I checked it on a phone width
              too.
            </div>
          </div>
          <div className="t2-page">
            <div className="t2-browser">
              <div className="t2-url">localhost:5173</div>
              <div className="t2-hero">
                <Lines
                  widths={[
                    [62, 'dk'],
                    [44, 'dk']
                  ]}
                />
                <span className="ln sm" style={{ width: '70%' }} />
                <span className="ln sm" style={{ width: '52%' }} />
                <span className="t2-cta" />
              </div>
              <div className="t2-ok">Welcome aboard ✓</div>
              <div className="t2-cursor" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function KnockScene(): React.JSX.Element {
  return (
    <div className="d7-desk">
      <div className="d7-other">
        <div className="d7-otop">
          <span className="tl r" />
          <span className="tl y" />
          <span className="tl g" />
          <span className="chrome-title">Something else you are doing</span>
        </div>
        <div className="d7-obody">
          <div className="d7-oside">
            <Lines widths={[70, 52, 64, 44]} />
          </div>
          <div className="d7-code">
            <Lines widths={[[38, 'dk'], 64, 52, 70, [30, 'dk'], 58, 44, 66, 36]} />
          </div>
        </div>
      </div>
      <div className="d7-note d7-n1">
        <span className="d7-icon">
          <i />
        </span>
        <div className="d7-txt">
          <div className="d7-hd">
            <b>Superagent</b>
            <span className="d7-time">now</span>
          </div>
          <span className="d7-kind asks">Wants you</span>
          <div className="d7-ttl">Fix the flaky auth test</div>
          <div className="d7-bd">
            Asking before it runs <code>git push</code>
          </div>
        </div>
      </div>
      <div className="d7-note d7-n2">
        <span className="d7-icon">
          <i />
        </span>
        <div className="d7-txt">
          <div className="d7-hd">
            <b>Superagent</b>
            <span className="d7-time">now</span>
          </div>
          <span className="d7-kind done">Finished</span>
          <div className="d7-ttl">Migrate to pnpm</div>
          <div className="d7-bd">26 steps, 4 files changed. CI is green on the branch.</div>
        </div>
      </div>
      <div className="d7-dock">
        <span className="d7-app" />
        <span className="d7-app" />
        <span className="d7-app sa">
          <span className="d7-badge">1</span>
        </span>
        <span className="d7-app" />
        <span className="d7-app" />
      </div>
    </div>
  )
}

function DotScene(): React.JSX.Element {
  return (
    <div className="d7-desk">
      <div className="dq-win d9-other">
        <Lights title="invoice.tsx — editor" />
        <div className="dq-code">
          <Lines
            widths={[[38, 'dk'], 64, 52, 70, [30, 'dk'], 58, 44, 66, 36, [48, 'dk'], 61, 40]}
          />
        </div>
      </div>
      <div className="dq-win d9-sa">
        <Lights title="Superagent" />
        <div className="d9-body">
          <div className="d9-side">
            <div className="d9-grp">Projects</div>
            <div className="d9-row proj">wepush</div>
            <div className="d9-row sub on">e2e test and harness</div>
            <div className="d9-row sub">Slow loads on the feed</div>
            <div className="d9-row proj">wepush-portal</div>
            <div className="d9-row sub">Pricing page copy</div>
          </div>
          <div className="d9-chat">
            <div className="d9-ttl">
              e2e test and harness<small>wepush · 2 days ago</small>
            </div>
            <div className="d9-msg">Add a harness so the checkout flow runs headless.</div>
            <div className="d9-reply">
              Done. <code>npm run e2e</code> now boots the app with a seeded shop and runs 14 flows.
            </div>
          </div>
        </div>
      </div>
      <div className="dq-panel d9-panel">
        <div className="dq-in">
          In <span className="dq-chip">Computer ▾</span>
        </div>
        <div className="d9-q">
          <span>go to the wepush chat about e2e testing</span>
        </div>
        <div className="dq-step d9-s1">
          <i />
          Looking for the chat · e2e testing wepush
        </div>
        <div className="dq-step d9-s2">
          <i />
          Opening it
        </div>
        <div className="dq-ans d9-ans">
          You’re now in <b>e2e test and harness</b>, in wepush.
        </div>
        <div className="dq-foot d9-foot">
          <span>Open in Superagent ↗</span>
          <span>Clear</span>
        </div>
      </div>
      <div className="dq-tile d9-tile">
        <i />
      </div>
    </div>
  )
}

function ComputerScene(): React.JSX.Element {
  return (
    <div className="d7-desk">
      <div className="dq-win d10-app">
        <Lights title="Invoices — October" />
        <div className="d10-bar">
          <span className="d10-btn">Filter</span>
          <span className="d10-btn">Share</span>
          <span className="d10-btn go">Export…</span>
        </div>
        <div className="d10-table">
          {[
            [40, 50, 60],
            [72, 58, 70],
            [55, 66, 52],
            [80, 44, 64],
            [62, 70, 48],
            [48, 52, 72]
          ].map((row, i) => (
            <div key={i} className={`d10-tr ${i === 0 ? 'hd' : ''}`}>
              <span className={`ln ${i === 0 ? 'dk' : ''}`} style={{ width: `${row[0]}%` }} />
              <span className={`ln ${i === 0 ? 'dk' : ''}`} style={{ width: `${row[1]}%` }} />
              <span className="ln dk" style={{ width: `${row[2]}%` }} />
            </div>
          ))}
        </div>
        <div className="d10-sheet">
          <i />
          Exported invoices-october.pdf
        </div>
      </div>
      <div className="d10-ring" />
      <div className="d10-pw">
        <Lights title="Passwords" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="d10-pwrow">
            <b />
            <span className="ln" />
            <span>•••••••</span>
          </div>
        ))}
      </div>
      <div className="dq-panel d10-panel">
        <div className="dq-in">
          In <span className="dq-chip">Computer ▾</span>
          <span style={{ marginLeft: 'auto' }}>export this month’s invoices</span>
        </div>
        <div className="d10-ask">
          Use this Mac: see the screen, click and type in your apps, for this task.
          <small>⌥ Esc stops it at any time.</small>
        </div>
        <div className="d10-btns">
          <span>Not now</span>
          <span className="yes">Allow</span>
        </div>
        <div className="d10-using">
          <span>Using your Mac</span>
          <kbd>⌥ Esc · Stop</kbd>
        </div>
        <div className="dq-step d10-s1">
          <i />
          Reading the controls · Invoices
        </div>
        <div className="dq-step d10-s2">
          <i />
          Clicking · Export…
        </div>
        <div className="dq-step d10-s3">
          <i />
          Exported invoices-october.pdf
        </div>
        <div className="d10-stop">
          <b>Stopped.</b> Passwords is on screen, and it does not look at that.
        </div>
      </div>
      <div className="dq-tile d10-tile">
        <i />
      </div>
    </div>
  )
}

interface Slide {
  id: string
  kicker: string
  beta?: boolean
  title: string
  text: React.ReactNode
  scene: () => React.JSX.Element
}

const TOUR_SLIDES: Slide[] = [
  {
    id: 'home',
    kicker: 'Your agents',
    title: 'Every chat on one rail',
    text: 'Each project keeps its own conversations, and several can work at once. A spinner means it is working, a dot means it has something for you.',
    scene: HomeScene
  },
  {
    id: 'build',
    kicker: 'A real browser, a real simulator',
    title: 'It sees what it builds',
    text: 'The agent drives the page next to the chat: it opens it, clicks, reads what happened, and checks it on a phone width. The same goes for an iPhone app in the Simulator.',
    scene: BuildScene
  },
  {
    id: 'knock',
    kicker: 'While you do something else',
    title: 'It knocks. It never barges in',
    text: 'Your window stays where it is. When an agent finishes or needs a yes, it tells you from the corner, and on your phone if you pair it.',
    scene: KnockScene
  },
  {
    id: 'dot',
    kicker: 'The dot',
    beta: true,
    title: 'Ask from anywhere',
    text: (
      <>
        A small tile in the corner of your screen, over every app. Press <kbd>⌥ Space</kbd>, or{' '}
        <kbd>⌃⌥ V</kbd> to say it out loud: a question, a job, or the app itself. “Go to the wepush
        chat about e2e testing.”
      </>
    ),
    scene: DotScene
  },
  {
    id: 'computer',
    kicker: 'Computer use',
    beta: true,
    title: 'It can use your Mac, when you let it',
    text: 'Off until you turn it on in Settings. It asks first, for the Mac and for each app, shows where it is about to click, keeps out of anything that holds your secrets, and ⌥ Esc stops it.',
    scene: ComputerScene
  }
]

export function Tour({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [at, setAt] = useState(0)
  const slide = TOUR_SLIDES[at]
  const last = at === TOUR_SLIDES.length - 1
  const Scene = slide.scene

  // The dot's own slide carries its switch: whether to keep it is decided
  // while looking at what it is.
  const [dotOn, setDotOn] = useState(true)
  useEffect(() => {
    void window.cove.dotEnabled?.().then((on) => setDotOn(!!on))
  }, [])

  const finish = (): void => {
    localStorage.setItem(TOUR_SEEN_KEY, '1')
    onDone()
  }
  const go = (to: number): void => setAt(Math.max(0, Math.min(TOUR_SLIDES.length - 1, to)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        if (at === TOUR_SLIDES.length - 1) {
          localStorage.setItem(TOUR_SEEN_KEY, '1')
          onDone()
        } else setAt((n) => n + 1)
      } else if (e.key === 'ArrowLeft') setAt((n) => Math.max(0, n - 1))
      else if (e.key === 'Escape') {
        localStorage.setItem(TOUR_SEEN_KEY, '1')
        onDone()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [at, onDone])

  return (
    <div className="tour" role="dialog" aria-label="How Superagent works">
      <button className="tour-skip" onClick={finish}>
        Skip
      </button>
      <div className="tour-card">
        {/* Keyed by slide, so each one's animation starts from its beginning. */}
        <div className="tour-slide" key={slide.id}>
          <div className="tour-frame" aria-hidden="true">
            <div className="tour-scene">
              <Scene />
            </div>
          </div>
          <div className="tour-kicker">
            {slide.kicker}
            {slide.beta && <span className="tour-beta">Beta</span>}
          </div>
          <h1>{slide.title}</h1>
          <p className="tour-text">{slide.text}</p>
        </div>
        <div className="tour-extra">
          {slide.id === 'dot' && (
            <label className="tour-switch">
              <input
                type="checkbox"
                checked={dotOn}
                onChange={(e) => {
                  setDotOn(e.target.checked)
                  void window.cove.setDotEnabled(e.target.checked).then(setDotOn)
                }}
              />{' '}
              Show the dot on my screen
            </label>
          )}
        </div>
        <div className="tour-dots" role="tablist" aria-label="Slides">
          {TOUR_SLIDES.map((s, i) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={i === at}
              aria-label={s.title}
              className={i === at ? 'on' : ''}
              onClick={() => go(i)}
            />
          ))}
        </div>
        <div className="tour-actions">
          {at > 0 && (
            <button className="tour-btn quiet" onClick={() => go(at - 1)}>
              Back
            </button>
          )}
          <button className="tour-btn" onClick={() => (last ? finish() : go(at + 1))}>
            {last ? 'Get started' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
