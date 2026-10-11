import { useEffect, useRef, useState } from 'react'
import { nextReveal, OPEN_MS } from './stream-words'

/**
 * What to show of a reply that is being written. The text arrives in bursts;
 * this follows it at an even pace (nextReveal), a frame at a time, and goes on
 * for the moment it takes to catch up after the last of it has arrived.
 * A message that was already whole when it was drawn is simply shown.
 */
export function useArrivingText(text: string, streaming: boolean): { text: string; arriving: boolean } {
  // From where it is now: a reply already part-written when this row is drawn
  // (the chat was opened mid-turn, or the row scrolled back into view) is not
  // played again from its first word.
  const [shown, setShown] = useState(text.length)
  const [everStreamed, setEverStreamed] = useState(streaming)
  if (streaming && !everStreamed) setEverStreamed(true)
  const target = useRef(text)
  // When the reply last grew: just now means a burst may have ended mid-word.
  const grewAt = useRef(0)
  if (target.current !== text) grewAt.current = performance.now()
  target.current = text
  const live = useRef(streaming)
  live.current = streaming
  const behind = shown < text.length
  const running = everStreamed && (streaming || behind)
  useEffect(() => {
    if (!running) return
    // For someone who asked for less motion, the words simply appear.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target.current.length)
      return
    }
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const dt = now - last
      last = now
      const open = live.current && now - grewAt.current < OPEN_MS
      setShown((n) => nextReveal(n, target.current, dt, open))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running])
  // Reduced motion: never behind, so nothing is held back while it streams.
  useEffect(() => {
    if (running && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      setShown(text.length)
  }, [running, text])
  if (!running) return { text, arriving: false }
  return { text: shown >= text.length ? text : text.slice(0, shown), arriving: true }
}
