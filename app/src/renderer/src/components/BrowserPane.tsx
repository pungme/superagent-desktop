import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../preload'

interface BrowserPaneProps {
  paneId: string
  partition: string
  initialUrl?: string
}

export function BrowserPane({ paneId, partition, initialUrl }: BrowserPaneProps): React.JSX.Element {
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

  const syncBounds = useCallback((): void => {
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
          className="browser-nav-btn"
          onClick={() => window.cove.browserOpenExternal(paneId)}
          title="Open in your browser"
        >
          ↗
        </button>
      </div>
      <div ref={hostRef} className="browser-host">
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
