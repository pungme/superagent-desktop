import { useEffect, useState } from 'react'

/**
 * The pane for a project whose agent browses in the user's real browser: that
 * tab, streamed live (Chrome's screencast), with a way to jump to the window.
 * Watch-only — to click around yourself, use the real window.
 */
export function ExternalBrowserPane({
  paneId,
  browserName,
  visible,
  onClose
}: {
  paneId: string
  browserName: string
  visible: boolean
  onClose: () => void
}): React.JSX.Element {
  const [frame, setFrame] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  // A new pane (another chat) starts blank rather than showing the last one's page.
  const [seen, setSeen] = useState(paneId)
  if (seen !== paneId) {
    setSeen(paneId)
    setFrame(null)
    setUrl('')
  }
  useEffect(() => {
    if (!visible) return
    const offFrame = window.cove.onBrowsersFrame((f) => {
      if (f.paneId === paneId) setFrame(`data:image/jpeg;base64,${f.data}`)
    })
    const offUrl = window.cove.onBrowsersUrl((u) => {
      if (u.paneId === paneId) setUrl(u.url)
    })
    window.cove.browsersWatch(paneId)
    return () => {
      window.cove.browsersUnwatch(paneId)
      offFrame()
      offUrl()
    }
  }, [paneId, visible])

  return (
    <div className="external-pane">
      <div className="external-pane-bar">
        <span className="external-pane-badge">{browserName}</span>
        <span className="external-pane-url" title={url}>
          {url && url !== 'about:blank' ? url : 'Waiting for the agent to open a page'}
        </span>
        <button className="external-pane-btn" onClick={() => void window.cove.browsersShow(paneId)}>
          Open window
        </button>
        <button className="external-pane-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="external-pane-view">
        {frame ? (
          <img src={frame} alt={`${browserName}: ${url}`} />
        ) : (
          <div className="external-pane-empty">
            The agent browses in {browserName} for this project. Its tab shows here, live, once it
            opens a page.
          </div>
        )}
      </div>
    </div>
  )
}
