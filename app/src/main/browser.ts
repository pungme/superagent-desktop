import { BrowserWindow, WebContentsView, ipcMain, shell, app, net, session } from 'electron'
import { normalizeUrl } from './util'

// Electron's setUserAgent rewrites the UA *string* to look like Chrome, but not the
// User-Agent Client Hints: the Sec-CH-UA header still advertises bare "Chromium",
// never "Google Chrome". Bot-detection (Cloudflare) cross-checks the two, and that
// UA-says-Chrome / hints-say-Chromium mismatch is a reliable automation tell — it's
// why real, human clicks still get challenged. Add the "Google Chrome" brand (kept
// in sync with the actual Chromium major) so the hints agree with the UA string.
const partitionsHardened = new Set<string>()

function addChromeBrand(value: string): string {
  if (!value || /Google Chrome/i.test(value)) return value
  // Mirror the "Chromium";v="…" entry as a "Google Chrome" entry (same version),
  // leaving the GREASE brand ("Not_A Brand";v="99") untouched — real Chrome has all three.
  return value.replace(/"Chromium";v="([^"]+)"/i, '"Google Chrome";v="$1", "Chromium";v="$1"')
}

function hardenClientHints(partition: string): void {
  if (partitionsHardened.has(partition)) return
  partitionsHardened.add(partition)
  const ses = session.fromPartition(partition)
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase()
      if (lk === 'sec-ch-ua' || lk === 'sec-ch-ua-full-version-list') h[k] = addChromeBrand(h[k])
    }
    cb({ requestHeaders: h })
  })
}

// Latest favicon per pane, inlined as a data: URI (the app CSP allows data: but
// not remote https: images, so we fetch the bytes here rather than in the renderer).
const faviconByPane = new Map<string, string>()

async function fetchFavicon(id: string, url: string, onReady: () => void): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  try {
    const res = await net.fetch(url)
    if (!res.ok) return
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > 200_000) return // skip empty/absurd
    const type = res.headers.get('content-type') || 'image/png'
    faviconByPane.set(id, `data:${type};base64,${buf.toString('base64')}`)
    onReady()
  } catch {
    // A favicon that won't load just leaves the fallback icon — never a problem.
  }
}

// Present as plain Chrome. The default Electron UA carries "Electron/x" and the
// app-name token, which bot-detection (Cloudflare et al.) flags as automated and
// then challenges on every visit. Stripping those tokens leaves a normal Chrome UA.
function chromeUserAgent(defaultUA: string): string {
  return defaultUA
    .replace(new RegExp(` ${app.getName()}/[^ ]+`, 'i'), '')
    .replace(/ Electron\/[^ ]+/i, '')
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

interface BrowserPane {
  id: string
  view: WebContentsView
  window: BrowserWindow
  visible: boolean
}

const panes = new Map<string, BrowserPane>()

const ALLOWED_INSECURE = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * file:// is reachable only through `browser:navigate`, which our own UI calls
 * (clicking a file in the tree). It stays out of isNavigable so a remote page
 * can't reach local files via target=_blank.
 */
function isLocalFile(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:'
  } catch {
    return false
  }
}

function isNavigable(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:') return ALLOWED_INSECURE.has(u.hostname) || true // http allowed in v0 spike; tighten in M4
    return false
  } catch {
    return false
  }
}

export function createBrowserPane(window: BrowserWindow, id: string, partition: string): void {
  if (panes.has(id)) return
  hardenClientHints(partition)

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  view.setBackgroundColor('#ffffff')
  // Round the native view to match the content card (a native view isn't clipped
  // by the card's CSS border-radius, so its square corner would otherwise bleed
  // past the rounded corner). Also gives the Arc-style rounded-page look.
  view.setBorderRadius?.(10)

  const pane: BrowserPane = { id, view, window, visible: false }
  panes.set(id, pane)

  const wc = view.webContents
  wc.setUserAgent(chromeUserAgent(wc.getUserAgent()))
  const sendState = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send(`browser:state:${id}`, {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      favicon: faviconByPane.get(id)
    })
  }
  wc.on('did-navigate', sendState)
  wc.on('did-navigate-in-page', sendState)
  wc.on('page-title-updated', sendState)
  wc.on('did-start-loading', sendState)
  wc.on('did-stop-loading', sendState)
  // A page can drop its old favicon before the new one loads; clear on navigation
  // so a stale icon doesn't linger, then inline the new one when it arrives.
  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) faviconByPane.delete(id)
  })
  wc.on('page-favicon-updated', (_e, favicons) => {
    const url = favicons?.[0]
    if (url) fetchFavicon(id, url, sendState)
  })
  wc.setWindowOpenHandler(({ url }) => {
    // target=_blank etc. navigate the same pane — one browser per workspace (v1)
    if (isNavigable(url)) wc.loadURL(url)
    return { action: 'deny' }
  })
  wc.on('render-process-gone', () => {
    if (!window.isDestroyed()) window.webContents.send(`browser:crashed:${id}`)
  })
  // ⌘/Ctrl +/-/0 zoom while the native pane has focus (the renderer never sees
  // these keys then). Mirrors the toolbar buttons and reports back the new level.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return
    const key = input.key
    if (key === '=' || key === '+') {
      applyZoom(id, 'in')
      event.preventDefault()
    } else if (key === '-' || key === '_') {
      applyZoom(id, 'out')
      event.preventDefault()
    } else if (key === '0') {
      applyZoom(id, 'reset')
      event.preventDefault()
    }
  })
}

// Track the intended zoom per pane. getZoomFactor() doesn't reflect a just-set
// value within the same tick, so reading it back would drop rapid +/- clicks.
const zoomFactors = new Map<string, number>()

/** Step/reset the pane's zoom, clamp it, tell the renderer, and return the factor. */
export function applyZoom(id: string, action: 'in' | 'out' | 'reset'): number {
  const pane = panes.get(id)
  const wc = pane?.view.webContents
  if (!pane || !wc) return 1
  const cur = zoomFactors.get(id) ?? 1
  let next = action === 'reset' ? 1 : cur + (action === 'in' ? 0.1 : -0.1)
  next = Math.min(3, Math.max(0.3, Math.round(next * 10) / 10))
  zoomFactors.set(id, next)
  wc.setZoomFactor(next)
  if (!pane.window.isDestroyed()) pane.window.webContents.send(`browser:zoom:${id}`, next)
  return next
}

/**
 * Create an offscreen pane for a routine — never attached to the window, so
 * scheduled automation runs invisibly. Shares the visible pane's session
 * partition, so a login the user did by hand carries over.
 */
export function ensureOffscreenPane(window: BrowserWindow, id: string, partition: string): void {
  if (panes.has(id)) return
  hardenClientHints(partition)
  const view = new WebContentsView({
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  view.setBackgroundColor('#ffffff')
  view.setBounds({ x: -20000, y: -20000, width: 1280, height: 800 })
  view.webContents.setUserAgent(chromeUserAgent(view.webContents.getUserAgent()))
  panes.set(id, { id, view, window, visible: false })
}

export function destroyBrowserPane(id: string): void {
  const pane = panes.get(id)
  if (!pane) return
  panes.delete(id)
  zoomFactors.delete(id)
  faviconByPane.delete(id)
  hidePane(pane)
  pane.view.webContents.close()
}

function hidePane(pane: BrowserPane): void {
  if (pane.visible && !pane.window.isDestroyed()) {
    pane.window.contentView.removeChildView(pane.view)
  }
  pane.visible = false
}

export function getPaneWebContents(id: string): Electron.WebContents | undefined {
  return panes.get(id)?.view.webContents
}

export function registerBrowserIpc(): void {
  ipcMain.handle('browser:create', (e, id: string, partition: string) => {
    const window = BrowserWindow.fromWebContents(e.sender)
    if (window) createBrowserPane(window, id, partition)
  })
  ipcMain.on('browser:set-bounds', (_e, id: string, bounds: BrowserBounds) => {
    const pane = panes.get(id)
    if (!pane || pane.window.isDestroyed()) return
    if (!pane.visible) {
      pane.window.contentView.addChildView(pane.view)
      pane.visible = true
    }
    pane.view.setBounds(bounds)
  })
  ipcMain.on('browser:hide', (_e, id: string) => {
    const pane = panes.get(id)
    if (pane) hidePane(pane)
  })
  ipcMain.on('browser:navigate', (_e, id: string, rawUrl: string) => {
    const wc = getPaneWebContents(id)
    if (!wc) return
    const url = normalizeUrl(rawUrl)
    if (isNavigable(url) || isLocalFile(url)) wc.loadURL(url)
  })
  ipcMain.on('browser:back', (_e, id: string) => {
    getPaneWebContents(id)?.navigationHistory.goBack()
  })
  ipcMain.on('browser:forward', (_e, id: string) => {
    getPaneWebContents(id)?.navigationHistory.goForward()
  })
  ipcMain.on('browser:reload', (_e, id: string) => {
    getPaneWebContents(id)?.reload()
  })
  ipcMain.handle('browser:zoom', (_e, id: string, action: 'in' | 'out' | 'reset') =>
    applyZoom(id, action)
  )
  // Absolute zoom for device simulation (the renderer computes a fit-to-pane
  // factor). Deliberately does NOT broadcast a zoom event — the manual zoom label
  // must keep reflecting the user's own ⌘+/- level, not the simulator's.
  ipcMain.on('browser:set-zoom-factor', (_e, id: string, factor: number) => {
    const pane = panes.get(id)
    const wc = pane?.view.webContents
    if (!pane || !wc) return
    const f = Math.min(3, Math.max(0.2, factor))
    zoomFactors.set(id, f)
    wc.setZoomFactor(f)
  })
  ipcMain.on('browser:open-external', (_e, id: string) => {
    const url = getPaneWebContents(id)?.getURL()
    if (url) shell.openExternal(url)
  })
  ipcMain.on('browser:destroy', (_e, id: string) => destroyBrowserPane(id))
}
