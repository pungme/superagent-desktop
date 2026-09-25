import { spawn, ChildProcess, execFile } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { createServer } from 'net'
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

const APPS: { id: Exclude<BrowserId, 'builtin'>; name: string; bundle: string; binary: string }[] =
  [
    { id: 'brave', name: 'Brave', bundle: 'Brave Browser.app', binary: 'Brave Browser' },
    { id: 'chrome', name: 'Chrome', bundle: 'Google Chrome.app', binary: 'Google Chrome' },
    { id: 'edge', name: 'Edge', bundle: 'Microsoft Edge.app', binary: 'Microsoft Edge' }
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

interface Running {
  pid: number
  port: number
  /** Ours from this launch; absent for one adopted after a crash. */
  proc?: ChildProcess
}
const running = new Map<BrowserId, Running>()

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function alive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500)
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * A copy of this browser already running on our profile with remote control
 * on — one Superagent started before it crashed or was force-quit. Reusing it
 * beats launching a second copy, which the profile's lock would turn away.
 */
async function adoptRunning(profile: string): Promise<Running | null> {
  const out = await new Promise<string>((resolve) =>
    execFile('ps', ['-Ao', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) =>
      resolve(stdout ?? '')
    )
  )
  for (const line of out.split('\n')) {
    if (!line.includes(`--user-data-dir=${profile}`)) continue
    const port = Number(/--remote-debugging-port=(\d+)/.exec(line)?.[1])
    const pid = Number(line.trim().split(/\s+/)[0])
    if (port && pid && (await alive(port))) return { pid, port }
  }
  return null
}

/** Start the browser with its Superagent profile (or reuse it), and return its CDP port. */
export async function ensureRunning(id: BrowserId): Promise<number> {
  const existing = running.get(id)
  if (existing && (await alive(existing.port))) return existing.port
  const bin = executablePath(id)
  if (!bin) throw new Error(`${browserName(id)} isn't installed.`)
  const profile = join(app.getPath('userData'), 'browsers', id)
  mkdirSync(profile, { recursive: true })
  // Adopted, it's ours again — so quitting Superagent closes it too.
  const adopted = await adoptRunning(profile)
  if (adopted) {
    running.set(id, adopted)
    return adopted.port
  }
  const port = await freePort()
  const proc = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: 'ignore', detached: true }
  )
  proc.unref()
  running.set(id, { proc, pid: proc.pid ?? 0, port })
  proc.once('exit', () => {
    if (running.get(id)?.proc === proc) running.delete(id)
  })
  for (let i = 0; i < 60; i++) {
    if (await alive(port)) return port
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `${browserName(id)} didn't start with remote control. If it's already open with this profile, quit it and try again.`
  )
}

/**
 * On quit: close the browsers Superagent started. They run with remote control
 * switched on, which shouldn't outlive the app that asked for it — and "quit
 * means quit" already holds for every agent and routine it started.
 */
export function closeExternalBrowsers(): void {
  // SIGTERM is a normal quit for Chromium (it saves the profile), and unlike a
  // CDP Browser.close it lands before the app — which won't wait — is gone.
  for (const [id, r] of running) {
    try {
      if (r.proc) r.proc.kill('SIGTERM')
      else if (r.pid) process.kill(r.pid, 'SIGTERM')
    } catch {
      // already gone
    }
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
    const r = running.get(id)
    if (r && (await alive(r.port))) {
      const tabs = (await (await fetch(`http://127.0.0.1:${r.port}/json/list`)).json()) as {
        type: string
        webSocketDebuggerUrl: string
      }[]
      const tab = tabs.find((t) => t.type === 'page')
      if (tab) {
        const session = await CdpSession.connect(tab.webSocketDebuggerUrl)
        await session.send('Page.bringToFront')
        session.close()
        return
      }
    }
  } catch {
    // fall through to the last resort
  }
  const a = APPS.find((x) => x.id === id)
  if (a) execFile('open', ['-a', a.bundle.replace(/\.app$/, '')], () => {})
}

// --- Talking to a tab over CDP ----------------------------------------------

type CdpEvent = (method: string, params: Record<string, unknown>) => void

export class CdpSession {
  private seq = 0
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Set<CdpEvent>()
  closed = false

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
        method?: string
        params?: Record<string, unknown>
      }
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id)
        this.waiting.delete(msg.id)
        if (msg.error) w?.reject(new Error(msg.error.message))
        else w?.resolve(msg.result)
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params ?? {})
      }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const w of this.waiting.values()) w.reject(new Error('The browser tab closed.'))
      this.waiting.clear()
    })
  }

  static connect(url: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new CdpSession(ws)), { once: true })
      ws.addEventListener(
        'error',
        () => reject(new Error('Could not connect to the browser tab.')),
        {
          once: true
        }
      )
    })
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser tab closed.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(listener: CdpEvent): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.ws.close()
  }
}

/** One tab in the external browser, driven for one chat. */
export class ExternalPage {
  constructor(
    readonly browser: BrowserId,
    readonly session: CdpSession,
    readonly targetId: string
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
  const port = await ensureRunning(id)
  const target = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()) as { id: string; webSocketDebuggerUrl: string }
  const session = await CdpSession.connect(target.webSocketDebuggerUrl)
  await Promise.all([
    session.send('Page.enable'),
    session.send('Runtime.enable'),
    session.send('Network.enable')
  ])
  const page = new ExternalPage(id, session, target.id)
  pages.set(paneId, page)
  for (const l of pageListeners) l(paneId, page)
  return page
}

/** Pick a different browser for a project: its open tabs are let go. */
export function forgetExternalPages(workspaceId: string): void {
  for (const [paneId, page] of pages) {
    if (workspaceIdFromPane(paneId) === workspaceId) {
      page.session.close()
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
  ipcMain.handle('browsers:set', async (_e, workspaceId: string, id: BrowserId) => {
    const ws = String(workspaceId)
    if (!installedBrowsers().some((b) => b.id === id)) return { ok: false, error: 'Not installed' }
    setBrowserFor(ws, id)
    forgetExternalPages(ws)
    broadcastToWindows('browsers:changed', { workspaceId: ws, id })
    if (id === 'builtin') return { ok: true }
    // Open it now: the first time, this is where the user signs in.
    try {
      await ensureRunning(id)
      await showBrowserWindow(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
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
