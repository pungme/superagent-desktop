import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TOUR_SEEN_KEY } from './tour-keys'
import homeClip from './clips/home.mp4'
import homePoster from './clips/home.jpg'
import buildClip from './clips/build.mp4'
import buildPoster from './clips/build.jpg'
import splitClip from './clips/split.mp4'
import splitPoster from './clips/split.jpg'
import routinesClip from './clips/routines.mp4'
import routinesPoster from './clips/routines.jpg'
import './tour.css'
import './tour-scenes.css'

/**
 * How Superagent works, shown rather than told. What happens in the window is
 * a short silent recording of the app itself; what happens outside it (a
 * notification, the phone, the dot, the Mac) is a small moving drawing. Part
 * of setting up, and there to be played again from Settings.
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
            {/* What you are doing goes on: the line you are typing grows. */}
            <span className="ln dk d7-typing" />
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
          <span className="d7-badge">
            <span className="d7-count">
              <span>1</span>
              <span>2</span>
            </span>
          </span>
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
      <div className="d9-keys">
        <kbd>⌥</kbd>
        <kbd>Space</kbd>
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
      <svg className="d10-cursor" viewBox="0 0 16 22" aria-hidden="true">
        <path d="M1 1v17l4.5-4.2 3 6.6 2.6-1.2-3-6.4H14z" />
      </svg>
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

function PhoneScene(): React.JSX.Element {
  return (
    <div className="d7-desk t7-desk">
      <div className="t7-phone">
        <div className="t7-island" />
        <div className="t7-banner">
          <span className="t7-app" />
          <span>
            <b>Fix the flaky auth test</b>
            Pushed. The pull request is open.
          </span>
        </div>
        <div className="t7-head">Chats</div>
        <div className="t7-row">
          Fix the flaky auth test
          <small>
            <span className="t7-was">landing-page · wants you</span>
            <span className="t7-now">landing-page · finished</span>
          </small>
        </div>
        <div className="t7-row">
          Dark mode tokens<small>design-system · working</small>
          <i className="t7-spin" />
        </div>
        <div className="t7-row">
          Migrate to pnpm<small>mobile-app · finished</small>
        </div>
        <div className="t7-sheet">
          <b>Run git push?</b>
          <span>Fix the flaky auth test wants to push its branch.</span>
          <div className="t7-btns">
            <i>Deny</i>
            <i className="yes">
              Allow
              <em className="t7-tap" />
            </i>
          </div>
        </div>
      </div>
    </div>
  )
}

const KEYS: [string, string[]][] = [
  ['Search everything', ['⌘', 'K']],
  ['New project', ['⌘', 'N']],
  ['Show or hide the preview', ['⌘', 'B']],
  ['Close the tab', ['⌘', 'W']],
  ['Settings', ['⌘', ',']],
  ['Show Superagent', ['⌃', '⌥', 'S']],
  ['The dot', ['⌥', 'Space']],
  ['Talk to it', ['⌃', '⌥', 'V']],
  ['Stop using your Mac', ['⌥', 'Esc']],
  ['Zoom in', ['⌘', '+']]
]

function KeysScene(): React.JSX.Element {
  return (
    <div className="tour-keys">
      {KEYS.map(([what, keys]) => (
        <div key={what} className="tour-key">
          <span>{what}</span>
          <kbd>
            {keys.map((k) => (
              <b key={k}>{k}</b>
            ))}
          </kbd>
        </div>
      ))}
    </div>
  )
}

/** A short silent recording of the real app (scripts/_tour-clips.mjs). */
interface Clip {
  video: string
  poster: string
}

interface Slide {
  id: string
  kicker: string
  beta?: boolean
  title: string
  text: React.ReactNode
  /** Filmed from the app where it can be; drawn where it happens outside it. */
  clip?: Clip
  scene?: () => React.JSX.Element
}

const TOUR_SLIDES: Slide[] = [
  {
    id: 'home',
    kicker: 'Your chats',
    title: 'Every chat in one list.',
    text: 'Each project keeps its own chats, and several can work at once. A spinner means a chat is working. A dot means it is done and has something for you.',
    clip: { video: homeClip, poster: homePoster }
  },
  {
    id: 'build',
    kicker: 'Browser',
    title: 'It checks its own work.',
    text: 'The agent opens your site next to the chat, clicks through it and tries it at phone size. Press ⌘B to show or hide the browser.',
    clip: { video: buildClip, poster: buildPoster }
  },
  {
    id: 'split',
    kicker: 'Split view',
    title: 'Watch several chats at once.',
    text: '⌘-click a chat in the sidebar to open it beside the one you are in. Up to eight fit in the window. Click one to type to it.',
    clip: { video: splitClip, poster: splitPoster }
  },
  {
    id: 'knock',
    kicker: 'Notifications',
    title: 'It tells you when it needs you.',
    text: 'When a chat finishes or needs your yes, a notification comes in from the corner. Whatever you are working on stays in front.',
    scene: KnockScene
  },
  {
    id: 'phone',
    kicker: 'iPhone',
    title: 'Answer from your phone.',
    text: 'Pair your iPhone in Settings › Phone. Then you can read your chats, say yes to what an agent asks, or give it the next job.',
    scene: PhoneScene
  },
  {
    id: 'routines',
    kicker: 'Routines',
    title: 'Jobs that run on a schedule.',
    text: 'Tell a chat “do this every morning”, or add a job in View › Routines. Routines run while Superagent is open.',
    clip: { video: routinesClip, poster: routinesPoster }
  },
  {
    id: 'dot',
    kicker: 'The dot',
    beta: true,
    title: 'Ask from any app.',
    text: (
      <>
        Press <kbd>⌥ Space</kbd> and type, or <kbd>⌃⌥ V</kbd> and speak: a question, a job, or “go
        to my chat about e2e tests”. It works with the window closed.
      </>
    ),
    scene: DotScene
  },
  {
    id: 'computer',
    kicker: 'Computer use',
    beta: true,
    title: 'It can use your Mac, if you let it.',
    text: 'The first time an agent needs your Mac it asks you, and again for each app. It stays out of password managers, and ⌥ Esc stops it at once.',
    scene: ComputerScene
  },
  {
    id: 'keys',
    kicker: 'Shortcuts',
    title: 'Keys worth knowing.',
    text: 'The ones that work from any app can be changed in Settings.',
    scene: KeysScene
  }
]

const reducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** A recording in the window's shape. With reduced motion, its still. */
function ClipView({ clip }: { clip: Clip }): React.JSX.Element {
  if (reducedMotion()) return <img className="tour-clip" src={clip.poster} alt="" />
  return (
    <video
      className="tour-clip"
      src={clip.video}
      poster={clip.poster}
      autoPlay
      muted
      playsInline
      loop
      disablePictureInPicture
    />
  )
}

export function Tour({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [at, setAt] = useState(0)
  const slide = TOUR_SLIDES[at]
  const last = at === TOUR_SLIDES.length - 1
  const Scene = slide.scene

  // The scenes are drawn at 960 × 565 and scaled as one piece to whatever
  // size the frame has (it follows the window).
  const frameRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const fit = (): void => el.style.setProperty('--tour-zoom', String(el.clientWidth / 960))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [at])
  // The dot's own slide carries its switch: whether to keep it is decided
  // while looking at what it is.
  const [dotOn, setDotOn] = useState(false)
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
          <div className="tour-frame" aria-hidden="true" ref={frameRef}>
            {slide.clip ? (
              <ClipView clip={slide.clip} />
            ) : (
              Scene && (
                <div className="tour-scene">
                  <Scene />
                </div>
              )
            )}
          </div>
          <div className="tour-kicker">
            {slide.kicker}
            {slide.beta && <span className="tour-beta">Beta</span>}
          </div>
          <h1>{slide.title}</h1>
          <p className="tour-text">{slide.text}</p>
        </div>
        {/* One row under the words: the slide's own switch, where you are, the way on. */}
        <div className="tour-foot">
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
    </div>
  )
}
