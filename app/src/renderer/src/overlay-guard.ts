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
    const hit = hosts.find(
      (h) => !belongsToPane(el, h) && overlaps(rect, h.getBoundingClientRect())
    )
    if (hit) found.push(el)
  }
  return found
}

function describe(el: HTMLElement): string {
  const cls =
    el.className && typeof el.className === 'string'
      ? `.${el.className.split(/\s+/).filter(Boolean).join('.')}`
      : ''
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

/**
 * The floating things that open and close by themselves: tooltips, the menus
 * under the message box, the usage list. Each of them can reach over a browser
 * pane — a 300px tooltip in a 280px chat column does — and none of them is a
 * component with a moment to take the lock in: a tooltip is one CSS :hover.
 *
 * Only what comes and goes. Something that stays up (a banner, a toast) would
 * hold the lock for as long as it showed, and the page behind a held lock is a
 * photograph: it must not be here.
 */
const FLOATING = [
  '.easy-ctx-tip',
  '.easy-control-menu',
  '.easy-mention-menu',
  '.easy-send-menu',
  '.usage-popover',
  '.board-stage-menu',
  '.sim-menu',
  '.skills-overlay',
  '[role="tooltip"]',
  '[role="menu"]'
].join(',')

function shown(el: HTMLElement): boolean {
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  // A tooltip fading in is on its way: counting it from the first frame is
  // what gets the pane out of the way before it has finished arriving.
  if (Number(style.opacity) === 0 && !el.matches(':hover') && !el.parentElement?.matches(':hover'))
    return false
  const r = el.getBoundingClientRect()
  return r.width > MIN_OVERLAP && r.height > MIN_OVERLAP
}

/** Whether a floating element is, right now, reaching over a live pane. */
export function floatingOverPane(): boolean {
  const hosts = paneHosts()
  if (hosts.length === 0) return false
  for (const el of document.querySelectorAll<HTMLElement>(FLOATING)) {
    if (!shown(el)) continue
    const rect = el.getBoundingClientRect()
    if (hosts.some((h) => !belongsToPane(el, h) && overlaps(rect, h.getBoundingClientRect())))
      return true
  }
  return false
}

/**
 * Take the overlay lock by itself whenever a tooltip or menu reaches over a
 * browser pane, and give it back when it has gone.
 *
 * The lock was something each overlay had to remember, and the ones that are
 * not components at all could not: the Memory tooltip, the model menu and the
 * usage list were all drawn behind the page whenever the column they open from
 * was narrower than they are. This looks instead — on the events that can make
 * one appear, and a little after, for the fade.
 */
export function startAutoOverlayLock(enter: () => void, exit: () => void): () => void {
  let held = false
  let frame: number | null = null
  let later: ReturnType<typeof setTimeout> | null = null

  const check = (): void => {
    frame = null
    const over = floatingOverPane()
    if (over === held) return
    held = over
    if (over) enter()
    else exit()
  }
  const schedule = (): void => {
    if (frame === null) frame = window.requestAnimationFrame(check)
    // Again once a fade has run: a tooltip leaving is still there for a moment.
    if (later) clearTimeout(later)
    later = setTimeout(() => {
      later = null
      if (frame === null) frame = window.requestAnimationFrame(check)
    }, 200)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  const events = ['pointerover', 'pointerout', 'focusin', 'focusout', 'resize'] as const
  for (const e of events) window.addEventListener(e, schedule, true)
  // Never leave the page a photograph: whatever was missed, look again.
  const safety = setInterval(() => {
    if (held) schedule()
  }, 500)

  return () => {
    observer.disconnect()
    for (const e of events) window.removeEventListener(e, schedule, true)
    clearInterval(safety)
    if (later) clearTimeout(later)
    if (frame !== null) window.cancelAnimationFrame(frame)
    if (held) exit()
  }
}
