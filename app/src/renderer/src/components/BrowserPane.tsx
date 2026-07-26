import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../preload'
import { useStore } from '../state'
import { interpretOmnibox } from '../lib/omnibox'

interface BrowserPaneProps {
  paneId: string
  partition: string
  initialUrl?: string
  visible?: boolean
}

interface Suggestion {
  kind: 'url' | 'search'
  target: string // full URL to load
  label: string // primary line
  sub?: string // secondary line (e.g. the URL under a title)
}

export function BrowserPane({
  paneId,
  partition,
  initialUrl,
  visible = true
}: BrowserPaneProps): React.JSX.Element {
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
  const [addressInput, setAddressInput] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestIndex, setSuggestIndex] = useState(-1)
  const [showSuggest, setShowSuggest] = useState(false)
  const focusedRef = useRef(false)
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
    // WebContentsView bounds are window-relative CSS pixels
    window.cove.browserSetBounds(paneId, {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height)
    })
  }, [paneId])

  // Show/hide the native view as this workspace becomes active/inactive, or as
  // an HTML overlay opens/closes over it.
  useEffect(() => {
    if (visible && !overlayOpen) syncBounds()
    else window.cove.browserHide(paneId)
  }, [visible, overlayOpen, paneId, syncBounds])

  useEffect(() => {
    let alive = true
    const offState = window.cove.onBrowserState(paneId, (s) => setState(s))
    const offCrash = window.cove.onBrowserCrashed(paneId, () => setCrashed(true))

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
    if (!focusedRef.current) setAddressInput(state.url)
  }, [state.url])

  // Record real navigations for omnibar autocomplete.
  useEffect(() => {
    if (state.url) window.cove.historyRecord(state.url, state.title)
  }, [state.url, state.title])

  const go = (target: string): void => {
    window.cove.browserNavigate(paneId, target)
    setShowSuggest(false)
    setSuggestIndex(-1)
    inputRef.current?.blur()
  }

  const refreshSuggestions = async (text: string): Promise<void> => {
    const primary = interpretOmnibox(text)
    const out: Suggestion[] = []
    if (primary) {
      out.push(
        primary.kind === 'search'
          ? { kind: 'search', target: primary.target, label: `Search Google for “${text.trim()}”` }
          : { kind: 'url', target: primary.target, label: text.trim() }
      )
    }
    const hist = text.trim() ? await window.cove.historySearch(text.trim()) : []
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
              e.target.select()
              refreshSuggestions(addressInput)
            }}
            onBlur={() => {
              focusedRef.current = false
              // Delay so a mousedown on a suggestion still registers.
              setTimeout(() => setShowSuggest(false), 120)
              setAddressInput(state.url)
            }}
            onChange={(e) => {
              setAddressInput(e.target.value)
              refreshSuggestions(e.target.value)
            }}
            onKeyDown={onAddressKeyDown}
          />
          {showSuggest && suggestions.length > 0 && (
            <div className="omnibox-suggest">
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
      </div>
      <div ref={hostRef} className="browser-host">
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
