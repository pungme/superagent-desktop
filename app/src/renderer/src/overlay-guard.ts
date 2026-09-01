/**
 * Catches the next overlay that forgets it cannot win against a native view.
 *
 * The browser pane is a WebContentsView: an OS-level view the compositor stacks
 * on top of the window's entire HTML layer. It is not in the DOM, so no CSS
 * value reaches it — `z-index: 999999` on a modal still draws underneath. The
 * only way to put HTML above the pane is to take the pane away first, which is
 * what `useOverlayLock` does (main photographs the page, detaches the view, and
 * a still stands in until the overlay closes).
 *
 * That makes every overlay's correctness a thing someone has to remember, and
 * the record shows they do not: the lock existed for a long time while the
 * permission prompt, the branch menu and the intro splash all rendered without
 * it and were reported, repeatedly, as "the popup is behind the browser".
 *
 * So this watches instead of trusting. In development only, whenever an element
 * mounts that is positioned, stacked above the page, visible, and overlapping a
 * live pane while nothing holds the lock, it says so and names the element. It
 * changes no behaviour and ships as a no-op.
 */

/** Below this, an element is not trying to be an overlay. */
const Z_FLOOR = 50
/** Smaller than this and an "overlap" is a border or a rounding artefact. */
const MIN_OVERLAP = 12

function overlaps(a: DOMRect, b: DOMRect): boolean {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > MIN_OVERLAP && h > MIN_OVERLAP
}

function paneHosts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.browser-host[data-pane-id]')].filter((h) => {
    const r = h.getBoundingClientRect()
    return r.width > MIN_OVERLAP && r.height > MIN_OVERLAP
  })
}

/** The pane draws its own furniture (the frozen still, the snip crosshair) over
 *  itself on purpose. Anything sharing the pane's own subtree is not the bug. */
function belongsToPane(el: Element, host: HTMLElement): boolean {
  if (el.contains(host)) return true
  const wrapper = host.parentElement
  return !!wrapper && wrapper.contains(el)
}

function offenders(root: Element, hosts: HTMLElement[]): HTMLElement[] {
  const found: HTMLElement[] = []
  const candidates = [root, ...root.querySelectorAll('*')]
  for (const el of candidates) {
    if (!(el instanceof HTMLElement) || !el.isConnected) continue
    const style = getComputedStyle(el)
    if (style.position !== 'fixed' && style.position !== 'absolute') continue
    if (style.visibility === 'hidden' || style.display === 'none') continue
    if (Number(style.opacity) === 0) continue
    const z = Number.parseInt(style.zIndex, 10)
    if (!Number.isFinite(z) || z < Z_FLOOR) continue
    const rect = el.getBoundingClientRect()
    if (rect.width <= MIN_OVERLAP || rect.height <= MIN_OVERLAP) continue
    const hit = hosts.find((h) => !belongsToPane(el, h) && overlaps(rect, h.getBoundingClientRect()))
    if (hit) found.push(el)
  }
  return found
}

function describe(el: HTMLElement): string {
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).filter(Boolean).join('.')}` : ''
  return `${el.tagName.toLowerCase()}${cls}`
}

/**
 * Start watching. `heldLock` reports whether anything currently holds the
 * overlay lock; returns a function that stops the watch.
 */
export function startOverlayGuard(heldLock: () => boolean): () => void {
  if (!import.meta.env.DEV) return () => undefined

  const warned = new WeakSet<HTMLElement>()
  let queued: number | null = null
  let pending: Element[] = []

  const check = (): void => {
    queued = null
    const roots = pending
    pending = []
    // Styles and layout settle a frame after mount; a lock taken in an effect
    // lands in the same window. Checking synchronously reports every overlay
    // exactly once, wrongly.
    if (heldLock()) return
    const hosts = paneHosts()
    if (hosts.length === 0) return
    for (const root of roots) {
      if (!root.isConnected) continue
      for (const el of offenders(root, hosts)) {
        if (warned.has(el)) continue
        warned.add(el)
        console.error(
          `[overlay-guard] ${describe(el)} is stacked over a browser pane but nothing holds the ` +
            `overlay lock, so it will render BEHIND the page. The pane is a native view; z-index ` +
            `cannot reach it. Call useOverlayLock(<visible>) in this component.`,
          el
        )
      }
    }
  }

  const schedule = (root: Element): void => {
    pending.push(root)
    if (queued !== null) return
    // Two frames: one for layout, one for the effect that takes the lock.
    queued = window.requestAnimationFrame(() => {
      queued = window.requestAnimationFrame(check)
    })
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) if (node instanceof Element) schedule(node)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  schedule(document.body)

  return () => {
    observer.disconnect()
    if (queued !== null) window.cancelAnimationFrame(queued)
  }
}
