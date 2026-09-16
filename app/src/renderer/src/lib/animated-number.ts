import { useEffect, useRef, useState } from 'react'

/** Closes the gap to `target` by a fraction each ms — frame-rate independent,
 *  so it looks the same whether the tab is doing 30fps or 120fps. */
export function stepToward(current: number, target: number, dtMs: number, speed = 6): number {
  const factor = 1 - Math.exp((-dtMs / 1000) * speed)
  const next = current + (target - current) * factor
  return Math.abs(target - next) < 1 ? target : next
}

/**
 * A number that eases toward whatever `target` becomes, instead of jumping —
 * the live token count updates several times a second while a reply streams,
 * and each jump read as choppy rather than counting up.
 *
 * First appearance (and any decrease — tokens don't really go backwards
 * mid-turn, but if the target ever does drop, snapping reads better than
 * visibly counting down) lands immediately; every increase after that eases.
 */
export function useAnimatedNumber(target: number | null): number | null {
  const [display, setDisplay] = useState<number | null>(target)
  // Gives the tick loop below a current value to read without restarting it
  // every time target changes (it updates several times a second mid-stream).
  const targetRef = useRef(target)
  useEffect(() => {
    targetRef.current = target
  }, [target])

  // Snap instead of animating on first appearance or any decrease — adjusted
  // during render (the codebase's usual "state changed on a prop change"
  // idiom), not in an effect.
  const [seenTarget, setSeenTarget] = useState(target)
  if (seenTarget !== target) {
    setSeenTarget(target)
    if (target === null || display === null || target < display) setDisplay(target)
  }

  useEffect(() => {
    let raf = 0
    let last = 0
    const tick = (t: number): void => {
      const dt = last ? t - last : 16
      last = t
      setDisplay((d) => {
        const tgt = targetRef.current
        if (tgt === null || d === null) return tgt
        return stepToward(d, tgt, dt)
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return display
}
