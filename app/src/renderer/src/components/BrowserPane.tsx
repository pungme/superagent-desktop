import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../preload'
import { useStore } from '../state'

interface BrowserPaneProps {
  paneId: string
  partition: string
  initialUrl?: string
  visible?: boolean
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
  const [state, setState] = useState<BrowserState>({
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false
  })
  const [crashed, setCrashed] = useState(false)
  const [addressInput, setAddressInput] = useState('')
  const [editing, setEditing] = useState(false)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const syncBounds = useCallback((): void => {
    // Don't position the native view while this workspace is hidden — it would
    // overlay the active one.
    if (!visibleRef.current) return
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

  // Show/hide the native view as this workspace becomes active/inactive.
  useEffect(() => {
    if (visible) syncBounds()
    else window.cove.browserHide(paneId)
  }, [visible, paneId, syncBounds])

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

  const submitAddress = (): void => {
    if (addressInput.trim()) window.cove.browserNavigate(paneId, addressInput.trim())
    setEditing(false)
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
        <input
          className="browser-address"
          value={editing ? addressInput : state.url}
          placeholder="Enter a URL — try localhost:3000"
          onFocus={(e) => {
            setEditing(true)
            setAddressInput(state.url)
            e.target.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAddress()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
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
