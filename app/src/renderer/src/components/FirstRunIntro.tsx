import { useEffect, useRef, useState } from 'react'
import { useOverlayLock } from '../state'
import { INTRO_SEEN_KEY } from '../firstRun'

/**
 * The first launch opens on the Superagent reel — "Your agent lives in a
 * terminal. Give it a home." into the mark and "A beautiful home for your
 * agent.", then the tour of what the app does: the sidebar, the browser, dual
 * view, the phone, branches, any agent — and what it promises: open source,
 * no API key, no telemetry, just your Mac. Played silently (public/intro).
 *
 * It plays over the app while the app checks for Claude Code and Codex, which
 * takes several seconds on a first launch and used to be a blank window, then
 * dissolves into whatever is ready: the welcome card, or the app itself.
 * Once per install; Skip (or Esc/Enter/Space) ends it; reduced motion skips it.
 */

export function FirstRunIntro({ onDone }: { onDone: () => void }): React.JSX.Element | null {
  const [leaving, setLeaving] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const ended = useRef(false)
  useOverlayLock(true)

  useEffect(() => {
    const end = (): void => {
      if (ended.current) return
      ended.current = true
      localStorage.setItem(INTRO_SEEN_KEY, '1')
      setLeaving(true)
      setTimeout(onDone, 650)
    }
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow) return
      const d = e.data as { type?: string; done?: boolean }
      if (d?.type === 'superagent-intro' && d.done) end()
    }
    addEventListener('message', onMessage)
    // Never strand anyone behind it: if the page fails to load or stalls,
    // the app comes through anyway.
    const guard = setTimeout(end, 35_000)
    return () => {
      removeEventListener('message', onMessage)
      clearTimeout(guard)
    }
  }, [onDone])

  return (
    <div className={`first-run-intro${leaving ? ' leaving' : ''}`}>
      <iframe
        ref={frame}
        src="intro/intro.html"
        title="Welcome to Superagent"
        onLoad={() => frame.current?.focus()}
      />
    </div>
  )
}
