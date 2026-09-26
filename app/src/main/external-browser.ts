import { spawn, ChildProcess, execFile, execFileSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import type { Readable, Writable } from 'stream'
import { homedir } from 'os'
import { join } from 'path'
import { app, ipcMain, WebContents } from 'electron'
import { kvGet, kvSet, DESKTOP_WORKSPACE_ID } from './store'
import { broadcastToWindows, workspaceIdFromPane } from './util'

/**
 * A project can have its agent browse in the user's real Brave or Chrome
 * instead of the built-in pane — for Google sign-in, extensions, a password
 * manager, and sites that turn embedded browsers away.
 *
 * Superagent starts that browser itself, with remote control switched on and a
 * profile of its own under the app's data folder: the user signs in there once.
 * Their everyday profile is never touched (recent Chromium refuses remote
 * control on it anyway). The agent's browser tools speak the same Chrome
 * protocol (CDP) either way — see automation.ts's PageDriver — so only where
 * the commands go changes.
 */

export type BrowserId = 'builtin' | 'brave' | 'chrome' | 'edge'

const APPS: {
  id: Exclude<BrowserId, 'builtin'>
  name: string
  bundle: string
  binary: string
  /** How macOS names it as the default browser. */
  bundleId: string
}[] = [
  {
    id: 'brave',
    name: 'Brave',
    bundle: 'Brave Browser.app',
    binary: 'Brave Browser',
    bundleId: 'com.brave.browser'
  },
  {
    id: 'chrome',
    name: 'Chrome',
    bundle: 'Google Chrome.app',
    binary: 'Google Chrome',
    bundleId: 'com.google.chrome'
  },
  {
    id: 'edge',
    name: 'Edge',
    bundle: 'Microsoft Edge.app',
    binary: 'Microsoft Edge',
    bundleId: 'com.microsoft.edgemac'
  }
]

function executablePath(id: BrowserId): string | null {
  const a = APPS.find((x) => x.id === id)
  if (!a) return null
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    const p = join(dir, a.bundle, 'Contents', 'MacOS', a.binary)
    if (existsSync(p)) return p
  }
  return null
}

/** The browsers a project can pick: the built-in one, plus what's installed. */
export function installedBrowsers(): { id: BrowserId; name: string }[] {
  return [
    { id: 'builtin', name: 'Superagent' },
    ...APPS.filter((a) => executablePath(a.id)).map((a) => ({ id: a.id, name: a.name }))
  ]
}

export function browserName(id: BrowserId): string {
  return id === 'builtin' ? 'Superagent' : (APPS.find((a) => a.id === id)?.name ?? id)
}

const kvKey = (workspaceId: string): string => `browser:${workspaceId}`

/** The project's pick — the built-in browser unless it chose one that's still installed. */
export function browserFor(workspaceId: string): BrowserId {
  const v = kvGet(kvKey(workspaceId)) as BrowserId | undefined
  return v && v !== 'builtin' && executablePath(v) ? v : 'builtin'
}

/** The Mac's default browser's bundle id (lowercased), or null for Safari or unset. */
function macDefaultBrowser(): string | null {
  try {
    const plist = join(
      homedir(),
      'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'
    )
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], {
      encoding: 'utf8',
      timeout: 2000
    })
    const handlers =
      (JSON.parse(json) as { LSHandlers?: Record<string, string>[] }).LSHandlers ?? []
    const https = handlers.find((h) => h.LSHandlerURLScheme === 'https')
    return https?.LSHandlerRoleAll?.toLowerCase() ?? null
  } catch {
    return null
  }
}

/**
 * The user's real browser, for when the agent needs one without being told
 * which: the Mac's default if Superagent can drive it, else the first of
 * Brave, Chrome and Edge that's installed. Null when none is.
 */
export function yourBrowser(): Exclude<BrowserId, 'builtin'> | null {
  const installed = APPS.filter((a) => executablePath(a.id))
  const dflt = macDefaultBrowser()
  return (installed.find((a) => a.bundleId === dflt) ?? installed[0])?.id ?? null
}

/**
 * Point a project's browser tools at `id` — the pill, and the agent's
 * browser_use. `open` also launches it and brings its window forward, which is
 * where the user signs in the first time.
 */
export async function switchBrowser(
  workspaceId: string,
  id: BrowserId,
  opts: { open?: boolean } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!installedBrowsers().some((b) => b.id === id)) return { ok: false, error: 'Not installed' }
  setBrowserFor(workspaceId, id)
  forgetExternalPages(workspaceId)
  broadcastToWindows('browsers:changed', { workspaceId, id })
  if (id === 'builtin' || !opts.open) return { ok: true }
  try {
    await ensureRunning(id)
    await showBrowserWindow(id)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function setBrowserFor(workspaceId: string, id: BrowserId): void {
  kvSet(kvKey(workspaceId), id)
}

/**
 * Which browser a pane's tools drive. Routines run offscreen on the built-in
 * browser, and the Computer's own chat drives the desktop's browser — both stay
 * as they are.
 */
export function externalBrowserForPane(paneId: string): BrowserId | null {
  if (paneId.endsWith('::routine')) return null
  const ws = workspaceIdFromPane(paneId)
  if (ws === DESKTOP_WORKSPACE_ID) return null
  const id = browserFor(ws)
  return id === 'builtin' ? null : id
}

// --- Running the browser ----------------------------------------------------
//
// Remote control goes over a private pipe (--remote-debugging-pipe): two file
// descriptors only Superagent holds. A debugging *port* would let any program
// on the Mac drive this profile — its cookies and signed-in sessions included,
// which is why Chrome stopped allowing it on everyday profiles. With a pipe the
// browser listens on nothing, and it quits by itself if Superagent goes away.

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

/** One running browser, spoken to over its pipe (NUL-delimited JSON, CDP). */
class BrowserConnection {
  private seq = 0
  private buf = ''
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Set<Listener>()
  closed = false

  constructor(readonly proc: ChildProcess) {
    const incoming = proc.stdio[4] as Readable
    incoming.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8')
      let i: number
      while ((i = this.buf.indexOf('\0')) >= 0) {
        const raw = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        let msg: {
          id?: number
          result?: unknown
          error?: { message: string }
          method?: string
          params?: Record<string, unknown>
          sessionId?: string
        }
        try {
          msg = JSON.parse(raw)
        } catch {
          continue
        }
        if (msg.id !== undefined) {
          const w = this.waiting.get(msg.id)
          this.waiting.delete(msg.id)
          if (msg.error) w?.reject(new Error(msg.error.message))
          else w?.resolve(msg.result)
        } else if (msg.method) {
          for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId)
        }
      }
    })
    const end = (): void => {
      if (this.closed) return
      this.closed = true
      for (const w of this.waiting.values()) w.reject(new Error('The browser closed.'))
      this.waiting.clear()
    }
    incoming.on('close', end)
    proc.once('exit', end)
    ;(proc.stdio[3] as Writable).on('error', end)
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser closed.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ;(this.proc.stdio[3] as Writable).write(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'
      )
    })
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

const running = new Map<BrowserId, BrowserConnection>()

/** Where the agent's copy of a browser keeps its profile — never the user's own. */
export function profileDir(id: BrowserId): string {
  return join(app.getPath('userData'), 'browsers', id)
}

/**
 * Quit the agent's copy of a browser and wait until it has: its profile's files
 * are only safe to change once it's gone. True if it was running.
 */
export async function stopBrowser(id: BrowserId): Promise<boolean> {
  const conn = running.get(id)
  if (!conn || conn.closed || conn.proc.exitCode !== null) return false
  running.delete(id)
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => conn.proc.kill('SIGKILL'), 10_000)
    conn.proc.once('exit', () => {
      clearTimeout(kill)
      resolve()
    })
    // Asked to close, it saves its cookies first; SIGTERM alone lost the last
    // ~30 seconds of them (a sign-in made just before). SIGTERM if it won't.
    conn.send('Browser.close').catch(() => conn.proc.kill('SIGTERM'))
  })
  return true
}

/** Start the browser with its Superagent profile (or reuse it), and return its connection. */
export async function ensureRunning(id: BrowserId): Promise<BrowserConnection> {
  const existing = running.get(id)
  if (existing && !existing.closed) return existing
  const bin = executablePath(id)
  if (!bin) throw new Error(`${browserName(id)} isn't installed.`)
  const profile = profileDir(id)
  mkdirSync(profile, { recursive: true })
  const proc = spawn(
    bin,
    [
      '--remote-debugging-pipe',
      // Quiet tests: the same browser, with no window on the user's screen.
      ...(process.env.COVE_E2E_QUIET === '1' ? ['--headless=new'] : []),
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true }
  )
  const conn = new BrowserConnection(proc)
  running.set(id, conn)
  proc.once('exit', () => {
    if (running.get(id) === conn) running.delete(id)
  })
  // Ready when it answers. If this profile is already open in a copy of the
  // browser started some other way, ours hands over to it and exits at once.
  const ready = await Promise.race([
    conn.send('Browser.getVersion').then(
      () => true,
      () => false
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))
  ])
  if (!ready) {
    proc.kill('SIGTERM')
    throw new Error(
      `${browserName(id)} didn't start with remote control. If it's already open with this profile, quit it and try again.`
    )
  }
  return conn
}

/**
 * On quit: close the browsers Superagent started. They run with remote control
 * switched on, which shouldn't outlive the app that asked for it — and "quit
 * means quit" already holds for every agent and routine it started. (Closing
 * the pipe alone would do it too; SIGTERM is the prompt, clean way.)
 */
export function closeExternalBrowsers(): void {
  for (const [id, conn] of running) {
    // Browser.close saves its cookies first — a sign-in made just before quitting
    // survives. SIGTERM a moment later in case it doesn't answer.
    conn.send('Browser.close').catch(() => undefined)
    const t = setTimeout(() => {
      try {
        conn.proc.kill('SIGTERM')
      } catch {
        // already gone
      }
    }, 1500)
    conn.proc.once('exit', () => clearTimeout(t))
    running.delete(id)
  }
}

/**
 * Bring the agent's browser window forward — "Open window", the stuck card, and
 * the first sign-in. Asked of that browser itself (CDP Page.bringToFront):
 * `open -a Brave` raised whichever Brave macOS liked, usually the user's
 * everyday one rather than the agent's. `open -a` is only the last resort.
 */
export async function showBrowserWindow(id: BrowserId, paneId?: string): Promise<void> {
  try {
    const page = paneId ? existingExternalPage(paneId) : undefined
    if (page) {
      await page.sendCommand('Page.bringToFront')
      return
    }
    const conn = running.get(id)
    if (conn && !conn.closed) {
      const { targetInfos } = await conn.send<{
        targetInfos: { targetId: string; type: string }[]
      }>('Target.getTargets')
      const tab = targetInfos.find((t) => t.type === 'page')
      if (tab) {
        const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: tab.targetId,
          flatten: true
        })
        await conn.send('Page.bringToFront', {}, sessionId)
        await conn.send('Target.detachFromTarget', { sessionId }).catch(() => {})
        return
      }
    }
  } catch {
    // fall through to the last resort
  }
  const a = APPS.find((x) => x.id === id)
  if (a) execFile('open', ['-a', a.bundle.replace(/\.app$/, '')], () => {})
}

// --- Talking to a tab ----------------------------------------------------------

const WEBDRIVER_MASK =
  "Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false,configurable:true});"

type CdpEvent = (method: string, params: Record<string, unknown>) => void

/** One tab's session, over its browser's pipe. */
export class CdpSession {
  private detached = false

  constructor(
    private conn: BrowserConnection,
    readonly sessionId: string
  ) {
    conn.on((method, params) => {
      if (method === 'Target.detachedFromTarget' && params.sessionId === sessionId) {
        this.detached = true
      }
    })
  }

  get closed(): boolean {
    return this.detached || this.conn.closed
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser tab closed.'))
    return this.conn.send<T>(method, params, this.sessionId)
  }

  on(listener: CdpEvent): () => void {
    return this.conn.on((method, params, sessionId) => {
      if (sessionId === this.sessionId) listener(method, params)
    })
  }
}

/** One tab in the external browser, driven for one chat. */
export class ExternalPage {
  constructor(
    readonly browser: BrowserId,
    readonly session: CdpSession,
    readonly targetId: string,
    private conn: BrowserConnection
  ) {}

  async loadURL(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.session.on((method) => {
        if (method === 'Page.loadEventFired') {
          off()
          resolve()
        }
      })
      setTimeout(() => {
        off()
        resolve()
      }, 20000)
    })
    const res = await this.session.send<{ errorText?: string }>('Page.navigate', { url })
    if (res.errorText) throw new Error(`Couldn't open ${url}: ${res.errorText}`)
    await loaded
  }

  async getURL(): Promise<string> {
    return String((await this.executeJavaScript('location.href')) ?? '')
  }

  async executeJavaScript(expression: string): Promise<unknown> {
    const res = await this.session.send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Script error'
      )
    }
    return res.result?.value
  }

  sendCommand<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.session.send<T>(method, params)
  }

  /** Close this tab in the browser. */
  async close(): Promise<void> {
    await this.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}

const pages = new Map<string, ExternalPage>()
const pageListeners = new Set<(paneId: string, page: ExternalPage) => void>()

/** Hear about each tab as it's opened for a pane — the live view starts from this. */
export function onExternalPage(fn: (paneId: string, page: ExternalPage) => void): () => void {
  pageListeners.add(fn)
  return () => pageListeners.delete(fn)
}

export function existingExternalPage(paneId: string): ExternalPage | undefined {
  const p = pages.get(paneId)
  return p && !p.session.closed ? p : undefined
}

/** The pane's tab in its external browser, opened on first use. */
export async function externalPage(paneId: string, id: BrowserId): Promise<ExternalPage> {
  const have = existingExternalPage(paneId)
  if (have && have.browser === id) return have
  const conn = await ensureRunning(id)
  // The browser opens with one blank tab: use that before opening another.
  const ours = new Set([...pages.values()].map((p) => p.targetId))
  const { targetInfos } = await conn.send<{
    targetInfos: { targetId: string; type: string; url: string; attached: boolean }[]
  }>('Target.getTargets')
  const blank = targetInfos.find(
    (t) => t.type === 'page' && t.url === 'about:blank' && !t.attached && !ours.has(t.targetId)
  )
  const targetId =
    blank?.targetId ??
    (await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId
  const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  })
  const session = new CdpSession(conn, sessionId)
  await Promise.all([
    session.send('Page.enable'),
    session.send('Runtime.enable'),
    session.send('Network.enable'),
    // Pipe control marks the browser as automated (navigator.webdriver is
    // true), which is what Google sign-in and Cloudflare turn away. Set it back
    // before any page script runs, as the built-in pane does. (The launch flag
    // that avoids it shows an "unsupported command-line flag" warning bar.)
    session.send('Page.addScriptToEvaluateOnNewDocument', { source: WEBDRIVER_MASK }),
    session.send('Runtime.evaluate', { expression: WEBDRIVER_MASK })
  ])
  const page = new ExternalPage(id, session, targetId, conn)
  pages.set(paneId, page)
  for (const l of pageListeners) l(paneId, page)
  return page
}

/** Pick a different browser for a project: its tabs there are closed. */
export function forgetExternalPages(workspaceId: string): void {
  for (const [paneId, page] of pages) {
    if (workspaceIdFromPane(paneId) === workspaceId) {
      void page.close()
      pages.delete(paneId)
    }
  }
}

// --- The live view ------------------------------------------------------------

/**
 * The pane shows the external tab live: Chrome's screencast sends a JPEG each
 * time the page changes (nothing while it's still), and each frame must be
 * acknowledged before the next comes. Only while a pane is actually showing it.
 */
const watchers = new Map<string, { to: WebContents; stop: () => void }>()

async function startScreencast(paneId: string, page: ExternalPage, to: WebContents): Promise<void> {
  watchers.get(paneId)?.stop()
  const off = page.session.on((method, params) => {
    if (to.isDestroyed()) return
    if (method === 'Page.screencastFrame') {
      to.send('browsers:frame', { paneId, data: params.data })
      page.session.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string; url?: string }
      if (!frame.parentId && frame.url) to.send('browsers:url', { paneId, url: frame.url })
    }
  })
  const stop = (): void => {
    off()
    page.session.send('Page.stopScreencast').catch(() => {})
  }
  watchers.set(paneId, { to, stop })
  await page.session
    .send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 1600, maxHeight: 1600 })
    .catch(() => {})
  const url = await page.getURL().catch(() => '')
  if (url && !to.isDestroyed()) to.send('browsers:url', { paneId, url })
}

export function registerExternalBrowserIpc(): void {
  ipcMain.handle('browsers:list', () => installedBrowsers())
  ipcMain.handle('browsers:get', (_e, workspaceId: string) => browserFor(String(workspaceId)))
  // Picked on the pill: open it now — the first time, this is where the user signs in.
  ipcMain.handle('browsers:set', (_e, workspaceId: string, id: BrowserId) =>
    switchBrowser(String(workspaceId), id, { open: true })
  )
  ipcMain.handle('browsers:show', async (_e, paneId: string) => {
    const id = externalBrowserForPane(String(paneId))
    if (!id) return
    await showBrowserWindow(id, String(paneId))
  })
  ipcMain.on('browsers:watch', (e, paneId: string) => {
    const page = existingExternalPage(String(paneId))
    if (page) void startScreencast(String(paneId), page, e.sender)
    else watchers.set(String(paneId), { to: e.sender, stop: () => {} })
  })
  ipcMain.on('browsers:unwatch', (_e, paneId: string) => {
    watchers.get(String(paneId))?.stop()
    watchers.delete(String(paneId))
  })
  // A tab opened after the pane started watching (the agent's first navigate).
  onExternalPage((paneId, page) => {
    const w = watchers.get(paneId)
    if (w && !w.to.isDestroyed()) void startScreencast(paneId, page, w.to)
  })
}
