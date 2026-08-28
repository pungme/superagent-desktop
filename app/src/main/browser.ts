import { BrowserWindow, WebContentsView, Notification, ipcMain, shell, app, net } from 'electron'
import { connect as tcpConnect } from 'net'
import { fileURLToPath } from 'url'
import { basename, join } from 'path'
import { appendFileSync, renameSync, statSync } from 'fs'
import { execFile } from 'child_process'
import { normalizeUrl, broadcastToWindows, workspaceIdFromPane } from './util'
import { getRecentHistory, getChatWorkspace, getWorkspaceKind } from './store'

// Lightweight pane-lifecycle trail for the "agent-opened pane is blank" reports —
// the bug has never reproduced on demand, so leave breadcrumbs where it happens.
// One line per event in userData/pane-debug.log, rotated once at ~512 KB.
let paneLogRotated = false
export function paneLog(event: string, id: string, detail = ''): void {
  try {
    const file = join(app.getPath('userData'), 'pane-debug.log')
    if (!paneLogRotated) {
      paneLogRotated = true
      try {
        if (statSync(file).size > 512 * 1024) renameSync(file, file + '.old')
      } catch {
        /* first run — no log yet */
      }
    }
    appendFileSync(file, `${new Date().toISOString()} ${event} ${id} ${detail}\n`)
  } catch {
    /* logging must never break browsing */
  }
}

// A browser must tell one story about who it is. Its identity shows up in three
// places — the UA string, the Sec-CH-UA request headers, and
// navigator.userAgentData in JavaScript — and a challenge (Cloudflare Turnstile)
// cross-checks them; any disagreement reads as a browser lying about itself, and
// it refuses to issue the pass, so the "verify you are human" checkbox loops
// forever even under a real human click.
//
// We used to rewrite the Sec-CH-UA header to claim "Google Chrome" — but the
// JavaScript, which we cannot change without a debugger attached, still said
// plain "Chromium". Header said Chrome, JS said Chromium: exactly the
// contradiction the check is built to catch. Measured out-of-band on a
// hand-browsed pane, that mismatch was real.
//
// So we no longer touch any of it beyond stripping "Electron" from the UA
// string. Electron IS Chromium, and left alone it says so honestly and
// consistently in all three places — a real Chromium browser, which challenges
// pass. It presents the same whether the agent is driving or you are, so its
// story never changes mid-session. Presenting an honest Chromium beats an
// inconsistent fake Chrome — and a fully consistent Chrome is out of reach
// anyway: Electron's TLS handshake lacks three post-quantum signature
// algorithms Chrome's has compiled in, which is not fixable from here.

// Latest favicon per pane, inlined as a data: URI (the app CSP allows data: but
// not remote https: images, so we fetch the bytes here rather than in the renderer).
const faviconByPane = new Map<string, string>()

async function fetchFavicon(id: string, url: string, onReady: () => void): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  try {
    // Main's own fetch announces itself as Electron. A site that has just
    // served a page to "Chrome" then sees a favicon request from Electron on
    // the same connection — which is worse than either alone, and is the kind
    // of contradiction bot detection is built to spot.
    const res = await net.fetch(url, {
      headers: { 'User-Agent': chromeUserAgent(app.userAgentFallback) }
    })
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

/**
 * The pane's only identity change: strip "Electron" from the UA string.
 *
 * Everything else is left exactly as Chromium reports it, so the UA, the
 * Sec-CH-UA headers and navigator.userAgentData all agree on their own (see the
 * note above). No debugger is attached for identity — attaching one flips
 * navigator.webdriver true and is a bot tell in itself, and a permanent one
 * also blocked the automation tools from attaching their own.
 */
function applyBrowserIdentity(wc: Electron.WebContents): void {
  wc.setUserAgent(chromeUserAgent(wc.getUserAgent()))
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
  /** Session partition, kept so the mobile twin can share logins. */
  partition: string
  /**
   * The corner radius this pane should have.
   *
   * Kept here rather than set once and forgotten: the radius is a property of
   * the native layer, and the layer is rebuilt when the view is detached and
   * re-attached (which happens whenever the pane is hidden and shown, or the
   * user leaves the app and comes back). Setting it and walking away left
   * square corners inside a rounded window.
   */
  radius: number
}

const panes = new Map<string, BrowserPane>()

// The "both" viewport's second engine: one shared mobile twin (only one pane is
// on screen at a time), same partition as its primary so logins carry over,
// URL-synced one way — the desktop side drives.
let twin: { view: WebContentsView; forPane: string; offNav: () => void } | null = null

function destroyTwin(window: BrowserWindow): void {
  if (!twin) return
  twin.offNav()
  if (!window.isDestroyed()) window.contentView.removeChildView(twin.view)
  twin.view.webContents.close()
  twin = null
}

// Sessions that already route PDF saves back to the source file.
const pdfSaveWired = new WeakSet<Electron.Session>()

/**
 * Chromium's PDF viewer can fill forms and annotate, but its edits live only in
 * the viewer — the download button is the sole way out, and by default it asks
 * where to put a COPY. When the pane is showing a local PDF, point that download
 * back at the original file instead: the viewer's ⬇ becomes a real Save.
 * Downloads from actual web pages keep the normal save dialog.
 */
function wirePdfSaveBack(ses: Electron.Session): void {
  if (pdfSaveWired.has(ses)) return
  pdfSaveWired.add(ses)
  ses.on('will-download', (_e, item, wc) => {
    try {
      const pageUrl = wc.getURL()
      if (!pageUrl.startsWith('file://') || !/\.pdf$/i.test(pageUrl.split('?')[0])) return
      if (item.getMimeType() !== 'application/pdf') return
      const target = fileURLToPath(pageUrl.split('?')[0])
      item.setSavePath(target)
      item.once('done', (_ev, state) => {
        if (!Notification.isSupported()) return
        new Notification(
          state === 'completed'
            ? { title: 'PDF saved', body: basename(target) }
            : { title: 'PDF save failed', body: `${basename(target)} — ${state}` }
        ).show()
      })
    } catch {
      // fall through to the default save dialog
    }
  })
}

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

// A themed "new tab" page loaded into a blank browser project — rendered inside
// the native view (no HTML overlay needed) and theme-aware via prefers-color-scheme.
// Recently-visited sites are shown as plain <a> links: clicking one navigates the
// native view (no IPC), which clears the empty state. Panes showing it are tracked
// so the URL bar/title report blank, not the data: URL.
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}
function emptyStateUrl(recent: { url: string; title: string }[]): string {
  const items = recent
    .map((h) => {
      const host = hostOf(h.url)
      return `<a class="site" href="${esc(h.url)}"><span class="fav"></span><span class="t">${esc(h.title || host)}</span><span class="h">${esc(host)}</span></a>`
    })
    .join('')
  const recentBlock = items
    ? `<div class="recent"><div class="lbl">Recently visited</div>${items}</div>`
    : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#fff;--fg:rgba(0,0,0,.85);--muted:#8a8a8e;--card:#f4f4f6;--line:#e6e6e9;--hover:#f2f2f4}
@media(prefers-color-scheme:dark){:root{--bg:#1e1f24;--fg:rgba(255,255,255,.86);--muted:#83848a;--card:#26272e;--line:rgba(255,255,255,.09);--hover:rgba(255,255,255,.05)}}
*{margin:0;box-sizing:border-box}html,body{height:100%}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
.wrap{text-align:center;width:min(420px,80%)}
.mark{width:64px;height:64px;border-radius:18px;background:var(--card);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;margin:0 auto 18px}
.mark svg{width:29px;height:29px;stroke:var(--muted);fill:none;stroke-width:1.5;stroke-linecap:round}
h1{font-size:17px;font-weight:600;letter-spacing:-.01em}
.sub{margin-top:6px;font-size:13px;color:var(--muted);line-height:1.5}
.recent{margin-top:26px;text-align:left}
.lbl{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 6px 8px}
.site{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;text-decoration:none;color:var(--fg)}
.site:hover{background:var(--hover)}
.fav{width:16px;height:16px;border-radius:5px;background:var(--card);border:1px solid var(--line);flex-shrink:0}
.t{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1;min-width:0}
.h{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap;flex-shrink:0;padding-left:10px}
</style></head><body><div class="wrap">
<div class="mark"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/></svg></div>
<h1>New tab</h1><div class="sub">Type a URL in the bar above — or ask the agent to open a page for you.</div>
${recentBlock}
</div></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
const emptyPanes = new Set<string>()

// A failed main-frame load used to leave the pane silently blank (the
// empty-pane reports). Show a themed error page instead; the pane keeps
// reporting the *intended* URL so the omnibox never goes blank, and the page
// links back to it for a one-click retry.
const errorUrlByPane = new Map<string, string>()
function errorStateUrl(target: string, desc: string): string {
  const host = hostOf(target)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#fff;--fg:rgba(0,0,0,.85);--muted:#8a8a8e;--card:#f4f4f6;--line:#e6e6e9}
@media(prefers-color-scheme:dark){:root{--bg:#1e1f24;--fg:rgba(255,255,255,.86);--muted:#83848a;--card:#26272e;--line:rgba(255,255,255,.09)}}
*{margin:0;box-sizing:border-box}html,body{height:100%}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
.wrap{text-align:center;width:min(420px,80%)}
.mark{width:64px;height:64px;border-radius:18px;background:var(--card);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;margin:0 auto 18px}
.mark svg{width:29px;height:29px;stroke:var(--muted);fill:none;stroke-width:1.5;stroke-linecap:round}
h1{font-size:17px;font-weight:600;letter-spacing:-.01em}
.sub{margin-top:6px;font-size:13px;color:var(--muted);line-height:1.5;word-break:break-all}
.err{margin-top:4px;font-size:11px;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
.retry{display:inline-block;margin-top:18px;padding:8px 18px;border-radius:8px;background:var(--card);border:1px solid var(--line);color:var(--fg);text-decoration:none;font-size:13px;font-weight:600}
</style></head><body><div class="wrap">
<div class="mark"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 8l8 8M16 8l-8 8"/></svg></div>
<h1>Couldn&rsquo;t load ${esc(host)}</h1>
<div class="sub">${esc(target)}</div>
<div class="err">${esc(desc)}</div>
<a class="retry" href="${esc(target)}">Try again</a>
</div></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/**
 * Run agent-driven browser work without letting the app steal the user's focus.
 *
 * A page can ask to be activated (window.focus(), and Chromium raises the
 * window when content it just loaded takes focus). Nothing in our code calls
 * focus() — the request comes from the web contents — so the only reliable
 * defence is to make the window unable to accept activation while an agent
 * drives it. A non-focusable window cannot be raised by anyone.
 *
 * Only engages when the app is already in the background: if the user is
 * sitting in SuperAgent, nothing changes for them. Ref-counted so overlapping
 * tool calls can't restore it early, with a hard timeout so a hung load can
 * never leave the window permanently unclickable.
 */
let guardDepth = 0
// Bumped on every hard release (e.g. the user clicking the app), so the finally
// blocks of withoutStealingFocus calls that were in flight BEFORE that release
// don't decrement the fresh count a later call has since built up.
let guardGen = 0
let guardTimer: ReturnType<typeof setTimeout> | null = null
let focusGuardActive = false

/**
 * Keep the app from jumping in front of the user while an agent drives the
 * browser.
 *
 * Measured, not guessed: an attached WebContentsView takes focus when its page
 * finishes loading (and again when it is attached), and macOS activates the
 * whole app to deliver that focus. Neither detaching the view nor
 * win.setFocusable(false) stops it — the window still receives focus and the
 * app still comes forward. The only thing that does is the app's activation
 * policy: 'prohibited' makes NSApp refuse activation outright.
 *
 * So the guard flips the policy for the duration of the agent's action plus a
 * short tail, and only when the user is already in another app. It is
 * ref-counted (agents chain calls), has a 30s backstop, and is dropped the
 * moment the user focuses the window themselves.
 */
function setPolicy(policy: 'regular' | 'prohibited'): void {
  if (process.platform === 'darwin') app.setActivationPolicy(policy)
}

/**
 * Belt and braces. The activation policy stops most activations, but a request
 * created by a page load can survive it and land later. So we also remember who
 * the user was actually working in, and hand focus straight back if we ever end
 * up in front. Worst case that is a flicker; without it the app steals the
 * session. Bundle ids come from lsappinfo (no permissions needed, unlike
 * System Events).
 */
let lastAppUserWasIn: string | null = null
let frontAppBeforeGuard: string | null = null
let focusReturnedThisCycle = false
let guardEndedAt = 0

/**
 * Kept warm: when our window loses focus we note which app the user moved to,
 * so the guard has a target ready the instant it needs one (looking it up at
 * engage time was too late — the shell call hadn't returned before the stolen
 * focus arrived).
 */
export function noteUserLeftApp(): void {
  if (process.platform !== 'darwin') return
  execFile('/bin/sh', ['-c', 'lsappinfo info -only bundleid $(lsappinfo front)'], (err, out) => {
    if (err) return
    const id = /"(?:CFBundleIdentifier|LSBundleID)"="([^"]+)"/.exec(out)?.[1]
    // Never target ourselves — that would turn the guard into the hijack.
    if (id && !/superagent|electron/i.test(id)) {
      lastAppUserWasIn = id
      if (focusGuardActive && !frontAppBeforeGuard) frontAppBeforeGuard = id
      paneLog('user-left-to', 'window', id)
    }
  })
}

function rememberFrontApp(): void {
  frontAppBeforeGuard = lastAppUserWasIn
  focusReturnedThisCycle = false
  // Refresh in the background too: the window may never have been focused this
  // run (so no blur ever fired), and the lookup returns long before a stolen
  // activation lands ~500ms later.
  noteUserLeftApp()
}

/**
 * Called when our window takes focus during (or just after) agent work: give it
 * back. The tail matters — a page's activation request can be queued while the
 * policy forbids it and only land once the policy is restored.
 */
export function allowUserFocus(): void {
  frontAppBeforeGuard = null
}

export function returnFocusToUser(): void {
  const justAfter = Date.now() - guardEndedAt < 2500
  if ((!focusGuardActive && !justAfter) || focusReturnedThisCycle || !frontAppBeforeGuard) return
  focusReturnedThisCycle = true
  const target = frontAppBeforeGuard
  paneLog('focus-return', 'window', target)
  execFile('open', ['-b', target], () => {})
}

/**
 * Panes detached while the user is elsewhere. They stay out of the window —
 * and therefore unable to ask for focus — until the user actually looks at the
 * app, at which point attaching is harmless because we are already frontmost.
 */
const detachedWhileAway = new Set<string>()

function detachPanesWhileAway(): void {
  for (const pane of panes.values()) {
    if (pane.visible && !pane.window.isDestroyed()) {
      pane.window.contentView.removeChildView(pane.view)
      pane.visible = false
      detachedWhileAway.add(pane.id)
      paneLog('pane-detached-while-away', pane.id)
    }
  }
}

/**
 * The user is back. Do NOT attach from here: main doesn't know which panes the
 * UI still wants on screen, and blindly re-adding one produced a view floating
 * over the chat with no toolbar (the component that owns it had unmounted).
 * Ask the renderer to re-sync instead — whichever panes are still mounted will
 * push fresh bounds, and browser:set-bounds attaches them.
 */
export function attachPanesOnReturn(): void {
  if (detachedWhileAway.size === 0) return
  detachedWhileAway.clear()
  paneLog('pane-resync-requested', 'window')
  broadcastToWindows('browser:resync')
}

export function releaseFocusGuard(): void {
  if (!focusGuardActive) return
  focusGuardActive = false
  guardDepth = 0
  // Any in-flight call's finally now belongs to a bygone guard — invalidate them
  // so they can't decrement a count a later engage rebuilt.
  guardGen += 1
  if (guardTimer) {
    clearTimeout(guardTimer)
    guardTimer = null
  }
  // Hand focus to the app's own renderer before lifting the policy: the queued
  // activation belongs to the pane view's focus request, and giving focus
  // elsewhere inside the window discards it (otherwise it fires the instant the
  // policy allows, and we can only bounce it back — a visible flash).
  const w = BrowserWindow.getAllWindows()[0]
  if (w && !w.isDestroyed()) w.webContents.focus()
  setPolicy('regular')
  guardEndedAt = Date.now()
  paneLog('focus-guard', 'window', 'released')
}

export async function withoutStealingFocus<T>(fn: () => Promise<T>): Promise<T> {
  const win = BrowserWindow.getAllWindows()[0]
  // The user is looking right at the app — let it behave normally.
  const engage = !!win && !win.isDestroyed() && !win.isFocused()
  // The generation this call belongs to. If a hard release bumps it before our
  // finally runs, our decrement would corrupt a count a later call rebuilt — so
  // skip it in that case.
  const myGen = guardGen
  if (engage) {
    if (guardDepth === 0) {
      focusGuardActive = true
      rememberFrontApp()
      detachPanesWhileAway()
      setPolicy('prohibited')
      paneLog('focus-guard', 'window', 'engaged')
    }
    guardDepth += 1
    if (guardTimer) clearTimeout(guardTimer)
    // Backstop: a hung tool call must never leave the app unable to activate.
    guardTimer = setTimeout(releaseFocusGuard, 30_000)
  }
  try {
    return await fn()
  } finally {
    if (engage && myGen === guardGen) {
      guardDepth = Math.max(0, guardDepth - 1)
      if (guardDepth === 0) {
        // The grab lands ~100ms after the load settles; a short tail covers it
        // without leaving the app un-clickable between chained calls.
        setTimeout(() => {
          if (guardDepth === 0 && myGen === guardGen) releaseFocusGuard()
        }, 500)
      }
    }
  }
}

/**
 * A note on where the focus guard belongs.
 *
 * It works by flipping the app's activation policy to 'prohibited', which is
 * the only thing that actually stops a page load from raising the window — but
 * a prohibited app is also delisted from the Dock and cannot be activated at
 * all until the policy comes back. That is fine for the second or two an agent
 * takes to drive something. It is not fine as an ambient condition.
 *
 * It was briefly applied to every pane touch — navigate, reload, attach, back,
 * forward — to cover "the app must never come forward". That made it fire
 * hundreds of times a day, and each firing is a window in which the app
 * disappears from the Dock. So it stays where the agent is: the automation
 * tools and open_file wrap themselves in it, and a renderer-driven load only
 * happens when the user is in the app, where the guard declines to engage
 * anyway.
 */

/**
 * When the agent opens a pane that was closed, the renderer mounts it and
 * restores the URL it had last time — and that restore can land AFTER the
 * agent's own load, silently replacing the page the agent just opened. Record
 * agent loads so the restore can be ignored while one is fresh.
 */
const lastAgentLoadAt = new Map<string, number>()
export function markAgentLoad(paneId: string): void {
  lastAgentLoadAt.set(paneId, Date.now())
}
function agentLoadedRecently(paneId: string): boolean {
  const at = lastAgentLoadAt.get(paneId)
  return !!at && Date.now() - at < 3000
}

function attachPaneView(pane: BrowserPane): void {
  if (pane.window.isDestroyed()) return
  pane.window.contentView.addChildView(pane.view)
  pane.visible = true
  // Mark as most-recently-shown, then trim any long-cold panes over the cap —
  // this one is now visible, so it can't be the one evicted.
  lastShownAt.set(pane.id, Date.now())
  evictColdPanes()
}

export function createBrowserPane(window: BrowserWindow, id: string, partition: string): void {
  if (panes.has(id)) return
  paneLog('create', id, partition)
  // Identity is left honest (see the note by applyBrowserIdentity) — no header rewrite.

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  wirePdfSaveBack(view.webContents.session)
  view.setBackgroundColor('#ffffff')
  // A native view isn't clipped by the card's CSS radius, so its corners are its
  // own problem. Electron's radius is uniform — all four or none — which is why
  // the renderer picks it per viewport mode: a phone stays rounded, while the
  // desktop card sits flush under the docked omnibar (square) and gets its
  // rounded bottom from the card showing beneath it. Default square; the
  // renderer sets the real value on the first bounds sync.
  view.setBorderRadius?.(0)

  const pane: BrowserPane = { id, view, window, visible: false, partition, radius: 0 }
  panes.set(id, pane)

  const wc = view.webContents
  applyBrowserIdentity(wc)
  const sendState = (): void => {
    if (window.isDestroyed()) return
    const empty = emptyPanes.has(id)
    const errUrl = errorUrlByPane.get(id)
    window.webContents.send(`browser:state:${id}`, {
      url: empty ? '' : (errUrl ?? wc.getURL()),
      title: empty ? 'New tab' : errUrl ? `Couldn't load ${hostOf(errUrl)}` : wc.getTitle(),
      canGoBack: !empty && wc.navigationHistory.canGoBack(),
      canGoForward: !empty && wc.navigationHistory.canGoForward(),
      loading: !empty && wc.isLoading(),
      favicon: empty ? undefined : faviconByPane.get(id)
    })
  }
  wc.on('did-navigate', sendState)
  wc.on('did-navigate-in-page', sendState)
  wc.on('page-title-updated', sendState)
  wc.on('did-start-loading', sendState)
  wc.on('did-stop-loading', sendState)
  // Hide the page's scrollbars for a clean preview — scrolling still works with the
  // wheel/trackpad; only the bar is gone. Re-applied per navigation (dom-ready).
  wc.on('dom-ready', () => {
    wc.insertCSS(
      '::-webkit-scrollbar{width:0!important;height:0!important;background:transparent!important}'
    ).catch(() => {})
  })
  // A page can drop its old favicon before the new one loads; clear on navigation
  // so a stale icon doesn't linger, then inline the new one when it arrives.
  wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) faviconByPane.delete(id)
    // Any real navigation (not the empty/error data: pages) leaves them behind.
    if (isMainFrame && !url.startsWith('data:text/html')) {
      emptyPanes.delete(id)
      errorUrlByPane.delete(id)
      detachedWhileAway.delete(id)
    }
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
  wc.on('render-process-gone', (_e, details) => {
    paneLog('render-process-gone', id, details.reason)
    if (!window.isDestroyed()) window.webContents.send(`browser:crashed:${id}`)
  })
  // A failed main-frame load used to leave the pane blank with no other trace —
  // the prime suspect for "agent opened a page and it's empty". Log it, then
  // show the error page in its place (keeping the intended URL in the omnibox).
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded navigation, normal */) return
    paneLog('did-fail-load', id, `${code} ${desc} ${url}`)
    errorUrlByPane.set(id, url)
    wc.loadURL(errorStateUrl(url, desc || `error ${code}`)).catch(() => {})
    sendState()
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
  // Identity is left honest (see the note by applyBrowserIdentity) — no header rewrite.
  const view = new WebContentsView({
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  wirePdfSaveBack(view.webContents.session)
  view.setBackgroundColor('#ffffff')
  view.setBounds({ x: -20000, y: -20000, width: 1280, height: 800 })
  applyBrowserIdentity(view.webContents)
  panes.set(id, { id, view, window, visible: false, partition, radius: 0 })
}

/**
 * The session partition for a pane, resolved from its id — which may now be a
 * CHAT id (per-chat browser panes) rather than a workspace id. Partitions stay
 * per-PROJECT so all of a project's chats share one login: browser projects use
 * the shared 'persist:browser', code projects their own 'persist:ws-<id>'. This
 * must match exactly what the renderer's BrowserPane passes, or an adopted pane
 * would come up logged out.
 */
export function partitionForPane(paneId: string): string {
  let wsId = workspaceIdFromPane(paneId)
  // A chat id won't resolve as a workspace kind; map it to its project.
  if (!getWorkspaceKind(wsId)) {
    const owner = getChatWorkspace(wsId)
    if (owner) wsId = owner
  }
  return getWorkspaceKind(wsId) === 'browser' ? 'persist:browser' : `persist:ws-${wsId}`
}

/**
 * Ensure a live-but-hidden pane exists for a chat whose desk isn't on screen —
 * so a background chat's agent can drive its own browser (navigate, read, click)
 * before the user ever switches to it. Same offscreen technique as routine
 * panes; when the user opens that chat, the renderer's BrowserPane adopts this
 * exact WebContents (createBrowserPane no-ops on an existing id) and attaches it.
 */
export function ensureBackgroundPane(window: BrowserWindow, paneId: string): void {
  if (panes.has(paneId)) return
  ensureOffscreenPane(window, paneId, partitionForPane(paneId))
}

export function destroyBrowserPane(id: string): void {
  const pane = panes.get(id)
  if (!pane) return
  panes.delete(id)
  zoomFactors.delete(id)
  faviconByPane.delete(id)
  errorUrlByPane.delete(id)
  detachedWhileAway.delete(id)
  lastShownAt.delete(id)
  hidePane(pane)
  pane.view.webContents.close()
}

/**
 * Free every pane belonging to a workspace — the bare id AND every per-chat pane
 * (`workspace::chat`). Panes are created per conversation, but the old teardown
 * only destroyed the bare workspace id, so every chat's WebContentsView (a full
 * Chromium renderer, ~100MB) leaked for the life of the app. Called when a
 * workspace is removed; individual chats free their own pane on delete.
 */
export function destroyWorkspacePanes(workspaceId: string): void {
  const prefix = workspaceId + '::'
  for (const id of [...panes.keys()]) {
    if (id === workspaceId || id.startsWith(prefix)) destroyBrowserPane(id)
  }
}

// LRU bound on live panes. Each is a Chromium renderer, so an afternoon of
// hopping between chats/projects could pile up dozens. We keep the most recently
// SHOWN panes and close the webContents of the rest — a revisited pane is
// recreated and re-navigated to its stored URL (the renderer persists paneUrl),
// so nothing is lost but the in-memory page (scroll/unsubmitted input). The cap
// is generous so it only bites when memory would otherwise balloon.
const lastShownAt = new Map<string, number>()
const MAX_LIVE_PANES = 8
const PANE_COLD_MS = 3 * 60 * 1000
function evictColdPanes(): void {
  if (panes.size <= MAX_LIVE_PANES) return
  const now = Date.now()
  // Only ever evict a pane that is hidden AND hasn't been looked at for a few
  // minutes — never one the user just switched away from, and never a visible
  // one. If nothing qualifies we simply keep them all rather than disrupt an
  // active page; the cap is a memory ceiling, not a hard limit.
  const cold = [...panes.values()]
    .filter((p) => !p.visible && now - (lastShownAt.get(p.id) ?? 0) > PANE_COLD_MS)
    .sort((a, b) => (lastShownAt.get(a.id) ?? 0) - (lastShownAt.get(b.id) ?? 0))
  let over = panes.size - MAX_LIVE_PANES
  for (const p of cold) {
    if (over <= 0) break
    destroyBrowserPane(p.id)
    over--
  }
}

function hidePane(pane: BrowserPane): void {
  detachedWhileAway.delete(pane.id)
  if (pane.visible && !pane.window.isDestroyed()) {
    pane.window.contentView.removeChildView(pane.view)
    if (twin?.forPane === pane.id) destroyTwin(pane.window)
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
    // Return whatever the pane is already showing. createBrowserPane no-ops on an
    // existing id, so a pane hidden on a chat switch and re-created when you come
    // back reports its live URL — the renderer uses that to leave the page alone
    // instead of re-navigating (which would reload it and lose any manual nav).
    // A genuinely fresh pane has loaded nothing yet and reports ''.
    return getPaneWebContents(id)?.getURL() ?? ''
  })
  // Show the themed "new tab" page — the renderer calls this for a blank project
  // (no URL yet) so the pane isn't an empty white card.
  ipcMain.on('browser:show-empty', (_e, id: string) => {
    const wc = getPaneWebContents(id)
    paneLog('show-empty', id, wc ? `over=${wc.getURL().slice(0, 80)}` : 'NO-PANE')
    if (!wc) return
    emptyPanes.add(id)
    wc.loadURL(emptyStateUrl(getRecentHistory(6)))
  })
  ipcMain.on('browser:set-bounds', (_e, id: string, bounds: BrowserBounds) => {
    const pane = panes.get(id)
    if (!pane || pane.window.isDestroyed()) return
    if (!pane.visible) {
      if (focusGuardActive || detachedWhileAway.size > 0) {
        // Away: keep it out of the window until the user returns.
        detachedWhileAway.add(id)
      } else {
        attachPaneView(pane)
      }
    }
    pane.view.setBounds(bounds)
    // After the bounds, and after any re-attach above: both rebuild the layer
    // this is a property of, so applying it earlier is applying it to a layer
    // that is about to be thrown away.
    pane.view.setBorderRadius?.(pane.radius)
  })

  /**
   * Freeze the pane for an HTML overlay: photograph the page, then detach the
   * native view — both here in main, one IPC. The view composites above ALL
   * renderer HTML, so every frame it stays attached is a frame the modal is
   * invisible; detaching must not wait for a renderer round-trip. The still goes
   * back to the renderer to stand in for the page (dimmed like everything else).
   */
  ipcMain.handle('browser:freeze', async (_e, id: string) => {
    const pane = panes.get(id)
    if (!pane || pane.window.isDestroyed() || !pane.visible) return null
    let buf: Buffer | null = null
    const t0 = Date.now()
    try {
      const img = await pane.view.webContents.capturePage()
      // A JPEG Buffer, not a full-resolution PNG data URL: toDataURL() encodes
      // PNG synchronously on the main thread and hands back multiple MB of
      // base64, enough to stall the UI for a second or more on a big pane.
      //
      // At full resolution, though. This used to halve the width as well, which
      // on a Retina display throws away three quarters of the pixels and then
      // shows the result back at full pane size — the page visibly pixelating
      // whenever you left the app.
      if (!img.isEmpty()) buf = img.toJPEG(88)
    } catch {
      // No still. The detach below matters more than the picture.
    }
    /**
     * Detach whatever happened to the photograph.
     *
     * This used to return early when the capture came back empty, leaving the
     * view attached — and an attached view paints above all HTML, so a pane
     * that failed to photograph became a rectangle sitting on top of the app
     * with nothing to explain it. A lone image is exactly the kind of page
     * that captures empty, which is how a file window ended up floating over
     * the browser. Getting out of the way is the job here; the still is the
     * bonus.
     */
    try {
      pane.window.contentView.removeChildView(pane.view)
      if (twin?.forPane === id) destroyTwin(pane.window)
      pane.visible = false
    } catch {
      // Window torn down mid-freeze; nothing left to detach from.
    }
    paneLog('freeze', id, `${buf ? `still ${buf.length}b` : 'no still'} in ${Date.now() - t0}ms`)
    return buf
  })

  ipcMain.handle('browser:sample-corners', async (_e, id: string) => {
    const pane = panes.get(id)
    if (!pane || !pane.visible || pane.window.isDestroyed()) return null
    try {
      // Full capture + tiny thumbnail. The rect variant of capturePage returns
      // stale/blank frames for zoomed child views, so crop after the fact: a
      // 64px-wide resize is native-fast, and the corner arc (~1% of the width)
      // dissolves to under a pixel — sampling columns 2-4 lands safely on the
      // page's real top-edge colour.
      const img = await pane.view.webContents.capturePage()
      if (img.isEmpty()) return null
      const thumb = img.resize({ width: 64 })
      const { width: tw, height: th } = thumb.getSize()
      const buf = thumb.toBitmap() // BGRA
      if (!buf.length || tw < 8 || th < 3) return null
      const win = (x0: number, y0 = 0): string => {
        let r = 0
        let g = 0
        let bl = 0
        let n = 0
        for (let y = y0; y < y0 + 3; y++) {
          for (let x = x0; x < x0 + 3; x++) {
            const i = (y * tw + x) * 4
            bl += buf[i]
            g += buf[i + 1]
            r += buf[i + 2]
            n++
          }
        }
        const h = (v: number): string =>
          Math.round(v / n)
            .toString(16)
            .padStart(2, '0')
        return `#${h(r)}${h(g)}${h(bl)}`
      }
      // The bottom edge too: a pane filling a rounded window hides its last few
      // pixels behind a strip of this colour, which is what gives the page a
      // rounded bottom the compositor would not.
      return { left: win(2), right: win(tw - 5), bottom: win(Math.floor(tw / 2) - 1, th - 3) }
    } catch {
      return null
    }
  })

  /** Full-resolution PNG of the pane as composited (screenshot tooling). Unlike
      a debugger screenshot of the zoomed page, capturePage returns the view at
      native display scale. */
  // The side-by-side phone runs in its own WebContentsView, so a full-window
  // screenshot needs it separately (screenshot tooling composites both).
  ipcMain.handle('browser:shoot-twin', async () => {
    if (!twin) return null
    try {
      const img = await twin.view.webContents.capturePage()
      return img.isEmpty() ? null : img.toPNG()
    } catch {
      return null
    }
  })

  ipcMain.handle('browser:shoot', async (_e, id: string) => {
    const pane = panes.get(id)
    if (!pane || !pane.visible || pane.window.isDestroyed()) return null
    try {
      const img = await pane.view.webContents.capturePage()
      return img.isEmpty() ? null : img.toPNG()
    } catch {
      return null
    }
  })

  // Attach/position/detach the mobile twin for the side-by-side viewport.
  ipcMain.on(
    'browser:twin-bounds',
    (_e, id: string, bounds: BrowserBounds | null, zoom: number) => {
      const pane = panes.get(id)
      if (!pane || pane.window.isDestroyed()) return
      if (!bounds) {
        if (twin?.forPane === id) destroyTwin(pane.window)
        return
      }
      if (twin && twin.forPane !== id) destroyTwin(pane.window)
      if (!twin) {
        const view = new WebContentsView({
          webPreferences: {
            partition: pane.partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        })
        view.setBackgroundColor('#ffffff')
        view.setBorderRadius?.(10)
        const wc = pane.view.webContents
        const sync = (): void => {
          const url = wc.getURL()
          if (url && twin && twin.view.webContents.getURL() !== url) {
            twin.view.webContents.loadURL(url).catch(() => {})
          }
        }
        wc.on('did-navigate', sync)
        twin = { view, forPane: id, offNav: () => wc.removeListener('did-navigate', sync) }
        sync()
      }
      pane.window.contentView.addChildView(twin.view)
      twin.view.setBounds(bounds)
      twin.view.webContents.setZoomFactor(Math.max(0.2, zoom))
    }
  )

  ipcMain.on('browser:hide', (_e, id: string) => {
    const pane = panes.get(id)
    if (pane) hidePane(pane)
  })
  ipcMain.on('browser:navigate', (_e, id: string, rawUrl: string) => {
    const wc = getPaneWebContents(id)
    const url = normalizeUrl(rawUrl)
    // The mount's URL restore, arriving after the agent already loaded a page
    // here — dropping it keeps the agent's page on screen.
    if (agentLoadedRecently(id) && wc && url !== wc.getURL()) {
      paneLog('navigate-skipped-stale-restore', id, url.slice(0, 100))
      return
    }
    const ok = isNavigable(url) || isLocalFile(url)
    if (!wc || !ok) paneLog('navigate-dropped', id, `${wc ? '' : 'NO-PANE '}${url.slice(0, 120)}`)
    if (!wc) return
    if (ok) wc.loadURL(url)
  })
  ipcMain.on('browser:back', (_e, id: string) => {
    getPaneWebContents(id)?.navigationHistory.goBack()
  })
  ipcMain.on('browser:forward', (_e, id: string) => {
    getPaneWebContents(id)?.navigationHistory.goForward()
  })
  ipcMain.on('browser:stop', (_e, id: string) => {
    getPaneWebContents(id)?.stop()
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
  ipcMain.on('browser:set-radius', (_e, id: string, radius: number) => {
    const pane = panes.get(id)
    if (!pane) return
    pane.radius = Math.max(0, Math.round(radius))
    pane.view.setBorderRadius?.(pane.radius)
  })

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
  ipcMain.on('browser:destroy-workspace', (_e, workspaceId: string) =>
    destroyWorkspacePanes(workspaceId)
  )
  // Is a dev server still listening on this local port? Used after a restart to
  // drop persisted server chips whose process didn't survive.
  ipcMain.handle('net:checkPort', (_e, port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = tcpConnect({ port, host: '127.0.0.1' })
      const finish = (ok: boolean): void => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(1000)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })
  })
  // Kill whatever is LISTENING on a local port — the "Stop the server" button.
  // The agent backgrounded the server, so the app has no process handle to it, but
  // it does know the port; lsof maps the port to the owning PID(s), which we then
  // terminate (TERM first; a stubborn dev server gets KILL a beat later).
  ipcMain.handle('net:killPort', async (_e, port: number): Promise<boolean> => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false
    const pids = await new Promise<number[]>((resolve) => {
      execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
        if (err) return resolve([])
        resolve(
          stdout
            .split('\n')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0)
        )
      })
    })
    if (pids.length === 0) return false
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    // A dev server that traps TERM (some watchers do) gets a KILL shortly after.
    setTimeout(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone — good */
        }
      }
    }, 1500)
    return true
  })
}
