import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../preload'
import { useStore } from '../state'
import { interpretOmnibox } from '../lib/omnibox'

interface BrowserPaneProps {
  paneId: string
  partition: string
  initialUrl?: string
  visible?: boolean
  /** Code projects can dismiss the pane; a browser project *is* the pane. */
  closable?: boolean
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
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
      <path d="M6 14h4M8 11.5V14" strokeLinecap="round" />
    </svg>
  )
}
function MobileIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.4" />
      <path d="M7 12.5h2" strokeLinecap="round" />
    </svg>
  )
}
function FitIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path
        d="M2 5.5V2.5h3M11 2.5h3v3M14 10.5v3h-3M5 13.5H2v-3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function BrowserPane({
  paneId,
  partition,
  initialUrl,
  visible = true,
  closable = false
}: BrowserPaneProps): React.JSX.Element {
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  const previewUrl = useStore((s) => s.previewUrls[paneId])
  const reloadOnIdle = useStore((s) => s.reloadOnIdle[paneId] ?? true)
  const setReloadOnIdle = useStore((s) => s.setReloadOnIdle)
  const browsing = useStore((s) => s.browsingWorkspaceId === paneId)
  const stopBrowsing = useStore((s) => s.stopBrowsing)
  const hostRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<BrowserState>({
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false
  })
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
  const [viewport, setViewport] = useState<'none' | 'desktop' | 'mobile'>(
    () => (localStorage.getItem(`viewport:${paneId}`) as 'none' | 'desktop' | 'mobile') || 'desktop'
  )
  // syncBounds reads the mode through this ref so it can stay stable (deps: paneId
  // only) — otherwise recreating it on every mode change would re-run the pane's
  // setup effect and re-navigate to the initial URL.
  const viewportRef = useRef(viewport)
  const pickViewport = (v: 'none' | 'desktop' | 'mobile'): void => {
    localStorage.setItem(`viewport:${paneId}`, v)
    viewportRef.current = v
    setViewport(v)
  }
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

  const syncBounds = useCallback((): void => {
    // Don't position the native view while this workspace is hidden (it would
    // overlay the active one) or while an HTML overlay is open (it would cover it).
    if (!visibleRef.current || overlayRef.current) return
    const host = hostRef.current
    if (!host) return
    const r = host.getBoundingClientRect()
    const x0 = Math.round(r.x)
    const y0 = Math.round(r.y)
    const W = Math.round(r.width)
    const H = Math.round(r.height)
    // Compute the base bounds for the current viewport mode, then push the pane's
    // TOP below the omnibox suggestion dropdown when it's open — the native view
    // draws over HTML, so without this the dropdown is covered and unclickable.
    // Clipping (vs hiding the whole pane) keeps the rest of the page visible.
    const emit = (b: { x: number; y: number; width: number; height: number }): void => {
      if (suggestOpenRef.current && suggestRef.current) {
        const bottom = Math.round(suggestRef.current.getBoundingClientRect().bottom)
        if (bottom > b.y) {
          b = { x: b.x, y: bottom, width: b.width, height: Math.max(0, b.height - (bottom - b.y)) }
        }
      }
      window.cove.browserSetBounds(paneId, b)
    }
    // WebContentsView bounds are window-relative CSS pixels.
    if (viewportRef.current === 'none') {
      setSimFrame(null)
      emit({ x: x0, y: y0, width: W, height: H })
      return
    }
    // Zooming out widens the page's layout viewport (window.innerWidth = px / zoom).
    // Optional-chained: during a preload/renderer hot-reload desync browserSetZoom
    // may be missing, and a throw here (inside an effect) would unmount the app.
    if (viewportRef.current === 'desktop') {
      // Simulate a real 16:10 desktop screen (1440×900) at the correct aspect ratio,
      // scaled to fit. Fills the pane width and sits at the top, so the leftover
      // space lands at the bottom of the pane (not a stretched full-bleed page).
      const [dw, dh] = [1440, 900]
      const scale = Math.min(W / dw, H / dh)
      const sw = Math.round(dw * scale)
      const sh = Math.round(dh * scale)
      const left = Math.round((W - sw) / 2)
      window.cove.browserSetZoom?.(paneId, scale)
      setSimFrame({ left, top: 0, width: sw, height: sh })
      emit({ x: x0 + left, y: y0, width: sw, height: sh })
      return
    }
    // Mobile: a phone has a fixed tall aspect ratio, so it stays a centered device
    // scaled to fit — the side gap is the phone's shape, not wasted padding.
    const [lw, lh] = [390, 844]
    const scale = Math.min(W / lw, H / lh)
    const dw = Math.round(lw * scale)
    const dh = Math.round(lh * scale)
    const left = Math.round((W - dw) / 2)
    const top = Math.round((H - dh) / 2)
    window.cove.browserSetZoom?.(paneId, scale)
    setSimFrame({ left, top, width: dw, height: dh })
    emit({ x: x0 + left, y: y0 + top, width: dw, height: dh })
  }, [paneId])

  // The omnibox dropdown is HTML and the native view draws over HTML, so while it's
  // open the pane's top is clipped below it (in syncBounds) — read through a ref so
  // syncBounds can stay stable. suggestRef measures the dropdown's bottom edge.
  const suggestOpen = showSuggest && suggestions.length > 0
  const suggestOpenRef = useRef(suggestOpen)
  const suggestRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    suggestOpenRef.current = suggestOpen
  }, [suggestOpen])

  // Show/hide the native view as this workspace becomes active/inactive or as an
  // HTML overlay opens/closes over it; re-sync when the dropdown opens/closes so
  // its top-clip is applied or removed.
  useEffect(() => {
    if (visible && !overlayOpen) syncBounds()
    else window.cove.browserHide(paneId)
  }, [visible, overlayOpen, suggestOpen, paneId, syncBounds])

  // Re-apply on mode change. Leaving simulation restores 100% first (the sim left
  // a fit-to-pane zoom applied); then reposition/zoom for the newly selected mode.
  useEffect(() => {
    if (viewport === 'none') window.cove.browserZoom(paneId, 'reset')
    syncBounds()
  }, [viewport, paneId, syncBounds])

  useEffect(() => {
    let alive = true
    const offState = window.cove.onBrowserState(paneId, (s) => {
      setState(s)
      // A fresh load means the page recovered — drop any stale crash overlay.
      if (s.loading) setCrashed(false)
      // Re-assert the simulated size/zoom once a navigation settles (a page load
      // can reset the native view's zoom factor).
      else syncBounds()
    })
    const offCrash = window.cove.onBrowserCrashed(paneId, () => setCrashed(true))
    // Keep the zoom label in sync when the ⌘+/-/0 keys zoom the native pane.
    const offZoom = window.cove.onBrowserZoom(paneId, setZoom)

    window.cove.browserCreate(paneId, partition).then(() => {
      if (!alive) return
      syncBounds()
      if (initialUrl) window.cove.browserNavigate(paneId, initialUrl)
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
  }, [paneId, partition, initialUrl, syncBounds])

  // Navigate when a preview URL is requested (e.g. clicking a port chip).
  useEffect(() => {
    if (previewUrl) window.cove.browserNavigate(paneId, previewUrl)
  }, [paneId, previewUrl])

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

  // Remember the last page per workspace so the preview restores it on the next
  // launch (paneId is the workspace id for the visible pane). Debounced.
  useEffect(() => {
    if (!/^https?:\/\//i.test(state.url)) return
    const t = setTimeout(() => {
      window.cove.updateWorkspace(paneId, { browserUrl: state.url })
    }, 1000)
    return () => clearTimeout(t)
  }, [state.url, paneId])

  const doZoom = async (action: 'in' | 'out' | 'reset'): Promise<void> => {
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
      setShowSuggest(false)
      inputRef.current?.blur()
    }
  }

  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
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
          className="browser-nav-btn"
          onClick={() => window.cove.browserReload(paneId)}
          title="Reload"
        >
          ⟳
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
        <div className="browser-viewport" role="group" title="Simulated screen size">
          <button
            className={`browser-vp-btn ${viewport === 'desktop' ? 'on' : ''}`}
            onClick={() => pickViewport('desktop')}
            title="Desktop — simulate a 1280-wide screen"
          >
            <DesktopIcon />
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
          onClick={() => setReloadOnIdle(paneId, !reloadOnIdle)}
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
        {closable && (
          <button
            className="browser-nav-btn"
            onClick={() => toggleBrowser(paneId)}
            title="Close preview"
          >
            ✕
          </button>
        )}
      </div>
      <div ref={hostRef} className={`browser-host ${viewport !== 'none' ? 'sim' : ''}`}>
        {simFrame && visible && (
          <div
            className="browser-sim-frame"
            style={{
              left: simFrame.left,
              top: simFrame.top,
              width: simFrame.width,
              height: simFrame.height
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
    </div>
  )
}
