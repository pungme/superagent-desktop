import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../state'
import { BrowserPane } from './BrowserPane'

interface Tab {
  /**
   * The tab's own pane id. The first tab's id is ALWAYS `basePaneId` exactly —
   * everything outside this component (reload, the ✂ freeze, the sidebar's
   * "has a page" badge, the phone's browser mirror) still keys off that one
   * id, so a chat that never opens a second tab behaves exactly as it always
   * did. Only tabs after the first get a "<basePaneId>::t<n>" id of their own.
   */
  id: string
  initialUrl?: string
}

const newTabId = (basePaneId: string): string =>
  `${basePaneId}::t${Date.now()}-${Math.random().toString(36).slice(2, 5)}`

function load(basePaneId: string, initialUrl?: string): Tab[] {
  try {
    const raw = localStorage.getItem(`browserTabs:${basePaneId}`)
    const saved = raw ? (JSON.parse(raw) as Tab[]) : []
    // The first tab must be the base pane id even if storage somehow lost it
    // (an older save, a manual edit) — restoring anything else would silently
    // move the chat's one durable browser identity onto a throwaway id.
    if (saved.length && saved[0].id === basePaneId) return saved
  } catch {
    // fall through to a fresh single tab
  }
  return [{ id: basePaneId, initialUrl }]
}

/**
 * A chat's browser, as tabs: the base pane (this chat's one durable browser
 * identity) plus however many more the user or the agent opened alongside it.
 *
 * Structurally identical to DesktopBrowser — every tab is its own
 * WebContentsView, all stay mounted, only the active one is visible — but
 * scoped to one chat instead of the whole desktop, and mirrored to main
 * (browser:tabs-report) so browser_tabs/browser_open_tab/browser_switch_tab/
 * browser_close_tab know what is open and can drive it.
 */
export function BrowserTabs({
  basePaneId,
  workspaceId,
  partition,
  initialUrl,
  visible,
  closable
}: {
  basePaneId: string
  workspaceId?: string
  partition: string
  initialUrl?: string
  visible?: boolean
  closable?: boolean
}): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>(() => load(basePaneId, initialUrl))
  const [chosenId, setChosenId] = useState<string | null>(null)
  const activeId = chosenId && tabs.some((t) => t.id === chosenId) ? chosenId : tabs[0].id
  const pageUrls = useStore((s) => s.pageUrl)
  // pageUrl is keyed by whatever BrowserPane's own workspaceId resolved to —
  // the real workspaceId for the base tab (so the sidebar's "has a page"
  // badge etc. still key off it, same as before tabs existed), the tab's own
  // id for every other tab (BrowserPane's default when workspaceId is
  // omitted). Matches the same split in the JSX below.
  const pageUrlKey = useCallback(
    (t: Tab): string => (t.id === basePaneId && workspaceId ? workspaceId : t.id),
    [basePaneId, workspaceId]
  )
  const urlOf = useCallback(
    (t: Tab): string => pageUrls[pageUrlKey(t)] ?? '',
    [pageUrls, pageUrlKey]
  )

  // A chat switch (this component keys by basePaneId, but WorkspaceView keeps
  // one mounted per chat and only shows the active one) can hand us a brand
  // new basePaneId — reload that chat's own saved tabs rather than keep
  // showing the previous chat's.
  const [seededFor, setSeededFor] = useState(basePaneId)
  if (seededFor !== basePaneId) {
    setSeededFor(basePaneId)
    setTabs(load(basePaneId, initialUrl))
    setChosenId(null)
  }

  useEffect(() => {
    localStorage.setItem(
      `browserTabs:${basePaneId}`,
      JSON.stringify(tabs.map((t) => ({ id: t.id, initialUrl: urlOf(t) || t.initialUrl })))
    )
  }, [basePaneId, tabs, urlOf])

  // Mirror the tab set to main so browser_tabs and friends (which run in the
  // main process, not this window) can see and drive it.
  const reportedRef = useRef('')
  useEffect(() => {
    const list = tabs.map((t) => ({
      id: t.id,
      url: urlOf(t),
      title: urlOf(t),
      active: t.id === activeId
    }))
    const key = JSON.stringify(list)
    if (key === reportedRef.current) return
    reportedRef.current = key
    window.cove.browserTabsReport(basePaneId, list)
  })
  useEffect(() => {
    return () => window.cove.browserTabsReport(basePaneId, [])
  }, [basePaneId])

  const openTab = (url?: string): void => {
    const t: Tab = { id: newTabId(basePaneId), initialUrl: url }
    setTabs((cur) => [...cur, t])
    setChosenId(t.id)
  }

  const closeTab = (id: string): void => {
    // The base pane is this chat's one durable browser — closing "the tab"
    // when there is only one means closing the whole pane, which the ✕ in the
    // toolbar already does; the tab strip's own ✕ only ever removes an EXTRA
    // tab, never the last one.
    if (tabs.length <= 1) return
    setTabs((cur) => {
      const i = cur.findIndex((t) => t.id === id)
      const next = cur.filter((t) => t.id !== id)
      if (id === activeId) setChosenId((next[Math.min(i, next.length - 1)] ?? next[0]).id)
      return next
    })
  }

  // browser_open_tab / browser_switch_tab / browser_close_tab, from this
  // chat's own agent — filtered to OUR basePaneId, since every open chat with
  // a browser has one of these mounted at once.
  useEffect(() => {
    return window.cove.onBrowserTabsCommand(({ basePaneId: forId, op, url, index }) => {
      if (forId !== basePaneId) return
      if (op === 'open') openTab(url)
      else if (op === 'switch') {
        const t = tabs[index ?? -1]
        if (t) setChosenId(t.id)
      } else if (op === 'close') {
        const t = tabs[index ?? -1]
        if (t) closeTab(t.id)
      }
    })
  })

  return (
    <div className="chat-browser-tabs">
      <div className="cbt-strip">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`cbt-tab ${t.id === activeId ? 'on' : ''}`}
            onClick={() => setChosenId(t.id)}
            title={urlOf(t) || 'New tab'}
          >
            <span className="cbt-tab-label">{labelFor(urlOf(t))}</span>
            {tabs.length > 1 && (
              <button
                className="cbt-tab-x"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button className="cbt-new" title="New tab" onClick={() => openTab()}>
          +
        </button>
      </div>
      <div className="cbt-panes">
        {tabs.map((t) => (
          <div key={t.id} className={`cbt-pane ${t.id === activeId ? 'on' : ''}`}>
            <BrowserPane
              paneId={t.id}
              // workspaceId scopes workspace-level things (pageUrl → this tab's
              // own label, the sidebar's "has a page" badge, reload-on-idle) —
              // only the base tab should drive those, exactly as it always
              // did. An extra tab gets its OWN id as its "workspaceId" instead
              // — BrowserPane defaults an omitted one to paneId.split('::')[0],
              // which for an id shaped like "<ws>::<chat>::t<n>" is just the
              // bare workspace id, not this tab's own id, so every extra tab
              // in the same project still collided (which was why a second
              // tab was stuck reading "New tab": its navigation kept landing
              // under the shared workspace key, not its own).
              workspaceId={t.id === basePaneId ? workspaceId : t.id}
              partition={partition}
              initialUrl={t.initialUrl}
              visible={visible && t.id === activeId}
              // "Close this preview pane" (closable's own ✕) closes the whole
              // browser surface for the chat — only the base tab should ever
              // offer that. An extra tab's own ✕ lives in the tab strip above
              // and just drops that one tab via closeTab.
              closable={t.id === basePaneId && closable}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Bare hostname, which is what a tab is actually called. Same rule as the
 *  desktop Browser's tab strip. */
function labelFor(url: string): string {
  if (!url) return 'New tab'
  try {
    const u = new URL(url)
    return u.protocol === 'file:'
      ? (u.pathname.split('/').pop() ?? 'File')
      : u.hostname.replace(/^www\./, '')
  } catch {
    return 'New tab'
  }
}
