import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { BrowserPane } from './BrowserPane'

interface Tab {
  id: string
  /** Where it opened, for a brand new tab. */
  initialUrl?: string
}

const KEY = 'cove.desktopTabs'
const newId = (): string => `dtab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

function load(): Tab[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as Tab[]) : []
    return list.length ? list : [{ id: newId() }]
  } catch {
    return [{ id: newId() }]
  }
}

/** Bare hostname, which is what a tab is actually called. */
function labelFor(url: string): string {
  if (!url) return 'New tab'
  try {
    const u = new URL(url)
    return u.protocol === 'file:' ? (u.pathname.split('/').pop() ?? 'File') : u.hostname.replace(/^www\./, '')
  } catch {
    return 'New tab'
  }
}

/**
 * The Browser, as an application on the desktop: real tabs over real Chromium.
 *
 * Every tab is its own pane, and all of them stay mounted — only the active
 * one is visible. That is what makes switching tabs instant and keeps a page's
 * scroll position, form state and video where you left them, rather than
 * reloading the world each time you come back to it.
 *
 * It shares the browser projects' session, so a login done in one is a login
 * everywhere.
 */
export function DesktopBrowser(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>(load)
  /**
   * Derived, not stored: load() mints a fresh id when there is nothing saved,
   * so initialising this from a second load() produced an id belonging to no
   * tab — and every pane was therefore inactive. Falling back to the first tab
   * also covers the active one being closed.
   */
  const [chosenId, setActiveId] = useState<string | null>(null)
  const activeId = chosenId && tabs.some((t) => t.id === chosenId) ? chosenId : (tabs[0]?.id ?? '')
  const pageUrls = useStore((s) => s.pageUrl)

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(tabs))
  }, [tabs])

  const openTab = (url?: string): void => {
    const t: Tab = { id: newId(), initialUrl: url }
    setTabs((cur) => [...cur, t])
    setActiveId(t.id)
  }

  const closeTab = (id: string): void => {
    setTabs((cur) => {
      const next = cur.filter((t) => t.id !== id)
      // A browser with no tabs is not a browser — the last close opens a fresh
      // one rather than leaving an empty window.
      const list = next.length ? next : [{ id: newId() }]
      if (id === activeId) {
        const i = cur.findIndex((t) => t.id === id)
        // The neighbour that took its place, the way a browser does it.
        setActiveId((list[Math.min(i, list.length - 1)] ?? list[0]).id)
      }
      return list
    })
  }

  // The agent asks for a page by name; the browser decides which tab gets it.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<{ url?: string; newTab?: boolean }>).detail
      if (!d?.url) return
      if (d.newTab) openTab(d.url)
      else window.cove.browserNavigate(activeId, d.url)
    }
    window.addEventListener('cove:desktop-browser-open', onOpen)
    return () => window.removeEventListener('cove:desktop-browser-open', onOpen)
  })

  return (
    <div className="dbrowser">
      <div className="dbrowser-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`dbrowser-tab ${t.id === activeId ? 'on' : ''}`}
            onClick={() => setActiveId(t.id)}
            title={pageUrls[t.id] || 'New tab'}
          >
            <span className="dbrowser-tab-label">{labelFor(pageUrls[t.id] ?? '')}</span>
            <button
              className="dbrowser-tab-x"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="dbrowser-new" title="New tab" onClick={() => openTab()}>
          +
        </button>
      </div>

      {/* Every tab stays mounted; only the active one is on screen. Unmounting
          would tear the page down and reload it on the way back. */}
      <div className="dbrowser-panes">
        {tabs.map((t) => (
          <div key={t.id} className={`dbrowser-pane ${t.id === activeId ? 'on' : ''}`}>
            <BrowserPane
              paneId={t.id}
              partition="persist:browser"
              initialUrl={t.initialUrl}
              visible={t.id === activeId}
              fill
            />
          </div>
        ))}
      </div>
    </div>
  )
}
