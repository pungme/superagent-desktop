import { useEffect, useState } from 'react'

/**
 * Brief launch animation that plays with the Superagent mark, then dissolves into
 * the app. The mark is drawn in CSS (rounded square + inner square) from the
 * theme's accent tokens so it reads on both light and dark, and each part
 * animates independently. Plays once per launch (sessionStorage guard survives
 * HMR re-renders but resets on a real relaunch); reduced-motion gets a quick fade.
 */
export function IntroSplash(): React.JSX.Element | null {
  const [show, setShow] = useState(() => !sessionStorage.getItem('cove.introPlayed'))

  useEffect(() => {
    if (!show) return
    sessionStorage.setItem('cove.introPlayed', '1')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const t = setTimeout(() => setShow(false), reduced ? 450 : 1950)
    return () => clearTimeout(t)
  }, [show])

  if (!show) return null

  return (
    <div className="intro" aria-hidden="true">
      <div className="intro-stage">
        <div className="intro-mark">
          <span className="intro-inner" />
        </div>
        <div className="intro-word">Superagent</div>
      </div>
    </div>
  )
}
