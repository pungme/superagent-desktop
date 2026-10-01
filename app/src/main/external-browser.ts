import {
  isGoogleSignInRejected,
  sessionCookieTime,
  signInRetryUrl,
  setHandsOff
} from './google-signin'
import { spawn, ChildProcess, execFile, execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import type { Readable, Writable } from 'stream'
import { homedir, tmpdir } from 'os'
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

const icons = new Map<BrowserId, string>()
/** Superagent's own icon file, handed over at registration (see index.ts). */
let ownIcon: string | undefined
const asDataUrl = (png: string): string =>
  `data:image/png;base64,${readFileSync(png).toString('base64')}`

/**
 * Each app's own icon for the picker, read from its bundle's .icns (macOS's
 * icon lookup answered with the generic app icon); Superagent's own for the
 * built-in browser. '' when it can't be read — the row shows its name alone.
 */
function browserIcon(id: BrowserId): string {
  const cached = icons.get(id)
  if (cached !== undefined) return cached
  let url = ''
  try {
    if (id === 'builtin') {
      if (ownIcon && existsSync(ownIcon)) url = asDataUrl(ownIcon)
    } else {
      const exe = executablePath(id)
      if (exe) {
        const contents = join(exe, '..', '..')
        const name = execFileSync(
          'plutil',
          ['-extract', 'CFBundleIconFile', 'raw', join(contents, 'Info.plist')],
          { encoding: 'utf8', timeout: 2000 }
        ).trim()
        const icns = join(contents, 'Resources', name.endsWith('.icns') ? name : `${name}.icns`)
        const out = join(mkdtempSync(join(tmpdir(), 'sa-icon-')), 'icon.png')
        execFileSync('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out], {
          timeout: 5000
        })
        url = asDataUrl(out)
        rmSync(join(out, '..'), { recursive: true, force: true })
      }
    }
  } catch {
    // no icon
  }
  icons.set(id, url)
  return url
}

export function browserName(id: BrowserId): string {
  return id === 'builtin' ? 'Superagent' : (APPS.find((a) => a.id === id)?.name ?? id)
}

/**
 * The browser is chosen per conversation, keyed by its pane ("project::chat").
 * It used to be per project, so switching one chat to Brave — or its agent
 * calling browser_use — switched every other chat in that project too,
 * including all of the standalone Chats, which share one project. A
 * conversation that never chose starts on the built-in browser.
 */
const kvKey = (scope: string): string => `browser:${scope}`

/** A conversation's browser scope: its pane id, or the project's for no chat. */
export function browserScope(workspaceId: string, chatId?: string | null): string {
  return chatId ? `${workspaceId}::${chatId}` : workspaceId
}

/** This conversation's pick — the built-in browser unless it chose one still installed. */
export function browserFor(scope: string): BrowserId {
  const v = kvGet(kvKey(scope)) as BrowserId | undefined
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
  scope: string,
  id: BrowserId,
  opts: { open?: boolean } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!installedBrowsers().some((b) => b.id === id)) return { ok: false, error: 'Not installed' }
  setBrowserFor(scope, id)
  forgetExternalPages(scope)
  broadcastToWindows('browsers:changed', { scope, id })
  if (id === 'builtin' || !opts.open) return { ok: true }
  try {
    await ensureRunning(id)
    // The project's panes were already showing (and waiting) when the browser
    // came up: fill them now.
    for (const paneId of watchers.keys())
      if (inScope(paneId, scope)) void adoptTab(paneId).catch(() => undefined)
    await showBrowserWindow(id)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function setBrowserFor(scope: string, id: BrowserId): void {
  kvSet(kvKey(scope), id)
}

/** The conversation a pane belongs to: "project::chat", whatever tab id follows. */
export function scopeOfPane(paneId: string): string {
  return paneId.split('::').slice(0, 2).join('::')
}

/** A pane belongs to a scope: its own conversation's, or every pane of a bare project. */
function inScope(paneId: string, scope: string): boolean {
  return scope.includes('::')
    ? scopeOfPane(paneId) === scope
    : workspaceIdFromPane(paneId) === scope
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
  const id = browserFor(scopeOfPane(paneId))
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

/** How long any one command to the browser may take before it counts as lost. */
const CDP_TIMEOUT_MS = 30_000

/** One running browser, spoken to over its pipe (NUL-delimited JSON, CDP). */
export class BrowserConnection {
  private seq = 0
  private buf = ''
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Set<Listener>()
  closed = false
  /** Every tab open in this browser, in the order they were opened (see watchTabs). */
  readonly tabs = new Map<string, { title: string; url: string }>()

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
      // Never wait for ever: a browser busy starting up or restoring its tabs
      // can leave a command unanswered, and the agent's step hung with it
      // ("Working 182s" and counting). An error it can retry instead.
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return
        reject(new Error(`The browser didn't answer (${method}). Try the step again.`))
      }, CDP_TIMEOUT_MS)
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          ;(resolve as (v: unknown) => void)(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
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
/** Opened for the user to sign in, with no remote control — see signInYourself. */
const signingIn = new Map<BrowserId, ChildProcess | null>()

/** How long an agent's browser step waits for the user to finish signing in. */
const signInWaitMs = (): number => (process.env.COVE_E2E_QUIET === '1' ? 1500 : 120_000)
/** How often the profile is checked for a finished sign-in. */
const SIGNED_IN_POLL_MS = 3000
/**
 * The browser writes cookies to disk at most 30 seconds after they change, and
 * closing it before then loses them — a sign-in made just before would be gone.
 * So a sign-in window is closed only once the profile has been saved since it
 * was told to finish (or this long has passed, which covers everything).
 */
const COOKIE_SAVE_MS = 31_000
/** Nobody finished and nobody came back: hand the browser back anyway. */
const SIGN_IN_IDLE_MS = 10 * 60_000
/**
 * How many real windows a process has on screen — a browser window, not a menu,
 * a tooltip, or the hidden one the browser keeps for itself. On a Mac closing a browser's last window doesn't quit it, so this is
 * how Superagent sees the user close the sign-in window. Read from the system's
 * window list (no permission needed); null when it can't be read.
 */
export function windowCount(pid: number): Promise<number | null> {
  const script = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
    const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
    let n = 0;
    for (let i = 0; i < arr.count; i++) {
      const d = arr.objectAtIndex(i);
      if (ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID')) !== ${Number(pid)}) continue;
      if (ObjC.unwrap(d.objectForKey('kCGWindowLayer')) !== 0) continue;
      // On screen only: the browser keeps a hidden window of its own that never goes.
      if (!ObjC.unwrap(d.objectForKey('kCGWindowIsOnscreen'))) continue;
      const b = ObjC.unwrap(d.objectForKey('kCGWindowBounds'));
      if (b && ObjC.unwrap(b.Height) > 200 && ObjC.unwrap(b.Width) > 200) n++;
    }
    n`
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 }, (err, out) => {
      const n = Number(String(out).trim())
      resolve(err || !Number.isFinite(n) ? null : n)
    })
  })
}

/** How each open sign-in window is told to finish (see finishSignIn). */
const finishers = new Map<BrowserId, (why: string) => void>()

/**
 * Open the agent's profile of a browser with remote control OFF, for the user
 * to sign in. Google refuses sign-in in any browser it can tell is remote
 * controlled ("This browser or app may not be secure"), but only at sign-in:
 * the session it leaves in the profile keeps working once the agent drives it
 * again.
 *
 * Ends by itself — the user should never have to close a window to get the
 * agent going again. It finishes when the sign-in shows in the profile's
 * cookies (made or refreshed), when the user sends a message anywhere in
 * Superagent (they're back), after ten minutes, or from the pane's "I'm signed
 * in". Quitting the browser by hand ends it too. Resolves when it's gone.
 */
export async function signInYourself(
  id: BrowserId,
  url = 'https://accounts.google.com',
  opts: { cookieHost?: string; saveMs?: number; idleMs?: number } = {}
): Promise<void> {
  const bin = executablePath(id)
  if (!bin) throw new Error(`${browserName(id)} isn't installed.`)
  if (signingIn.has(id)) return
  // Claimed before the agent's copy is closed: an agent step landing in that
  // gap would otherwise start it again and take the profile back.
  signingIn.set(id, null)
  try {
    await stopBrowser(id)
  } catch (err) {
    signingIn.delete(id)
    throw err
  }
  const profile = profileDir(id)
  mkdirSync(profile, { recursive: true })
  const cookies = join(profile, 'Default')
  const before = sessionCookieTime(cookies, opts.cookieHost)
  const proc = spawn(
    bin,
    [
      ...(process.env.COVE_E2E_QUIET === '1' ? ['--headless=new'] : []),
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      url
    ],
    { stdio: 'ignore', detached: true }
  )
  signingIn.set(id, proc)
  const say = (state: 'signing-in' | 'signed-in' | 'off'): void =>
    broadcastToWindows('browsers:signing-in', {
      name: browserName(id),
      on: state !== 'off',
      signedIn: state === 'signed-in'
    })
  say('signing-in')
  const savedAt = (): number => {
    try {
      return statSync(join(cookies, 'Cookies')).mtimeMs
    } catch {
      return 0
    }
  }
  let finishing = false
  let wait: ReturnType<typeof setInterval> | null = null
  let cap: ReturnType<typeof setTimeout> | null = null
  /** `saved`: the sign-in is already on disk (we read it there), so no wait for a save. */
  const finish = (saved = false): void => {
    if (finishing) return
    finishing = true
    say('signed-in')
    const from = Date.now()
    const done = (): void => {
      if (wait) clearInterval(wait)
      if (cap) clearTimeout(cap)
      proc.kill('SIGTERM')
    }
    // Saved since we were told: nothing of the sign-in is left in memory.
    wait = setInterval(() => {
      if (savedAt() > from) done()
    }, 1000)
    cap = setTimeout(done, saved ? 3000 : (opts.saveMs ?? COOKIE_SAVE_MS))
  }
  finishers.set(id, () => finish())
  // Its windows: once there has been one and there are none (twice running, so
  // a window being swapped doesn't count), the user closed it.
  let hadWindow = false
  let noneSeen = 0
  let polling = false
  const poll = setInterval(() => {
    if (sessionCookieTime(cookies, opts.cookieHost) > before) return finish(true)
    if (polling || !proc.pid) return
    polling = true
    void windowCount(proc.pid).then((n) => {
      polling = false
      if (n === null) return
      if (n > 0) {
        hadWindow = true
        noneSeen = 0
      } else if (hadWindow && ++noneSeen >= 2) finish()
    })
  }, SIGNED_IN_POLL_MS)
  const idle = setTimeout(finish, opts.idleMs ?? SIGN_IN_IDLE_MS)
  await new Promise<void>((resolve) => {
    proc.once('exit', () => {
      clearInterval(poll)
      clearTimeout(idle)
      if (wait) clearInterval(wait)
      if (cap) clearTimeout(cap)
      finishers.delete(id)
      signingIn.delete(id)
      say('off')
      resolve()
    })
  })
}

/**
 * The user is done with the sign-in window, or back in Superagent: close it
 * (once its cookies are saved) and give the browser back to the agent.
 * All of them when no browser is named. False when none was open.
 */
export function finishSignIn(id?: BrowserId): boolean {
  const ids = id ? [id] : [...finishers.keys()]
  for (const b of ids) finishers.get(b)?.('')
  return ids.some((b) => finishers.has(b))
}

/** Close a sign-in window Superagent opened (on quit, or from the pane). */
export function endSignIn(id: BrowserId): void {
  signingIn.get(id)?.kill('SIGTERM')
}

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
  // The user is signing in (signInYourself): wait for them rather than fail —
  // an agent told "try again later" tried again at once, over and over.
  const waitUntil = Date.now() + signInWaitMs()
  while (signingIn.has(id) && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 500))
  if (signingIn.has(id))
    throw new Error(
      `The user is still signing in to ${browserName(id)} in its own window. It hands the ` +
        'browser back by itself as soon as they have (or when they next send a message). Ask ' +
        'them to finish signing in there, then wait for their reply before trying again.'
    )
  const again = running.get(id)
  if (again && !again.closed) return again
  const bin = executablePath(id)
  if (!bin) throw new Error(`${browserName(id)} isn't installed.`)
  const profile = profileDir(id)
  mkdirSync(profile, { recursive: true })
  const proc = spawn(
    bin,
    [
      '--remote-debugging-pipe',
      // Keep drawing when the window is covered or the tab is in the
      // background. A browser stops painting what it thinks nobody can see —
      // Brave behind Superagent's own window — and then a screenshot or the
      // pane's live view waits for a frame that never comes: the agent's step
      // hung ("Working 511s"). The flags every automation tool starts with.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
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
  watchTabs(id, conn)
  return conn
}

/**
 * Follow every tab in the browser, the user's own included: the agent can list
 * them and move to one (externalTabs), and a Google sign-in turned away in any
 * of them reopens the browser without remote control (signInYourself).
 *
 * Watched for the whole browser rather than per tab. Google's sign-in moves
 * between its pages without loading one (history.pushState), which a tab's
 * Page.frameNavigated never reports; and the tab it happens in is often one
 * the user opened themselves, which the agent isn't attached to at all.
 */
function watchTabs(id: BrowserId, conn: BrowserConnection): void {
  // Only a tab ARRIVING at the refusal counts. The browser restores its tabs
  // when it starts, the refused page among them, and reacting to a page that
  // was already there handed the browser straight back to the user, for ever.
  const refused = new Set<string>()
  conn.on((method, params) => {
    if (method === 'Target.targetDestroyed') {
      conn.tabs.delete(String(params.targetId))
      refused.delete(String(params.targetId))
      return
    }
    if (method !== 'Target.targetInfoChanged' && method !== 'Target.targetCreated') return
    const info = params.targetInfo as
      { targetId?: string; type?: string; url?: string; title?: string } | undefined
    if (!info?.targetId || info.type !== 'page') return
    const url = info.url ?? ''
    // The browser's own pages (DevTools, extension pages) aren't tabs to offer.
    if (/^(devtools|chrome-extension):/.test(url)) conn.tabs.delete(info.targetId)
    else conn.tabs.set(info.targetId, { title: info.title ?? '', url })
    const now = isGoogleSignInRejected(url)
    const was = refused.has(info.targetId)
    if (now) refused.add(info.targetId)
    else refused.delete(info.targetId)
    if (now && !was && method === 'Target.targetInfoChanged')
      void signInYourself(id, signInRetryUrl(url)).catch(() => undefined)
  })
  conn.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
}

/**
 * On quit: close the browsers Superagent started. They run with remote control
 * switched on, which shouldn't outlive the app that asked for it — and "quit
 * means quit" already holds for every agent and routine it started. (Closing
 * the pipe alone would do it too; SIGTERM is the prompt, clean way.)
 */
export function closeExternalBrowsers(): void {
  for (const id of [...signingIn.keys()]) endSignIn(id)
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

/** Take a tab for a pane: attach to it and make it the one the pane's tools act on. */
async function attach(
  paneId: string,
  id: BrowserId,
  conn: BrowserConnection,
  targetId: string
): Promise<ExternalPage> {
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
  return attach(paneId, id, conn, targetId)
}

/** A tab in the external browser, as the agent's tab tools list it. */
export interface ExternalTab {
  targetId: string
  title: string
  url: string
  /** The tab this pane's tools act on. */
  mine: boolean
  /** Another chat's agent is working in it. */
  taken: boolean
}

/**
 * Every tab open in the project's external browser, oldest first — the ones the
 * user opened themselves included, so "look at the tab I just opened" works.
 */
export async function externalTabs(paneId: string, id: BrowserId): Promise<ExternalTab[]> {
  const conn = await ensureRunning(id)
  const mine = existingExternalPage(paneId)?.targetId
  const others = new Set(
    [...pages]
      .filter(([p, page]) => p !== paneId && !page.session.closed)
      .map(([, p]) => p.targetId)
  )
  // Titles and addresses asked for now (the events that fill conn.tabs lag a
  // page's title); the order is conn.tabs', which is the order they were opened.
  const { targetInfos } = await conn.send<{
    targetInfos: { targetId: string; type: string; url: string; title: string }[]
  }>('Target.getTargets')
  const live = new Map(
    targetInfos
      .filter((t) => t.type === 'page' && !/^(devtools|chrome-extension):/.test(t.url))
      .map((t) => [t.targetId, t])
  )
  const order = [...conn.tabs.keys()].filter((id) => live.has(id))
  for (const id of live.keys()) if (!order.includes(id)) order.push(id)
  return order.map((targetId) => ({
    targetId,
    title: live.get(targetId)!.title,
    url: live.get(targetId)!.url,
    mine: targetId === mine,
    taken: others.has(targetId)
  }))
}

/**
 * A pane shown with no tab of its own yet: give it the browser's newest tab
 * that no other chat is using (or a new one), so the pane streams at once.
 * Only when the browser is already running — showing a project never launches
 * it on its own; picking it, or the agent's first step, does.
 */
async function adoptTab(paneId: string): Promise<ExternalPage | null> {
  const id = externalBrowserForPane(paneId)
  if (!id) return null
  const conn = running.get(id)
  if (!conn || conn.closed || signingIn.has(id)) return null
  if (existingExternalPage(paneId)) return null
  const taken = new Set([...pages.values()].filter((p) => !p.session.closed).map((p) => p.targetId))
  const { targetInfos } = await conn.send<{
    targetInfos: { targetId: string; type: string; url: string }[]
  }>('Target.getTargets')
  const open = targetInfos.filter(
    (t) =>
      t.type === 'page' && !/^(devtools|chrome-extension):/.test(t.url) && !taken.has(t.targetId)
  )
  // The newest, by the order this browser opened them (see watchTabs).
  const order = [...conn.tabs.keys()]
  const newest =
    [...open].sort((a, b) => order.indexOf(b.targetId) - order.indexOf(a.targetId))[0] ?? null
  if (existingExternalPage(paneId)) return null
  return newest ? attach(paneId, id, conn, newest.targetId) : externalPage(paneId, id)
}

/** Move a pane's tools to another tab. The tab they leave stays open. */
export async function switchExternalTab(
  paneId: string,
  id: BrowserId,
  targetId: string
): Promise<ExternalPage> {
  const conn = await ensureRunning(id)
  const was = existingExternalPage(paneId)
  if (was?.targetId === targetId) return was
  const page = await attach(paneId, id, conn, targetId)
  if (was)
    void conn.send('Target.detachFromTarget', { sessionId: was.session.sessionId }).catch(() => {})
  return page
}

/** Open a new tab and move the pane's tools to it. */
export async function openExternalTab(
  paneId: string,
  id: BrowserId,
  url?: string
): Promise<ExternalPage> {
  const conn = await ensureRunning(id)
  const { targetId } = await conn.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank'
  })
  const page = await switchExternalTab(paneId, id, targetId)
  if (url) await page.loadURL(url)
  return page
}

/** Close a tab. The pane whose tab it was opens a new one on its next step. */
export async function closeExternalTab(id: BrowserId, targetId: string): Promise<void> {
  const conn = await ensureRunning(id)
  await conn.send('Target.closeTarget', { targetId }).catch(() => {})
  conn.tabs.delete(targetId)
  for (const [paneId, page] of pages) if (page.targetId === targetId) pages.delete(paneId)
}

/** Pick a different browser for a project: its tabs there are closed. */
export function forgetExternalPages(scope: string): void {
  for (const [paneId, page] of pages) {
    if (inScope(paneId, scope)) {
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

export function registerExternalBrowserIpc(appIcon?: string): void {
  ownIcon = appIcon
  ipcMain.handle('browsers:list', () =>
    installedBrowsers().map((b) => ({ ...b, icon: browserIcon(b.id) }))
  )
  // Not awaited: it resolves only when the user closes the sign-in window.
  // The user's own browser, for the built-in pane's "Continue in Brave".
  ipcMain.handle('browsers:yours', () => {
    const id = yourBrowser()
    return id ? { id, name: browserName(id) } : null
  })
  /**
   * Google refused the built-in pane: move this conversation to the user's own
   * browser and open the sign-in there, without the agent, going on to the
   * page they were headed for. One click instead of "switch the pill, then
   * Sign in yourself…".
   */
  ipcMain.handle('browsers:continue-in-yours', async (_e, paneId: string, url: string) => {
    const id = yourBrowser()
    if (!id) return { ok: false, error: 'Brave, Chrome or Edge is needed to sign in to Google.' }
    const r = await switchBrowser(scopeOfPane(String(paneId)), id)
    if (!r.ok) return r
    setHandsOff(String(paneId), false)
    void signInYourself(id, signInRetryUrl(String(url))).catch(() => undefined)
    return { ok: true, name: browserName(id) }
  })
  ipcMain.handle('browsers:sign-in', (_e, id: BrowserId) => {
    void signInYourself(id).catch(() => undefined)
    return { ok: true }
  })
  // The pane's "I'm signed in".
  ipcMain.handle('browsers:sign-in-done', () => finishSignIn())
  ipcMain.handle('browsers:get', (_e, scope: string) => browserFor(String(scope)))
  // Picked on the pill: open it now — the first time, this is where the user signs in.
  ipcMain.handle('browsers:set', (_e, scope: string, id: BrowserId) =>
    switchBrowser(String(scope), id, { open: true })
  )
  ipcMain.handle('browsers:show', async (_e, paneId: string) => {
    const id = externalBrowserForPane(String(paneId))
    if (!id) return
    await showBrowserWindow(id, String(paneId))
  })
  ipcMain.on('browsers:watch', (e, paneId: string) => {
    const page = existingExternalPage(String(paneId))
    if (page) void startScreencast(String(paneId), page, e.sender)
    else {
      watchers.set(String(paneId), { to: e.sender, stop: () => {} })
      // Show the browser straight away rather than a blank "waiting" pane:
      // take its newest tab (onExternalPage below starts the stream).
      void adoptTab(String(paneId)).catch(() => undefined)
    }
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
