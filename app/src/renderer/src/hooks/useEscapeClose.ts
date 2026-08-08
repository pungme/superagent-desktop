import { useEffect, useRef } from 'react'

/**
 * Open panels, innermost last. Escape only reaches the one on top, so a ticket
 * inside a list closes before the list does and the list closes before the
 * window behind it.
 */
const stack: (() => void)[] = []
let listening = false

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // Mid-composition Escape belongs to the IME, and anything that already
  // handled the key (the composer stopping the agent, a menu closing) wins:
  // React's handlers run at the root, so they get here first.
  if (e.isComposing || e.defaultPrevented) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  top()
}

/**
 * Escape closes this panel — the thing every overlay is expected to do and
 * only one of ours used to.
 *
 * Pass `enabled: false` while closing would lose something (a file with
 * unsaved edits), or pass a handler that peels one layer at a time when the
 * panel has its own nested state.
 */
export function useEscapeClose(onClose: () => void, enabled = true): void {
  // Panels pass inline arrows, so read the latest through a ref rather than
  // re-subscribing every render.
  const ref = useRef(onClose)
  useEffect(() => {
    ref.current = onClose
  })

  useEffect(() => {
    if (!enabled) return
    const handler = (): void => ref.current()
    stack.push(handler)
    if (!listening) {
      document.addEventListener('keydown', onKeyDown)
      listening = true
    }
    return () => {
      const i = stack.lastIndexOf(handler)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [enabled])
}
