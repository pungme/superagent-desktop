import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../preload'
import { useStore } from '../state'
import { interpretOmnibox } from '../lib/omnibox'

interface BrowserPaneProps {
  paneId: string
  /** The workspace this pane belongs to. paneId may be workspace::chat (per-chat
      views), so workspace-level things (saved URL, sidebar badge, the browsing
      indicator) key off this, not paneId. Defaults to paneId when omitted. */
  workspaceId?: string
  partition: string
  initialUrl?: string
  visible?: boolean
  /** Code projects can dismiss the pane; a browser project *is* the pane. */
  closable?: boolean
  /**
   * Something is on top of this pane that the pane itself cannot know about —
   * on the desktop, a window stacked over the browser's. A native view paints
   * above all HTML, so the page has to stand down and let its still stand in.
   */
  occluded?: boolean
  /**
   * Changes whenever the pane may have MOVED rather than resized.
   *
   * The native view is positioned in window coordinates, and the only things
   * that re-push those coordinates are a ResizeObserver on the host and the
   * window's own resize event. Neither fires when a surface merely moves — drag
   * a desktop window and the page stayed behind at the old coordinates. There
   * is no position observer in the platform, so whoever moves the pane says so.
   */
  positionKey?: string
  /**
   * Corner radius for a pane that fills a rounded window. A native view is not
   * clipped by anything's CSS, so square corners sat inside the window's arcs
   * with a wedge of frame showing through each one. Electron's radius is
   * uniform, so the top arcs are backfilled to read square — the page meets a
   * toolbar up there, not a corner.
   */
  radius?: number
  /**
   * Fill the pane rather than simulating a desktop screen. A project preview
   * wants the simulated viewport — it is showing you a site as a visitor sees
   * it. A browser tab is not a preview of anything: it should fill its window.
   */
  fill?: boolean
}

interface Suggestion {
  kind: 'url' | 'search'
  target: string // full URL to load
  label: string // primary line
  sub?: string // secondary line (e.g. the URL under a title)
}

// Monochrome line icons for the viewport switcher (kept black/white/gray).
function DesktopIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
      <path d="M6 14h4M8 11.5V14" strokeLinecap="round" />
    </svg>
  )
}
function MobileIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.4" />
      <path d="M7 12.5h2" strokeLinecap="round" />
    </svg>
  )
}
// Desktop + phone side by side ("both"), drawn to the same weight as the others
// so it doesn't read as a dim/disabled glyph.
function BothIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="14"
      viewBox="0 0 18 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <rect x="1.3" y="3" width="9" height="7" rx="1" />
      <path d="M4 12.5h4M6 10v2.5" strokeLinecap="round" />
      <rect x="11.7" y="2.5" width="5" height="11" rx="1.2" />
      <path d="M13.4 11.5h1.6" strokeLinecap="round" />
    </svg>
  )
}
function FitIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path
        d="M2 5.5V2.5h3M11 2.5h3v3M14 10.5v3h-3M5 13.5H2v-3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Height of the omnibar when it's docked onto the desktop floating card (so the
// card reads as a self-contained browser window). Native view is pushed down by it.
const CARD_OMNIBAR_H = 40
// The omnibar floats as its own pill above the page card, with this gap between
// them — so the page is a clean rounded rectangle and the bar a separate one, no
// corner-colour masks faking a square top.
const CARD_OMNIBAR_GAP = 10
// The native view's radius is uniform (no per-corner API), HTML never paints
// over web contents, and plain native Views don't either — but sibling
// WebContentsViews DO (verified on screen: the red-box probe). So desktop mode
// rounds the page on all four corners for a real rounded bottom, and two tiny
// web-view masks painted the omnibar's colour square off the top pair — flush
// under the docked omnibar. Mobile keeps a plain radius; nothing is butted
// against a floating phone.
const PANE_RADIUS = 10

export function BrowserPane({
  paneId,
  workspaceId: workspaceIdProp,
  partition,
  initialUrl,
  visible = true,
  closable = false,
  fill = false,
  occluded = false,
  positionKey,
  radius = 0
}: BrowserPaneProps): React.JSX.Element {
  // paneId is workspace::chat for per-chat views; the workspace is the part
  // before '::'. Used for sidebar/browsing/saved-URL, which are per project.
  const workspaceId = workspaceIdProp ?? paneId.split('::')[0]
  const previewUrl = useStore((s) => s.previewUrls[paneId])
  /**
   * The latest requested URL, for the create callback below. `initialUrl` is
   * whatever this pane had last run; when the pane is re-mounted (leaving the
   * file viewer, say) that value is stale, and because browserCreate resolves
   * after the previewUrl effect has already navigated, it would clobber the
   * page you just asked for with the one before it.
   */
  const previewUrlRef = useRef<string | undefined>(previewUrl)
  // Auto-reload is a per-project preference (the idle-reload logic keys off the
  // workspace), so read/toggle it by workspace, not the per-chat pane id.
  const reloadOnIdle = useStore((s) => s.reloadOnIdle[workspaceId] ?? true)
  const setReloadOnIdle = useStore((s) => s.setReloadOnIdle)
  const browsing = useStore((s) => s.browsingWorkspaceId === workspaceId)
  const stopBrowsing = useStore((s) => s.stopBrowsing)
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  const hostRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<BrowserState>({
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false
  })
  // Tell the sidebar this project has a page on screen — whoever opened it,
  // and whether or not anything of ours started a server for it.
  const setPageUrl = useStore((s) => s.setPageUrl)
  useEffect(() => {
    setPageUrl(workspaceId, state.url || '')
    return () => setPageUrl(workspaceId, '')
  }, [workspaceId, state.url, setPageUrl])
  const [crashed, setCrashed] = useState(false)
  const [zoom, setZoom] = useState(1)
  // Host-relative rect of the simulated device screen, so an HTML card can sit
  // behind the native view and give it a floating, separated feel (shadow +
  // rounded corners on a distinct backdrop). null when not simulating (viewport
  // 'none' fills the pane). The native view draws on top; only the card's shadow
  // shows around it, which is the whole point.
  const [simFrame, setSimFrame] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  // Device simulation: 'none' fills the pane (raw); 'desktop'/'mobile' render the
  // page as a correctly-proportioned screen centered in the pane and zoomed to
  // fit — so a desktop site isn't squeezed into the narrow pane. Persisted per pane.
  const [viewport, setViewport] = useState<'none' | 'desktop' | 'mobile' | 'both'>(
    () =>
      (localStorage.getItem(`viewport:${paneId}`) as 'none' | 'desktop' | 'mobile' | 'both') ||
      (fill ? 'none' : 'desktop')
  )
  // syncBounds reads the mode through this ref so it can stay stable (deps: paneId
  // only) — otherwise recreating it on every mode change would re-run the pane's
  // setup effect and re-navigate to the initial URL.
  const viewportRef = useRef(viewport)
  // A local document (PDF/image opened from the file tree) is for READING — the
  // miniature simulated desktop is the wrong frame for it, so it fills the pane
  // regardless of the saved viewport. Picking a viewport manually overrides.
  const docModeRef = useRef(false)
  // In "Fit" (none) mode the page defaults to zoomed-out-to-width so a desktop site
  // isn't cramped in a narrow pane; a manual zoom (⌘±/buttons) turns this off until
  // the user re-picks Fit. Desktop/Mobile own their own zoom, so this only matters
  // for Fit.
  const autoFitRef = useRef(true)
  const pickViewport = (v: 'none' | 'desktop' | 'mobile' | 'both'): void => {
    docModeRef.current = false // explicit choice wins over the document default
    localStorage.setItem(`viewport:${paneId}`, v)
    viewportRef.current = v
    autoFitRef.current = true // re-fit whenever a mode is (re)selected
    setViewport(v)
  }
  // Where the native view currently sits inside the host, and a still of it held
  // while an HTML overlay is up.
  const [viewRect, setViewRect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [frozen, setFrozen] = useState<string | null>(null)
  // The freeze-frame is a blob object URL; it's revoked when replaced, but a pane
  // can unmount while still frozen (covered/away, then a chat or workspace switch)
  // — revoke the last one on unmount so it isn't leaked. (Ref, so the unmount
  // cleanup sees the current value rather than the mount-time null.)
  const frozenRef = useRef<string | null>(null)
  useEffect(() => {
    frozenRef.current = frozen
  }, [frozen])
  useEffect(
    () => () => {
      if (frozenRef.current) URL.revokeObjectURL(frozenRef.current)
    },
    []
  )
  // Page-coloured DOM backfills for the top corners (desktop mode): the rounded
  // top arcs reveal these instead of the grey card, so the top reads square.
  const [cornerFill, setCornerFill] = useState<{
    left: string
    right: string
    bottom: string
  } | null>(null)
  // Phone card of the side-by-side mode.
  const [twinFrame, setTwinFrame] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [addressInput, setAddressInput] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestIndex, setSuggestIndex] = useState(-1)
  const [showSuggest, setShowSuggest] = useState(false)
  const focusedRef = useRef(false)
  const suggestSeqRef = useRef(0)
  const pendingNavRef = useRef<string | null>(null)
  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  // An open slide-over/modal must not be covered by the native browser view.
  const overlayOpen = useStore((s) => s.overlayCount > 0)
  const overlayRef = useRef(overlayOpen)
  useEffect(() => {
    overlayRef.current = overlayOpen
  }, [overlayOpen])

  // Read through a ref: syncBounds is a dependency of half the effects in here,
  // and rebuilding it on a prop that only ever changes once is not worth it.
  const radiusRef = useRef(radius)
  useEffect(() => {
    radiusRef.current = radius
  }, [radius])

  /**
   * Whether something is covering this pane. Declared here because syncBounds
   * reads it, and kept in step with paneCovered further down.
   */
  const coveredRef = useRef(false)

  const syncBounds = useCallback((): void => {
    // Don't position the native view while this workspace is hidden (it would
    // overlay the active one), while an HTML overlay is open (it would cover
    // it), or while the pane is covered by something else.
    //
    // That last one is what made every stacking fix temporary. Pushing bounds
    // re-attaches a detached view — that is how a pane comes back when you
    // return to it — so a covered pane that pushed bounds for any reason (a
    // resize tick, a window being dragged, a resync) undid its own freeze and
    // reappeared on top, at whatever bounds it last worked out. The freeze
    // must therefore hold the position too, not just the picture.
    if (!visibleRef.current || overlayRef.current || coveredRef.current) return
    const host = hostRef.current
    if (!host) return
    const r = host.getBoundingClientRect()
    const x0 = Math.round(r.x)
    const y0 = Math.round(r.y)
    const W = Math.round(r.width)
    const H = Math.round(r.height)
    const emit = (b: { x: number; y: number; width: number; height: number }): void => {
      // Host-relative copy for the freeze-frame still (see the overlay effect).
      setViewRect({ left: b.x - x0, top: b.y - y0, width: b.width, height: b.height })
      window.cove.browserSetBounds(paneId, b)
    }
    // WebContentsView bounds are window-relative CSS pixels.
    const mode = docModeRef.current ? 'none' : viewportRef.current
    if (mode !== 'both') {
      setTwinFrame(null)
      window.cove.browserTwinBounds?.(paneId, null, 1)
    }
    if (mode === 'none') {
      setSimFrame(null)
      // "Fit": fill the pane, but default to zooming out so a 1280-wide desktop
      // layout fits the pane width (not a cramped 1:1 render). A manual zoom
      // (autoFit off) is respected instead.
      if (autoFitRef.current && W > 0) window.cove.browserSetZoom?.(paneId, W / 1280)
      // The page fills the pane edge to edge: square (Electron can't reliably
      // round a WebContentsView's bottom) and to the full height — no radius, and
      // no bottom inset, which used to leave a strip of backdrop under the page.
      window.cove.browserSetRadius?.(paneId, 0)
      emit({ x: x0, y: y0, width: W, height: H })
      return
    }
    // Zooming out widens the page's layout viewport (window.innerWidth = px / zoom).
    // Optional-chained: during a preload/renderer hot-reload desync browserSetZoom
    // may be missing, and a throw here (inside an effect) would unmount the app.
    if (mode === 'desktop') {
      // Simulate a real 16:10 desktop screen (1440×900), scaled to fit INSIDE a
      // margin so the backdrop + shadow wrap it on every side — it reads as a
      // separate, floating screen rather than a page flush to the pane edges.
      const PAD = 22
      const [dw, dh] = [1440, 900]
      const scale = Math.min((W - PAD * 2) / dw, (H - PAD * 2) / dh)
      const sw = Math.round(dw * scale)
      const sh = Math.round(dh * scale)
      const left = Math.round((W - sw) / 2)
      const top = Math.round((H - sh) / 2)
      window.cove.browserSetZoom?.(paneId, scale)
      setSimFrame({ left, top, width: sw, height: sh })
      // The omnibar floats as a separate pill above; the page card starts below
      // it plus the gap, and is rounded on all four corners (no top masks).
      window.cove.browserSetRadius?.(paneId, PANE_RADIUS)
      emit({
        x: x0 + left,
        y: y0 + top + CARD_OMNIBAR_H + CARD_OMNIBAR_GAP,
        width: sw,
        height: sh - CARD_OMNIBAR_H - CARD_OMNIBAR_GAP
      })
      return
    }
    if (mode === 'both') {
      // Desktop card on the left (with its docked omnibar), phone on the right —
      // one page, two engines, URL-synced from the desktop side.
      const PAD = 18
      const GAP = 16
      const [dw, dh] = [1440, 900]
      const [lw, lh] = [390, 844]
      // Phone gets its natural share of the width at equal height scale.
      const usableH = H - PAD * 2
      const phoneScale = Math.min(usableH / lh, ((W - PAD * 2 - GAP) * 0.24) / lw)
      const pw = Math.round(lw * phoneScale)
      const ph = Math.round(lh * phoneScale)
      const deskW = W - PAD * 2 - GAP - pw
      const scale = Math.min(deskW / dw, usableH / dh)
      const sw = Math.round(dw * scale)
      const sh = Math.round(dh * scale)
      const left = PAD
      const top = Math.round((H - sh) / 2)
      const ptop = Math.round((H - ph) / 2)
      const pleft = left + sw + GAP
      window.cove.browserSetZoom?.(paneId, scale)
      window.cove.browserSetRadius?.(paneId, PANE_RADIUS)
      setSimFrame({ left, top, width: sw, height: sh })
      setTwinFrame({ left: pleft, top: ptop, width: pw, height: ph })
      emit({
        x: x0 + left,
        y: y0 + top + CARD_OMNIBAR_H + CARD_OMNIBAR_GAP,
        width: sw,
        height: sh - CARD_OMNIBAR_H - CARD_OMNIBAR_GAP
      })
      window.cove.browserTwinBounds?.(
        paneId,
        { x: x0 + pleft, y: y0 + ptop, width: pw, height: ph },
        phoneScale
      )
      return
    }
    // Mobile: a phone has a fixed tall aspect ratio, so it stays a centered device
    // scaled to fit inside a margin — so it floats with breathing room top/bottom
    // like the desktop card, not flush to the pane edges.
    const PAD = 22
    const [lw, lh] = [390, 844]
    const scale = Math.min((W - PAD * 2) / lw, (H - PAD * 2) / lh)
    const dw = Math.round(lw * scale)
    const dh = Math.round(lh * scale)
    const left = Math.round((W - dw) / 2)
    const top = Math.round((H - dh) / 2)
    window.cove.browserSetZoom?.(paneId, scale)
    setSimFrame({ left, top, width: dw, height: dh })
    window.cove.browserSetRadius?.(paneId, PANE_RADIUS)
    // The omnibar floats above the phone card too (added when mobile got its own
    // address bar); the page starts below the bar plus the gap.
    emit({
      x: x0 + left,
      y: y0 + top + CARD_OMNIBAR_H + CARD_OMNIBAR_GAP,
      width: dw,
      height: dh - CARD_OMNIBAR_H - CARD_OMNIBAR_GAP
    })
  }, [paneId])

  // Layout keeps settling for a frame or two after a trigger — the toolbar
  // reflowing, a font landing, the entrance easing. A single sync can land
  // mid-settle and pin the native view a few px off its final spot, with nothing
  // to correct it: a ResizeObserver fires on the host's SIZE changing, not when
  // the host merely SHIFTS (the toolbar above it growing/shrinking moves it
  // without resizing it). Re-measure across the next frames and a short delay so
  // the settled position always wins. syncBounds early-returns when hidden or
  // covered, so a late tick after unmount is harmless.
  const syncBoundsSettled = useCallback((): void => {
    syncBounds()
    requestAnimationFrame(() => {
      syncBounds()
      requestAnimationFrame(syncBounds)
    })
    window.setTimeout(syncBounds, 220)
  }, [syncBounds])

  // The omnibox dropdown is HTML and nothing renders above the native view, so
  // while it's open the pane freezes (same trick as modals): the dropdown floats
  // over a still of the page instead of shoving the live page down.
  const suggestOpen = showSuggest && suggestions.length > 0
  const suggestRef = useRef<HTMLDivElement>(null)

  /**
   * While the user is in another app the live view is taken out of the window
   * (an attached view asks for focus when a page loads, and macOS then pulls the
   * whole app forward). Rather than leave a hole, freeze: the same capture the
   * overlays use stands in, so the pane still looks like the page from across
   * the desk, and the live view returns the moment the window is focused again.
   */
  const [away, setAway] = useState(false)
  useEffect(() => {
    return window.cove.onAppFocus?.((focused) => setAway(!focused))
  }, [])

  const paneCovered = overlayOpen || suggestOpen || away || occluded
  useEffect(() => {
    coveredRef.current = paneCovered
  }, [paneCovered])

  // Follow the page's corner colour: once immediately, then a lazy tick — catches
  // navigations, theme flips and repaints without chasing every frame.
  useEffect(() => {
    if (!visible || paneCovered || (viewport === 'none' && !radius)) return
    let alive = true
    const tick = async (): Promise<void> => {
      const c = await window.cove.browserSampleCorners?.(paneId)
      if (alive && c) setCornerFill(c)
    }
    void tick()
    const t = window.setInterval(() => void tick(), 1200)
    // Navigations shouldn't wait for the next lazy tick — burst a few quick
    // samples so the corners match the new page almost immediately.
    const offState = window.cove.onBrowserState?.(paneId, () => {
      for (const ms of [120, 450, 1000]) window.setTimeout(() => void tick(), ms)
    })
    return () => {
      alive = false
      window.clearInterval(t)
      offState?.()
    }
  }, [visible, paneCovered, viewport, paneId, radius])

  // Show/hide the native view as this workspace becomes active/inactive or as an
  // HTML overlay opens/closes over it; re-sync when the dropdown opens/closes so
  // its top-clip is applied or removed.
  useEffect(() => {
    if (visible && !paneCovered) syncBoundsSettled()
    else if (!visible) window.cove.browserHide(paneId)
    // The covered case is handled below, so the page can be frozen before it goes.
  }, [visible, paneCovered, paneId, syncBoundsSettled, positionKey])

  // Overlay opening: one IPC — main photographs the page and detaches the view
  // in the same handler, then the still stands in (~20 ms later). Detaching must
  // never wait on a renderer round-trip: the native view composites above ALL
  // HTML, so every frame it lingers is a frame the modal sits invisible under it.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    if (paneCovered) {
      window.cove
        .browserFreeze?.(paneId)
        .then((shot) => {
          if (cancelled || !shot || !shot.length) return
          setFrozen((prev) => {
            if (prev) URL.revokeObjectURL(prev)
            return URL.createObjectURL(new Blob([new Uint8Array(shot)], { type: 'image/jpeg' }))
          })
        })
        .catch(() => window.cove.browserHide(paneId))
    } else if (frozen) {
      // Drop the still a frame after the live view is back, never before.
      requestAnimationFrame(() => {
        if (cancelled) return
        setFrozen((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return null
        })
      })
    }
    return () => {
      cancelled = true
    }
    // `frozen` is deliberately out of the deps: it's an output of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneCovered, visible, paneId])

  // Re-apply on mode change. Leaving simulation restores 100% first (the sim left
  // a fit-to-pane zoom applied); then reposition/zoom for the newly selected mode.
  useEffect(() => {
    if (viewport === 'none') window.cove.browserZoom(paneId, 'reset')
    syncBoundsSettled()
  }, [viewport, paneId, syncBoundsSettled])

  useEffect(() => {
    let alive = true
    const offState = window.cove.onBrowserState(paneId, (s) => {
      setState(s)
      // Remember where this pane is, so a code project's preview can come back
      // after an app restart (browser projects use workspace.browserUrl instead).
      if (/^(https?|file):/.test(s.url)) localStorage.setItem(`paneUrl:${paneId}`, s.url)
      const isDoc =
        s.url.startsWith('file://') &&
        /\.(pdf|png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(s.url.split('?')[0])
      if (isDoc !== docModeRef.current) docModeRef.current = isDoc
      // A fresh load means the page recovered — drop any stale crash overlay.
      if (s.loading) setCrashed(false)
      // Re-assert the simulated size/zoom once a navigation settles (a page load
      // can reset the native view's zoom factor).
      else syncBounds()
    })
    const offCrash = window.cove.onBrowserCrashed(paneId, () => setCrashed(true))
    // Keep the zoom label in sync when the ⌘+/-/0 keys zoom the native pane.
    const offZoom = window.cove.onBrowserZoom(paneId, setZoom)

    window.cove.browserCreate(paneId, partition).then((currentUrl) => {
      if (!alive) return
      syncBoundsSettled()
      // A pane that already has a page loaded is one that was merely hidden (e.g.
      // when you switched to a chat with the browser closed) and is now back.
      // Leave it exactly as it was — re-navigating would reload it and throw away
      // any manual browsing. Only a genuinely fresh pane ('') gets navigated.
      if (currentUrl) return
      // A URL to load, or the themed "new tab" empty state — but only for browser
      // projects. A code preview with no URL stays blank (as before) so it never
      // renders an out-of-place "type a URL" page floating over the chat.
      const target = previewUrlRef.current ?? initialUrl
      if (target) window.cove.browserNavigate(paneId, target)
      else if (!closable) window.cove.browserShowEmpty(paneId)
    })

    const host = hostRef.current
    const ro = new ResizeObserver(syncBounds)
    if (host) ro.observe(host)
    window.addEventListener('resize', syncBounds)

    return () => {
      alive = false
      ro.disconnect()
      window.removeEventListener('resize', syncBounds)
      offState()
      offCrash()
      offZoom()
      window.cove.browserHide(paneId)
    }
  }, [paneId, partition, initialUrl, closable, syncBounds, syncBoundsSettled])

  // Main detaches panes while the user is in another app (so a loading page
  // can't pull the window forward). When they come back it asks for a re-sync;
  // pushing bounds re-attaches this pane — and only panes still mounted here.
  useEffect(() => {
    return window.cove.onBrowserResync(() => syncBoundsSettled())
  }, [syncBoundsSettled])

  // The pane's entrance animation (pane-in / browser-frame-in) transforms an
  // ancestor of the host. getBoundingClientRect includes transforms, so any
  // bounds sync during those ~0.24s measures a shifted, scaled rect and pins the
  // native view off-position — and nothing re-measures once the transform clears,
  // so it stays misaligned (a page sitting a few px low, slightly inset). Re-sync
  // the instant the entrance finishes, when the ancestor is back at its real spot.
  useEffect(() => {
    const onEnd = (e: AnimationEvent): void => {
      if (e.animationName !== 'pane-in' && e.animationName !== 'browser-frame-in') return
      const host = hostRef.current
      if (host && e.target instanceof Node && e.target.contains(host)) syncBoundsSettled()
    }
    document.addEventListener('animationend', onEnd)
    return () => document.removeEventListener('animationend', onEnd)
  }, [syncBoundsSettled])

  // Navigate when a preview URL is requested (e.g. clicking a port chip, opening
  // a file). The INITIAL page is loaded by the create effect, which leaves an
  // already-loaded page untouched — so this effect must not re-fire the stored
  // preview URL on mount. Otherwise a pane that was merely hidden and restored
  // (now common, since each chat shows its own surface) snaps back to whatever
  // was last opened here — e.g. a PDF you opened once reappearing every time the
  // pane remounts, yanking you off the page you were actually browsing.
  const previewNavReady = useRef(false)
  useEffect(() => {
    if (!previewNavReady.current) {
      previewNavReady.current = true
      return
    }
    if (previewUrl) window.cove.browserNavigate(paneId, previewUrl)
  }, [paneId, previewUrl])

  useEffect(() => {
    previewUrlRef.current = previewUrl
  })

  // Mirror the real page URL into the bar — but only on an actual URL change and
  // only while the user isn't editing, so typed text never flickers to a stale value.
  useEffect(() => {
    pendingNavRef.current = null
    if (!focusedRef.current) setAddressInput(state.url)
  }, [state.url])

  // Record real navigations for omnibar autocomplete.
  useEffect(() => {
    if (state.url) window.cove.historyRecord(state.url, state.title)
  }, [state.url, state.title])

  // Remember the last page so the preview restores it next launch. Debounced.
  // Only for BROWSER projects: their pane is the workspace, so one workspace-level
  // browserUrl is right. A code project's pane is per-chat (paneId = ws::chat) and
  // each chat keeps its own page in paneUrl:<paneId> above — writing a single
  // workspace-level browserUrl here would clobber every chat's page with whichever
  // one navigated last, and restore them all to it on a cold start.
  useEffect(() => {
    if (closable) return // closable === true means a code project (not browser)
    if (!/^https?:\/\//i.test(state.url)) return
    const t = setTimeout(() => {
      window.cove.updateWorkspace(workspaceId, { browserUrl: state.url })
    }, 1000)
    return () => clearTimeout(t)
  }, [state.url, paneId, closable, workspaceId])

  const doZoom = async (action: 'in' | 'out' | 'reset'): Promise<void> => {
    autoFitRef.current = false // manual zoom wins over Fit's auto zoom-to-width
    setZoom(await window.cove.browserZoom(paneId, action))
  }

  const go = (target: string): void => {
    // Show the destination immediately and hold it until the page actually loads
    // (the state.url effect clears pendingNav), so the bar doesn't blink backwards.
    pendingNavRef.current = target
    setAddressInput(target)
    window.cove.browserNavigate(paneId, target)
    setShowSuggest(false)
    setSuggestIndex(-1)
    inputRef.current?.blur()
  }

  const refreshSuggestions = async (text: string): Promise<void> => {
    const seq = ++suggestSeqRef.current
    const primary = interpretOmnibox(text)
    const out: Suggestion[] = []
    if (primary) {
      out.push(
        primary.kind === 'search'
          ? { kind: 'search', target: primary.target, label: `Search Google for “${text.trim()}”` }
          : { kind: 'url', target: primary.target, label: text.trim() }
      )
    }
    const hist = text.trim() ? await window.cove.historySearch(text.trim()).catch(() => []) : []
    // Drop results from a superseded keystroke so suggestions can't flicker back.
    if (seq !== suggestSeqRef.current) return
    for (const h of hist) {
      if (out.some((s) => s.target === h.url)) continue
      out.push({ kind: 'url', target: h.url, label: h.title || h.url, sub: h.url })
      if (out.length >= 7) break
    }
    setSuggestions(out)
    setSuggestIndex(-1)
    setShowSuggest(out.length > 0)
  }

  const onAddressKeyDown = (e: React.KeyboardEvent): void => {
    if (showSuggest && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggestIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggestIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
    }
    if (e.key === 'Enter') {
      const picked = suggestIndex >= 0 ? suggestions[suggestIndex] : interpretOmnibox(addressInput)
      if (picked) go(picked.target)
    } else if (e.key === 'Escape') {
      // Claim it, so dismissing the omnibox does not also close a panel behind.
      e.preventDefault()
      setShowSuggest(false)
      inputRef.current?.blur()
    }
  }

  // Desktop viewport docks the omnibar onto the floating card's top strip, so the
  // card reads as a self-contained browser window (the letterbox space sits above).
  // Absolute for the whole desktop mode (not just once simFrame is known) so the
  // host stays full-height when syncBounds measures it — otherwise the omnibar
  // flipping out of flow would resize the host and misplace the card by one frame.
  const onCard = viewport === 'desktop' || viewport === 'both' || viewport === 'mobile'
  const toolbarStyle: React.CSSProperties | undefined = onCard
    ? simFrame
      ? {
          position: 'absolute',
          left: simFrame.left,
          top: simFrame.top,
          width: simFrame.width,
          height: CARD_OMNIBAR_H
        }
      : { position: 'absolute', left: 0, top: 0, width: '100%', height: CARD_OMNIBAR_H }
    : undefined

  return (
    <div className="browser-pane">
      <div className={`browser-toolbar ${onCard ? 'on-card' : ''}`} style={toolbarStyle}>
        {state.loading && <span className="browser-loadbar" />}
        <button
          className="browser-nav-btn"
          disabled={!state.canGoBack}
          onClick={() => window.cove.browserBack(paneId)}
          title="Back"
        >
          ‹
        </button>
        <button
          className="browser-nav-btn"
          disabled={!state.canGoForward}
          onClick={() => window.cove.browserForward(paneId)}
          title="Forward"
        >
          ›
        </button>
        <button
          className={`browser-nav-btn browser-reload-btn ${state.loading ? 'loading' : ''}`}
          onClick={() =>
            state.loading ? window.cove.browserStop?.(paneId) : window.cove.browserReload(paneId)
          }
          title={state.loading ? 'Stop loading' : 'Reload'}
        >
          {/* The reload glyph spins while the page loads — the unmistakable "it's
              working" signal even for a fast reload; on hover it becomes × to
              stop. Idle: a plain reload arrow. */}
          <span className="browser-reload-glyph">⟳</span>
          <span className="browser-reload-stop">×</span>
        </button>
        <div className="browser-omnibox">
          <input
            ref={inputRef}
            className="browser-address"
            value={addressInput}
            placeholder="Search or enter a URL"
            spellCheck={false}
            autoComplete="off"
            onFocus={(e) => {
              focusedRef.current = true
              // A new edit starts fresh — don't let a stale in-flight target linger.
              pendingNavRef.current = null
              e.target.select()
              refreshSuggestions(addressInput)
            }}
            onBlur={() => {
              focusedRef.current = false
              // Delay so a mousedown on a suggestion still registers.
              setTimeout(() => setShowSuggest(false), 120)
              // Revert to the current URL, unless a navigation is in flight (then
              // keep showing where we're headed until it loads).
              setAddressInput(pendingNavRef.current ?? state.url)
            }}
            onChange={(e) => {
              setAddressInput(e.target.value)
              refreshSuggestions(e.target.value)
            }}
            onKeyDown={onAddressKeyDown}
          />
          {showSuggest && suggestions.length > 0 && (
            <div className="omnibox-suggest" ref={suggestRef}>
              {suggestions.map((s, idx) => (
                <button
                  key={s.target}
                  className={`omnibox-item ${idx === suggestIndex ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    go(s.target)
                  }}
                  onMouseEnter={() => setSuggestIndex(idx)}
                >
                  <span className="omnibox-icon">{s.kind === 'search' ? '🔍' : '🌐'}</span>
                  <span className="omnibox-label">{s.label}</span>
                  {s.sub && <span className="omnibox-sub">{s.sub}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Simulated screen sizes are for looking at a site you are building.
            A browser window is not previewing anything — it fills, and the
            switcher there is four buttons that only ever undo themselves. */}
        {!fill && (
          <div className="browser-viewport" role="group" title="Simulated screen size">
            <button
              className={`browser-vp-btn ${viewport === 'desktop' ? 'on' : ''}`}
              onClick={() => pickViewport('desktop')}
              title="Desktop — simulate a 1280-wide screen"
            >
              <DesktopIcon />
            </button>
            <button
              className={`browser-vp-btn ${viewport === 'both' ? 'on' : ''}`}
              onClick={() => pickViewport('both')}
              title="Both — desktop and phone side by side"
            >
              <BothIcon />
            </button>
            <button
              className={`browser-vp-btn ${viewport === 'mobile' ? 'on' : ''}`}
              onClick={() => pickViewport('mobile')}
              title="Mobile — simulate a 390-wide phone"
            >
              <MobileIcon />
            </button>
            <button
              className={`browser-vp-btn ${viewport === 'none' ? 'on' : ''}`}
              onClick={() => pickViewport('none')}
              title="None — fill the pane"
            >
              <FitIcon />
            </button>
          </div>
        )}
        {/* Manual zoom only applies when not simulating a device (the sim owns zoom). */}
        {viewport === 'none' && (
          <div className="browser-zoom">
            <button className="browser-nav-btn" onClick={() => doZoom('out')} title="Zoom out (⌘−)">
              −
            </button>
            <button
              className="browser-zoom-level"
              onClick={() => doZoom('reset')}
              title="Reset zoom (⌘0)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button className="browser-nav-btn" onClick={() => doZoom('in')} title="Zoom in (⌘+)">
              +
            </button>
          </div>
        )}
        <button
          className={`browser-nav-btn ${reloadOnIdle ? 'on' : ''}`}
          onClick={() => setReloadOnIdle(workspaceId, !reloadOnIdle)}
          title={reloadOnIdle ? 'Auto-reload when Claude finishes: on' : 'Auto-reload: off'}
        >
          ↻
        </button>
        <button
          className="browser-nav-btn"
          onClick={() => window.cove.browserOpenExternal(paneId)}
          title="Open in your browser"
        >
          ↗
        </button>
        {/* Fit mode fills edge-to-edge — no margin outside the page for a floating
            dock — so keep ✂ in the omnibar there. Card modes use the outside dock. */}
        {!onCard && (
          <button
            className="browser-nav-btn"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('cove:start-snip', { detail: { workspaceId, source: 'browser' } })
              )
            }
            title="Snip a region of this page into your message"
          >
            ✂
          </button>
        )}
        {closable && (
          <button
            // The close for the middle pane, on the pane itself — where a close
            // belongs. Set apart from the nav buttons so it reads as the way out.
            className="browser-nav-btn browser-close-btn"
            onClick={() => toggleBrowser(workspaceId, true)}
            title="Close this preview pane"
          >
            ✕
          </button>
        )}
      </div>
      <div
        ref={hostRef}
        className={`browser-host ${viewport !== 'none' ? 'sim' : ''}`}
        data-pane-id={paneId}
      >
        {simFrame && visible && (
          <div
            // Keyed by mode so switching desktop/mobile/both replays the frame's
            // ease-in (see .browser-sim-frame). Pure HTML — never touches the
            // native view.
            key={`simframe-${viewport}`}
            className="browser-sim-frame"
            style={{
              // The page card sits below the floating omnibar pill + the gap; the
              // omnibar pill (toolbarStyle) occupies the strip above it.
              left: simFrame.left,
              top: simFrame.top + CARD_OMNIBAR_H + CARD_OMNIBAR_GAP,
              width: simFrame.width,
              height: simFrame.height - CARD_OMNIBAR_H - CARD_OMNIBAR_GAP
            }}
          />
        )}
        {twinFrame && visible && (
          <div
            key={`twinframe-${viewport}`}
            className="browser-sim-frame"
            style={{
              left: twinFrame.left,
              top: twinFrame.top,
              width: twinFrame.width,
              height: twinFrame.height
            }}
          />
        )}
        {/* No corner-colour masks anymore: the omnibar floats as its own pill
            above a gap, so the page card's rounded top corners are wanted, not
            faked square. */}
        {viewport === 'none' && radius > 0 && visible && viewRect && (
          /* The page's rounded bottom: the strip the view was held back from,
             filled with the colour of the page's own bottom edge. */
          <div
            className="browser-bottom-round"
            style={{
              left: viewRect.left,
              top: viewRect.top + viewRect.height,
              width: viewRect.width,
              height: radius,
              borderRadius: `0 0 ${radius}px ${radius}px`,
              background: cornerFill?.bottom ?? 'var(--bg-content)'
            }}
          />
        )}
        {frozen && viewRect && (
          // Stand-in for the native view while an overlay is up. Corners match
          // what the compositor draws: square under the docked omnibar, rounded
          // at the bottom; a simulated phone is rounded all round.
          <img
            className="browser-frozen"
            src={frozen}
            alt=""
            style={{
              left: viewRect.left,
              top: viewRect.top,
              width: viewRect.width,
              height: viewRect.height,
              // Square in fill mode: the still stops where the view does, and
              // the strip below it is what carries the curve.
              borderRadius:
                viewport === 'desktop' ? '0 0 10px 10px' : viewport === 'mobile' ? '10px' : '0'
            }}
          />
        )}
        {browsing && (
          <div className="browsing-indicator">
            <span className="browsing-pulse" />
            Claude is browsing…
            <button className="browsing-stop" onClick={stopBrowsing}>
              Stop
            </button>
          </div>
        )}
        {crashed && (
          <div className="browser-crashed">
            <p>This page crashed.</p>
            <button
              onClick={() => {
                setCrashed(false)
                window.cove.browserReload(paneId)
              }}
            >
              Reload
            </button>
          </div>
        )}
      </div>
      {/* Floating tool dock, OUTSIDE the page card in the surrounding margin (card
          modes only — fit mode is edge-to-edge, so ✂ stays in the omnibar there).
          Never over the native view, so it can't be occluded. Room to grow more
          tools later. */}
      {onCard && (
        <div className="pane-dock">
          <button
            className="pane-dock-btn"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('cove:start-snip', { detail: { workspaceId, source: 'browser' } })
              )
            }
            title="Snip a region of this page into your message"
          >
            ✂
          </button>
        </div>
      )}
    </div>
  )
}
