import {
  HANDS_OFF_MESSAGE,
  SIGN_IN_REFUSED_MESSAGE,
  isHandsOff,
  isSignInRefused
} from './google-signin'
import { BrowserWindow, WebContents, WebFrameMain, ipcMain } from 'electron'
import { statSync } from 'fs'
import { isAbsolute } from 'path'
import {
  UPLOAD_TARGET_JS,
  fileInputJs,
  frameCornerJs,
  locateJs,
  readFrameJs,
  scrollJs,
  selectJs
} from './page-scripts'
import {
  ensureBackgroundPane,
  getPaneWebContents,
  paneLog,
  withoutStealingFocus,
  markAgentLoad
} from './browser'
import { broadcastToWindows, pushBounded, normalizeUrl } from './util'
import { externalBrowserForPane, externalPage, ExternalPage } from './external-browser'

/**
 * Browser automation primitives operating on a workspace's browser pane.
 * Used by the MCP server; every action is visible in the pane (principle #5).
 *
 * Page reading uses the indexed-interactive-element model: read_page returns
 * numbered visible elements, click targets an index or visible text. Text
 * targeting survives DOM shifts (modals) better than indices.
 *
 * The scripts that run in the page are in page-scripts.ts. What is here is the
 * part only main can do: putting the frames of a page together, sending input,
 * and answering the dialogs a page puts up.
 */

interface ConsoleEntry {
  level: string
  message: string
  ts: number
}

interface NetEntry {
  url: string
  status?: number
  failed?: string
  ts: number
}

const consoleBuffers = new Map<string, ConsoleEntry[]>()
const netBuffers = new Map<string, NetEntry[]>()
const attached = new Set<string>()
const stopped = new Set<string>()

/** Notify the renderer that Claude is acting on this pane (drives the "Claude is browsing" indicator). */
export function signalActivity(paneId: string): void {
  broadcastToWindows('browser:activity', paneId)
}

/** User pressed Stop: detach the debugger and reject the next tool call for a short cooldown. */
export function stopAutomation(paneId: string): void {
  stopped.add(paneId)
  const contents = getPaneWebContents(paneId)
  if (contents && attached.has(paneId)) {
    try {
      contents.debugger.detach()
    } catch {
      // already detached
    }
    attached.delete(paneId)
  }
  setTimeout(() => stopped.delete(paneId), 2000)
}

function assertNotStopped(paneId: string): void {
  if (stopped.has(paneId)) throw new Error('Browsing was stopped by the user.')
}

export function registerAutomationIpc(): void {
  ipcMain.on('browser:stop-automation', (_e, paneId: string) => stopAutomation(paneId))
}

/**
 * `quiet`: the phone is watching (mirroring the page, or opening one for you),
 * not the agent acting. Don't announce "the agent is browsing": that signal
 * opens the pane in the Mac's window, and the phone asks for a frame about once
 * a second, so the browser kept popping up on the desktop while you watched it
 * on your phone.
 */
interface Quiet {
  quiet?: boolean
}

function wc(paneId: string, opts: Quiet = {}): WebContents {
  assertNotStopped(paneId)
  // The user is signing in to Google here: the agent waits (the phone's
  // mirror may still look).
  if (!opts.quiet && isHandsOff(paneId))
    throw new Error(isSignInRefused(paneId) ? SIGN_IN_REFUSED_MESSAGE : HANDS_OFF_MESSAGE)
  let contents = getPaneWebContents(paneId)
  // A chat driven from the phone, or one the Mac isn't showing, has no pane
  // yet: the window's chat view is what normally makes one. Give it the same
  // live-but-hidden pane the window adopts when the chat opens, instead of
  // telling the agent the browser is closed.
  if (!contents) {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      ensureBackgroundPane(win, paneId)
      contents = getPaneWebContents(paneId)
    }
  }
  if (!contents) throw new Error(`No browser pane "${paneId}" — is the browser open?`)
  if (!opts.quiet) signalActivity(paneId)
  return contents
}

/**
 * What every tool needs from a page, whichever browser it's in: the built-in
 * pane (an Electron WebContents plus its debugger) or a tab in the user's real
 * browser (an ExternalPage over CDP). The tools below are written against this
 * and nothing else, so they work the same in both.
 */
interface PageDriver {
  loadURL(url: string): Promise<void>
  getURL(): Promise<string>
  executeJavaScript(expression: string): Promise<unknown>
  sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** Console and network events, into the pane's buffers — same shape from either browser. */
function recordCdpEvent(paneId: string, method: string, params: Record<string, unknown>): void {
  if (method === 'Runtime.consoleAPICalled') {
    const args = (params.args ?? []) as { value?: unknown; description?: string }[]
    const message = args
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
      .join(' ')
    pushBounded(consoleBuffers, paneId, {
      level: String(params.type),
      message: message.slice(0, 500),
      ts: Date.now()
    })
  } else if (method === 'Network.responseReceived') {
    const response = params.response as { url?: string; status?: number } | undefined
    pushBounded(netBuffers, paneId, {
      url: response?.url ?? '(unknown)',
      status: response?.status,
      ts: Date.now()
    })
  } else if (method === 'Network.loadingFailed') {
    const request = params.request as { url?: string } | undefined
    pushBounded(netBuffers, paneId, {
      url: request?.url ?? '(unknown)',
      failed: String(params.errorText ?? ''),
      ts: Date.now()
    })
  }
}

/**
 * JavaScript dialogs: alert, confirm, prompt, and the "leave this page?" one.
 *
 * A dialog stops the page, and the agent with it: in the built-in pane it was a
 * native box only a person could answer, in the user's own browser a modal the
 * tools could not see. So while the agent is the one acting, the dialog is
 * answered here and the agent is told what it said and how it was answered.
 *
 * Unasked, an alert is acknowledged and leaving a page is allowed, but a
 * question (confirm, prompt) is answered Cancel: "Delete everything?" is not
 * something to say yes to on the agent's behalf by default. browser_dialog
 * says how the next one should be answered instead.
 */
type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'
const dialogPlans = new Map<string, { accept: boolean; text?: string }>()
const dialogNotes = new Map<string, string[]>()
const lastToolAt = new Map<string, number>()
/** How long after a tool call a dialog is taken to be the agent's doing. */
const AGENT_WINDOW_MS = 30_000

function agentActing(paneId: string): boolean {
  return Date.now() - (lastToolAt.get(paneId) ?? 0) < AGENT_WINDOW_MS
}

/**
 * prompt() in the built-in pane never reaches main: Electron answers it null
 * before anyone is asked. So the page's own prompt is replaced with one that
 * reads the plan left for it (browser_dialog) and writes down what happened,
 * for the next tool result to report.
 */
const PROMPT_SHIM_JS = `(() => {
  if (window.__coveDialogs) return;
  window.__coveDialogs = [];
  window.prompt = function (message, fallback) {
    const plan = window.__covePrompt;
    window.__covePrompt = null;
    const accept = !!(plan && plan.accept);
    const text = accept ? String(plan.text !== undefined && plan.text !== null ? plan.text : fallback === undefined ? '' : fallback) : '';
    window.__coveDialogs.push({ message: String(message === undefined ? '' : message), accept, text, planned: !!plan });
    return accept ? text : null;
  };
})()`

/** Say how the next dialog on this pane is to be answered. One dialog's worth. */
export async function planDialog(paneId: string, accept: boolean, text?: string): Promise<string> {
  dialogPlans.set(paneId, { accept, text })
  if (!externalBrowserForPane(paneId)) {
    await getPaneWebContents(paneId)
      ?.executeJavaScript(
        `${PROMPT_SHIM_JS}; window.__covePrompt = ${JSON.stringify({ accept, text: text ?? null })}; true`
      )
      .catch(() => {})
  }
  return `The next dialog will be answered ${accept ? 'OK' : 'Cancel'}${
    text !== undefined ? ` with "${text}"` : ''
  }. Now do the thing that brings it up.`
}

/** Write down what a dialog said and how it was answered, for the agent. */
function noteDialog(
  paneId: string,
  type: DialogType,
  message: string,
  accept: boolean,
  text: string,
  planned: boolean
): void {
  const what =
    type === 'alert'
      ? 'an alert'
      : type === 'beforeunload'
        ? 'a "leave this page?" dialog'
        : `a ${type} dialog`
  const how =
    type === 'alert'
      ? 'acknowledged'
      : accept
        ? type === 'prompt'
          ? `answered "${text}"`
          : type === 'beforeunload'
            ? 'left the page'
            : 'answered OK'
        : 'answered Cancel'
  const hint =
    !planned && !accept
      ? ` To answer OK instead, call browser_dialog first (accept: true${
          type === 'prompt' ? ', and text' : ''
        }), then repeat the action.`
      : ''
  const said = message ? `: "${message.slice(0, 300)}"` : ''
  const notes = dialogNotes.get(paneId) ?? []
  notes.push(`The page showed ${what}${said} — ${how}.${hint}`)
  dialogNotes.set(paneId, notes.slice(-5))
}

export function answerDialog(
  paneId: string,
  type: DialogType,
  message: string,
  defaultPrompt = ''
): { accept: boolean; text: string } {
  const plan = dialogPlans.get(paneId)
  dialogPlans.delete(paneId)
  const accept = plan ? plan.accept : type === 'alert' || type === 'beforeunload'
  const text = type === 'prompt' && accept ? (plan?.text ?? defaultPrompt) : ''
  noteDialog(paneId, type, message, accept, text, !!plan)
  return { accept, text }
}

/** What the page said in dialogs since the last tool result, once. */
function takeDialogNotes(paneId: string): string[] {
  const notes = dialogNotes.get(paneId) ?? []
  dialogNotes.delete(paneId)
  return notes
}

/** A tool's answer, with anything a dialog said while it ran. */
async function withDialogs(paneId: string, result: string, settleMs = 60): Promise<string> {
  // A dialog raised by a click arrives a moment after the click returns.
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs))
  // What the page's own prompt() wrote down (see PROMPT_SHIM_JS). A plan a
  // confirm already used is taken back from the page, and one a prompt used is
  // forgotten here: it was for one dialog, whichever kind came.
  if (!externalBrowserForPane(paneId)) {
    const keep = dialogPlans.has(paneId)
    const seen = (await getPaneWebContents(paneId)
      ?.executeJavaScript(
        `(() => { const d = window.__coveDialogs || []; if (window.__coveDialogs) window.__coveDialogs = []; ${
          keep ? '' : 'window.__covePrompt = null;'
        } return d; })()`
      )
      .catch(() => [])) as
      { message: string; accept: boolean; text: string; planned: boolean }[] | undefined
    for (const d of seen ?? []) {
      if (d.planned) dialogPlans.delete(paneId)
      noteDialog(paneId, 'prompt', d.message, d.accept, d.text, d.planned)
    }
  }
  const notes = takeDialogNotes(paneId)
  return notes.length ? `${result}\n${notes.join('\n')}` : result
}

const dialogHooked = new WeakSet<WebContents>()

/**
 * The built-in pane: Electron asks its own listener to show a native box for
 * each dialog. Stand in front of it — answer while the agent is acting, and
 * hand the rest (the user's own browsing) to the box as before.
 */
function hookDialogs(contents: WebContents, paneId: string): void {
  if (dialogHooked.has(contents)) return
  dialogHooked.add(contents)
  type Answer = (accept: boolean, text?: string) => void
  type Info = { dialogType?: string; messageText?: string; defaultPromptText?: string }
  // In every document of this pane from here on, and in the one showing now.
  const shim = (): void => void contents.executeJavaScript(PROMPT_SHIM_JS).catch(() => {})
  contents.on('dom-ready', () => {
    shim()
    const plan = dialogPlans.get(paneId)
    if (plan)
      void contents
        .executeJavaScript(
          `window.__covePrompt = ${JSON.stringify({ accept: plan.accept, text: plan.text ?? null })}; true`
        )
        .catch(() => {})
  })
  shim()
  const emitter = contents as unknown as NodeJS.EventEmitter
  const native = emitter.listeners('-run-dialog') as ((info: Info, cb: Answer) => void)[]
  emitter.removeAllListeners('-run-dialog')
  emitter.on('-run-dialog', (info: Info, callback: Answer) => {
    if (!agentActing(paneId)) {
      if (native.length) for (const l of native) l.call(contents, info, callback)
      else callback(false, '')
      return
    }
    const type = (
      info.dialogType === 'prompt' || info.dialogType === 'confirm' ? info.dialogType : 'alert'
    ) as DialogType
    const a = answerDialog(paneId, type, info.messageText ?? '', info.defaultPromptText ?? '')
    callback(a.accept, a.text)
  })
  // A page that asks "leave?" simply stays put unless told otherwise, which to
  // an agent is a navigation that did nothing.
  contents.on('will-prevent-unload', (e) => {
    if (!agentActing(paneId)) return
    if (answerDialog(paneId, 'beforeunload', '').accept) e.preventDefault()
  })
}

const listening = new WeakSet<ExternalPage>()

/**
 * The user is signing in to Google in this pane: wait for them rather than fail
 * at once — an agent told "try again later" tries again straight away.
 */
async function untilSignedIn(paneId: string, opts: Quiet = {}): Promise<void> {
  if (opts.quiet) return
  const until = Date.now() + (process.env.COVE_E2E_QUIET === '1' ? 1500 : 120_000)
  // Refused outright: waiting gets nowhere — the agent is told to switch browsers.
  while (isHandsOff(paneId) && !isSignInRefused(paneId) && Date.now() < until)
    await new Promise((r) => setTimeout(r, 500))
}

/** The page this pane's tools act on: its tab in the project's external browser, or the pane. */
async function driver(paneId: string, opts: Quiet = {}): Promise<PageDriver> {
  assertNotStopped(paneId)
  await untilSignedIn(paneId, opts)
  const external = externalBrowserForPane(paneId)
  if (!opts.quiet) lastToolAt.set(paneId, Date.now())
  if (!external) {
    const contents = wc(paneId, opts)
    hookDialogs(contents, paneId)
    return {
      loadURL: (url) => contents.loadURL(url),
      getURL: async () => contents.getURL(),
      executeJavaScript: (expression) => contents.executeJavaScript(expression),
      sendCommand: <T>(method: string, params?: Record<string, unknown>) =>
        ensureDebugger(paneId, opts).debugger.sendCommand(method, params) as Promise<T>
    }
  }
  if (!opts.quiet) signalActivity(paneId)
  const page = await externalPage(paneId, external)
  if (!listening.has(page)) {
    listening.add(page)
    page.session.on((method, params) => {
      recordCdpEvent(paneId, method, params)
      // The user's own browser shows the dialog itself; answer it only when it
      // is the agent's doing, so their own browsing keeps its dialogs.
      if (method !== 'Page.javascriptDialogOpening' || !agentActing(paneId)) return
      const p = params as { type?: DialogType; message?: string; defaultPrompt?: string }
      const a = answerDialog(paneId, p.type ?? 'alert', p.message ?? '', p.defaultPrompt ?? '')
      void page.session
        .send('Page.handleJavaScriptDialog', { accept: a.accept, promptText: a.text })
        .catch(() => {})
    })
  }
  return page
}

// Attaching the CDP debugger flips navigator.webdriver → true, which hostile
// sites (X, Google) read as a bot and block. This masks it back to false on the
// user's own browser/logins. Runs before any page script on every document.
const WEBDRIVER_MASK =
  "Object.defineProperty(navigator,'webdriver',{get:()=>false,configurable:true});"

function ensureDebugger(paneId: string, opts: Quiet = {}): WebContents {
  // Reattaching mid-sign-in would get the user turned away again.
  if (isHandsOff(paneId))
    throw new Error(isSignInRefused(paneId) ? SIGN_IN_REFUSED_MESSAGE : HANDS_OFF_MESSAGE)
  const contents = wc(paneId, opts)
  if (!attached.has(paneId)) {
    contents.debugger.attach('1.3')
    attached.add(paneId)
    contents.once('destroyed', () => {
      attached.delete(paneId)
      consoleBuffers.delete(paneId)
      netBuffers.delete(paneId)
    })
    contents.debugger.on('detach', () => attached.delete(paneId))
    contents.debugger.on('message', (_e, method, params) => recordCdpEvent(paneId, method, params))
    contents.debugger.sendCommand('Runtime.enable').catch(() => {})
    contents.debugger.sendCommand('Network.enable').catch(() => {})
    // The one thing this session must undo: attaching the debugger flips
    // navigator.webdriver true, so mask it back to false. Nothing else is
    // spoofed — the pane presents as the honest Chromium it is, the same
    // whether the agent is driving or you are (see the note by
    // applyBrowserIdentity), so its story never changes mid-session.
    contents.debugger
      .sendCommand('Page.enable')
      .then(() =>
        contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: WEBDRIVER_MASK
        })
      )
      .catch(() => {})
    contents.executeJavaScript(WEBDRIVER_MASK).catch(() => {})
  }
  return contents
}

/** Poll until `check` is true or the timeout elapses. Used to await a lazily-created pane. */
async function pollUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!check() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Reject if `p` doesn't settle within `ms`. executeJavaScript against a page that
 * never becomes idle (heavy SPAs, a stuck load) can hang forever — a hang inside a
 * routine used to burn the whole 5-minute budget silently. This turns it into a
 * normal tool error the agent can see and recover from.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

export async function navigate(paneId: string, url: string, opts: Quiet = {}): Promise<string> {
  // The whole call runs behind the focus guard: pane creation, attachment and
  // the load itself are all points where the page can ask macOS to raise us.
  return withoutStealingFocus(() => navigateInner(paneId, url, opts))
}

async function navigateInner(paneId: string, url: string, opts: Quiet = {}): Promise<string> {
  await untilSignedIn(paneId, opts)
  // The project browses in the user's real browser: open the pane so its live
  // view shows, then drive that tab. None of the built-in pane's cold-start
  // dance applies — there's no WebContents to wait for.
  if (externalBrowserForPane(paneId)) {
    if (!opts.quiet) broadcastToWindows('browser:request-open', paneId)
    const page = await driver(paneId, opts)
    await page.loadURL(normalizeUrl(url))
    return page.getURL()
  }
  // Cold start: the agent may drive the browser before the user has opened the
  // preview, so no pane exists yet. Ask the renderer to open it — EXCEPT for
  // routine panes, which carry a "::routine" suffix and run offscreen. Note the
  // suffix test is "::routine" specifically: a per-chat pane is "<ws>::<chatId>"
  // and DOES need the reveal (this gate used to be `.includes('::')`, which
  // silently skipped every per-chat pane — "there's no pane to drive").
  // A quiet navigate (the phone opening a page) needs the pane to exist already
  // — the phone's handler makes a hidden one — and must not reveal it.
  if (!paneId.endsWith('::routine') && !opts.quiet) {
    // Always ask the UI to reveal the pane. A pane whose WebContents already
    // exists but is *hidden* (the user closed the preview) would otherwise be
    // navigated invisibly — the "sometimes it doesn't open" bug. If no pane
    // exists yet, wait briefly for the renderer to create it.
    const existed = !!getPaneWebContents(paneId)
    broadcastToWindows('browser:request-open', paneId)
    if (!existed) {
      await pollUntil(() => !!getPaneWebContents(paneId), 3000)
      paneLog(
        'agent-navigate-coldstart',
        paneId,
        getPaneWebContents(paneId) ? 'pane-appeared' : 'PANE-NEVER-APPEARED'
      )
      // The renderer's pane mount fires its own initial load (saved URL or the
      // empty state) right after creation — navigating in the same tick got our
      // load ERR_ABORTED and left the pane blank (seen live: levantto-shop).
      // Let the mount settle before we drive it.
      await new Promise((r) => setTimeout(r, 350))
    }
  }
  const contents = wc(paneId, opts)
  const target = normalizeUrl(url)
  // The agent drives the user's own browser on their own machine — real sites
  // included (that's the whole point of browser automation / routines).
  paneLog('load-start', paneId, target.slice(0, 60))
  markAgentLoad(paneId)
  try {
    await contents.loadURL(target)
    paneLog('load-done', paneId)
  } catch (err) {
    if (/ERR_ABORTED/.test(String(err))) {
      // Superseded by a competing navigation (pane init, a redirect) — ours
      // still matters, so try once more after the dust settles.
      paneLog('agent-navigate-aborted-retry', paneId, target.slice(0, 120))
      await new Promise((r) => setTimeout(r, 600))
      await wc(paneId, opts).loadURL(target)
    } else {
      // A rejected loadURL leaves the pane blank — the empty-pane report.
      // Record it here too (did-fail-load in browser.ts has the event view).
      paneLog(
        'agent-navigate-failed',
        paneId,
        `${target.slice(0, 120)} ${String(err).slice(0, 160)}`
      )
      throw err
    }
  }
  markAgentLoad(paneId)
  paneLog('agent-navigate', paneId, contents.getURL().slice(0, 120))
  return contents.getURL()
}

export async function screenshot(paneId: string, opts: Quiet = {}): Promise<string> {
  return withoutStealingFocus(async () => {
    const page = await driver(paneId, opts)
    const { data } = await page.sendCommand<{ data: string }>('Page.captureScreenshot', {
      format: 'png'
    })
    return data
  })
}

/**
 * One document the page scripts are run in: the page itself, or a frame on
 * another origin, which the page's own script cannot see into.
 */
interface Root {
  /** '' for the page; for a frame, what the agent is told it is. */
  label: string
  exec(js: string): Promise<unknown>
  /** Where this document starts on the page (0,0 for the page itself), scrolling
   *  its frame into view first when asked. Null when the frame is not showing. */
  corner(reveal: boolean): Promise<{ x: number; y: number; w: number; h: number } | null>
}

const MAX_FOREIGN_FRAMES = 8

function frameOrigin(f: WebFrameMain): string {
  try {
    return f.origin
  } catch {
    return ''
  }
}

/**
 * The page, then each frame on a different origin from the one around it — a
 * card form, an embedded editor, a consent box. Frames on the same origin are
 * read from their parent and need no entry of their own. Only the built-in
 * pane can reach into another origin's frame this way.
 */
function rootsOf(paneId: string, page: PageDriver): Root[] {
  const top: Root = {
    label: '',
    exec: (js) => page.executeJavaScript(js),
    corner: async () => ({ x: 0, y: 0, w: Infinity, h: Infinity })
  }
  if (externalBrowserForPane(paneId)) return [top]
  const contents = getPaneWebContents(paneId)
  if (!contents) return [top]
  let frames: WebFrameMain[] = []
  try {
    frames = contents.mainFrame.framesInSubtree.filter(
      (f) => f !== contents.mainFrame && !!f.parent && frameOrigin(f) !== frameOrigin(f.parent)
    )
  } catch {
    frames = []
  }
  return [
    top,
    ...frames.slice(0, MAX_FOREIGN_FRAMES).map((frame): Root => {
      let host = frame.url
      try {
        host = new URL(frame.url).host || frame.url
      } catch {
        // an about: or data: frame — its whole address is its name
      }
      return {
        label: `iframe ${host}`.slice(0, 80),
        exec: (js) => frame.executeJavaScript(js),
        corner: async (reveal) => {
          // From the outermost frame in: each parent says where its child sits.
          const chain: WebFrameMain[] = []
          for (let f: WebFrameMain | null = frame; f && f.parent; f = f.parent) chain.unshift(f)
          let x = 0
          let y = 0
          let w = 0
          let h = 0
          for (const f of chain) {
            const parent = f.parent!
            const c = (await parent.executeJavaScript(
              frameCornerJs(f.url, f.name, parent.frames.indexOf(f), reveal)
            )) as { x: number; y: number; w: number; h: number } | null
            if (!c) return null
            x += c.x
            y += c.y
            w = c.w
            h = c.h
          }
          return { x, y, w, h }
        }
      }
    })
  ]
}

/** Which document each run of element numbers belongs to, from the last read. */
const segments = new Map<string, { base: number; count: number; root: Root }[]>()

interface FrameRead {
  url: string
  title: string
  text: string
  textLength: number
  elements: (Record<string, unknown> & { index: number; cx: number; cy: number })[]
  moreElements: number
  fileInputs: Record<string, unknown>[]
  scroll: Record<string, unknown>
}

export async function readPage(paneId: string, textOffset = 0): Promise<unknown> {
  const page = await driver(paneId)
  const roots = rootsOf(paneId, page)
  const top = (await withTimeout(
    roots[0].exec(readFrameJs(textOffset)),
    15000,
    'read_page'
  )) as FrameRead
  const elements = [...top.elements]
  const segs = [{ base: 0, count: top.elements.length, root: roots[0] }]
  const frames: Record<string, unknown>[] = []
  for (const root of roots.slice(1)) {
    try {
      const corner = await withTimeout(root.corner(false), 3000, 'frame')
      // Not showing, or a tracking pixel: nothing in it to read or press.
      if (!corner || corner.w < 30 || corner.h < 30) continue
      const r = (await withTimeout(root.exec(readFrameJs(0)), 5000, 'read frame')) as FrameRead
      const base = elements.length
      for (const e of r.elements)
        elements.push({
          ...e,
          index: base + e.index,
          frame: root.label,
          cx: Math.round(e.cx + corner.x),
          cy: Math.round(e.cy + corner.y)
        })
      segs.push({ base, count: r.elements.length, root })
      frames.push({
        frame: root.label,
        url: r.url,
        title: r.title || undefined,
        text: r.text.slice(0, 3000) || undefined,
        fileInputs: r.fileInputs.length || undefined
      })
    } catch {
      // A frame that went away or will not answer is not worth failing the read.
    }
  }
  segments.set(paneId, segs)
  const end = textOffset + top.text.length
  const dialogs = takeDialogNotes(paneId)
  return {
    url: top.url,
    title: top.title,
    text: top.text,
    ...(textOffset ? { textOffset } : {}),
    ...(end < top.textLength
      ? {
          textMore: `${top.textLength - end} more characters: call browser_read_page with textOffset ${end}`
        }
      : {}),
    elements,
    ...(top.moreElements
      ? {
          moreElements: `${top.moreElements} more not listed — scroll (browser_scroll) or click by text`
        }
      : {}),
    ...(top.fileInputs.length ? { fileInputs: top.fileInputs } : {}),
    scroll: top.scroll,
    ...(frames.length ? { frames } : {}),
    ...(dialogs.length ? { dialogs } : {})
  }
}

export interface PointTarget {
  index?: number
  text?: string
  x?: number
  y?: number
}

/** The document an element number belongs to, and its number there. */
function segmentFor(
  paneId: string,
  page: PageDriver,
  index: number
): { root: Root; local: number } {
  const seg = (segments.get(paneId) ?? []).find((s) => index >= s.base && index < s.base + s.count)
  // Never read, or read before a reload: the page itself, as numbered.
  return seg
    ? { root: seg.root, local: index - seg.base }
    : { root: rootsOf(paneId, page)[0], local: index }
}

function describeTarget(t: PointTarget): string {
  return t.index !== undefined
    ? `Element index ${t.index} not found — call browser_read_page again (indices shift when the page changes)`
    : `No visible element matching text "${t.text}" — if it's not a standard link/button (a styled div/span with its own click handler, common in dashboards), take a browser_screenshot and click its x,y instead`
}

/**
 * Where on the page a target is, in CSS pixels, scrolled into view. A point
 * off a screenshot, an element number from the last read, or visible text
 * looked for in the page and then in each frame.
 */
async function locate(
  paneId: string,
  page: PageDriver,
  target: PointTarget
): Promise<{ x: number; y: number }> {
  // x/y bypasses element lookup entirely — the fallback for a target
  // read_page's selector list can't see at all: a <div>/<span> styled as a
  // control with only a JS click handler, no semantic tag or role. Pick the
  // point off a browser_screenshot the same way sim_tap clicks a simulator
  // by pixel rather than by widget.
  //
  // Page.captureScreenshot returns physical device pixels (2x on a Retina
  // pane), but Input.dispatchMouseEvent — and every coordinate read_page
  // hands out, via getBoundingClientRect — is in CSS pixels. Reading a
  // screenshot's pixels straight into a click would land at half the
  // intended offset on any Retina display; scale by the pane's own
  // devicePixelRatio so a screenshot coordinate always lands correctly.
  if (target.x !== undefined && target.y !== undefined) {
    const dpr = (await page.executeJavaScript('window.devicePixelRatio || 1')) as number
    return { x: Math.round(target.x / dpr), y: Math.round(target.y / dpr) }
  }
  const within = async (
    root: Root,
    t: { index?: number; text?: string }
  ): Promise<{ x: number; y: number } | null> => {
    if (root.label && !(await root.corner(true))) return null
    const pos = (await withTimeout(root.exec(locateJs(t)), 8000, 'locate element')) as {
      x: number
      y: number
    } | null
    if (!pos) return null
    const corner = await root.corner(false)
    return corner ? { x: Math.round(pos.x + corner.x), y: Math.round(pos.y + corner.y) } : null
  }
  if (target.index !== undefined) {
    const { root, local } = segmentFor(paneId, page, target.index)
    const pos = await within(root, { index: local })
    if (pos) return pos
  } else if (target.text) {
    for (const root of rootsOf(paneId, page)) {
      const pos = await within(root, { text: target.text }).catch(() => null)
      if (pos) return pos
    }
  }
  throw new Error(describeTarget(target))
}

/**
 * Move the pointer onto a target and say where it ended up. Arriving can move
 * the target: the menu the pointer just left closes and everything below it
 * shifts up, so the press that follows would land on whatever slid into that
 * spot. An element is looked up again once the pointer is there, and followed.
 */
async function pointTo(
  paneId: string,
  page: PageDriver,
  target: PointTarget,
  first?: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  let pos = first ?? (await locate(paneId, page, target))
  await page.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y })
  if (target.x !== undefined && target.y !== undefined) return pos
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 30))
    const now = await locate(paneId, page, target).catch(() => pos)
    if (Math.abs(now.x - pos.x) < 2 && Math.abs(now.y - pos.y) < 2) break
    pos = now
    await page.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y })
  }
  return pos
}

export async function click(paneId: string, target: PointTarget): Promise<string> {
  // A click usually navigates — same activation risk as navigate().
  return withoutStealingFocus(() => clickInner(paneId, target))
}

async function clickInner(paneId: string, target: PointTarget): Promise<string> {
  const page = await driver(paneId)
  // Hover first: some SPA buttons (React/pointer-event handlers) only react to a
  // click after a pointer-enter, and it moves the cursor onto the target so the
  // press/release land on the element the framework expects.
  const pos = await pointTo(paneId, page, target)
  const base = { x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 }
  await page.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
  await page.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
  return withDialogs(paneId, `clicked at ${pos.x},${pos.y}`)
}

/** Put the pointer on something without pressing: a menu that opens on hover, a tooltip. */
export async function hover(paneId: string, target: PointTarget): Promise<string> {
  return withoutStealingFocus(async () => {
    const page = await driver(paneId)
    const pos = await pointTo(paneId, page, target)
    return withDialogs(paneId, `pointer at ${pos.x},${pos.y}`)
  })
}

/**
 * Press on one thing, move to another, let go: a slider, a card across a
 * board, a divider. The pointer travels in steps because the libraries that
 * implement dragging wait to see it move before they believe it is a drag.
 *
 * An element marked draggable uses the browser's own drag-and-drop, which
 * synthetic mouse input does not start; for those the drag events are raised
 * on the page instead.
 */
export async function drag(paneId: string, from: PointTarget, to: PointTarget): Promise<string> {
  return withoutStealingFocus(async () => {
    const page = await driver(paneId)
    // The far end first: finding it may scroll the page. Then the pointer goes
    // to the start, which is found last and so is where it is said to be.
    let b = await locate(paneId, page, to)
    const start = await pointTo(paneId, page, from)
    if (to.x === undefined) b = await locate(paneId, page, to).catch(() => b)
    const native = (await page
      .executeJavaScript(
        `(() => {
          const at = (p) => document.elementFromPoint(p.x, p.y);
          const src = at(${JSON.stringify(start)});
          const item = src && src.closest('[draggable="true"]');
          if (!item) return false;
          const dst = at(${JSON.stringify(b)}) || document.body;
          const data = new DataTransfer();
          const fire = (el, type, p) => el.dispatchEvent(new DragEvent(type, {
            bubbles: true, cancelable: true, composed: true, dataTransfer: data, clientX: p.x, clientY: p.y }));
          fire(item, 'dragstart', ${JSON.stringify(start)});
          fire(dst, 'dragenter', ${JSON.stringify(b)});
          fire(dst, 'dragover', ${JSON.stringify(b)});
          fire(dst, 'drop', ${JSON.stringify(b)});
          fire(item, 'dragend', ${JSON.stringify(b)});
          return true;
        })()`
      )
      .catch(() => false)) as boolean
    if (!native) {
      const mouse = (
        type: string,
        p: { x: number; y: number },
        buttons: number
      ): Promise<unknown> =>
        page.sendCommand('Input.dispatchMouseEvent', {
          type,
          x: p.x,
          y: p.y,
          button: 'left',
          buttons,
          clickCount: type === 'mouseMoved' ? 0 : 1
        })
      await mouse('mousePressed', start, 1)
      const steps = 12
      for (let i = 1; i <= steps; i++) {
        await mouse(
          'mouseMoved',
          {
            x: Math.round(start.x + ((b.x - start.x) * i) / steps),
            y: Math.round(start.y + ((b.y - start.y) * i) / steps)
          },
          1
        )
        await new Promise((r) => setTimeout(r, 16))
      }
      await mouse('mouseReleased', b, 0)
    }
    return withDialogs(paneId, `dragged from ${start.x},${start.y} to ${b.x},${b.y}`)
  })
}

/** Choose in a native <select>, whose own list is an OS popup no tool can press. */
export async function selectOption(
  paneId: string,
  target: { index?: number; text?: string },
  options: string[]
): Promise<string> {
  const page = await driver(paneId)
  if (target.index === undefined && !target.text)
    throw new Error('Say which select: its index from browser_read_page, or its label as text.')
  const tries: { root: Root; t: { index?: number; text?: string } }[] =
    target.index !== undefined
      ? (() => {
          const { root, local } = segmentFor(paneId, page, target.index!)
          return [{ root, t: { index: local } }]
        })()
      : rootsOf(paneId, page).map((root) => ({ root, t: { text: target.text } }))
  let last: Record<string, unknown> = { error: 'not found' }
  for (const { root, t } of tries) {
    const res = (await withTimeout(root.exec(selectJs(t, options)), 8000, 'select').catch(
      () => null
    )) as Record<string, unknown> | null
    if (!res) continue
    if (Array.isArray(res.selected))
      return withDialogs(paneId, `selected ${(res.selected as string[]).join(', ')}`)
    last = res
    if (res.error !== 'not found') break
  }
  if (last.error === 'not a select')
    throw new Error(
      `That is a ${last.role ?? last.tag}, not a native select — a custom dropdown. Click it, then click the option in the list it opens.`
    )
  if (last.error === 'no such option')
    throw new Error(
      `No option matching ${(last.missing as string[]).map((m) => `"${m}"`).join(', ')}. The options are: ${(last.options as string[]).join(' | ')}`
    )
  if (last.error === 'option disabled' || last.error === 'select disabled')
    throw new Error(`Cannot choose it: the ${last.error}.`)
  throw new Error(describeTarget(target))
}

/**
 * Put files into a file input — the thing a native picker would have done.
 * The input is named by its element number, by its place in read_page's
 * `fileInputs` (most are hidden behind a styled button and have no number),
 * or not at all when the page has just the one.
 */
export async function uploadFiles(
  paneId: string,
  paths: string[],
  pick: { index?: number; input?: number }
): Promise<string> {
  if (!paths.length) throw new Error('No files given.')
  for (const p of paths) {
    if (!isAbsolute(p)) throw new Error(`Give the full path: "${p}" is relative.`)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch {
      throw new Error(`No such file: ${p}`)
    }
    if (!st.isFile()) throw new Error(`Not a file: ${p}`)
  }
  const page = await driver(paneId)
  let local = pick.index
  if (pick.index !== undefined) {
    const seg = segmentFor(paneId, page, pick.index)
    if (seg.root.label)
      throw new Error(
        `That input is inside ${seg.root.label}, a frame from another site, which files cannot be put into from here.`
      )
    local = seg.local
  }
  const res = (await withTimeout(
    page.executeJavaScript(fileInputJs({ index: local, input: pick.input })),
    8000,
    'find file input'
  )) as { ok?: boolean; multiple?: boolean; error?: string; count?: number }
  if (!res.ok) {
    throw new Error(
      res.error === 'several'
        ? `This page has ${res.count} file inputs: say which with input (0-${res.count! - 1}, see fileInputs in browser_read_page).`
        : res.error === 'none'
          ? 'There is no file input on this page. If one appears after a click (an "Attach" button), click that first, then call this again.'
          : res.error === 'no such input'
            ? `There is no file input ${pick.input}: this page has ${res.count}.`
            : res.error === 'not a file input'
              ? "That element is not a file input and has none inside it. Leave index out to use the page's own file input, or pass input from fileInputs in browser_read_page."
              : describeTarget({ index: pick.index })
    )
  }
  if (paths.length > 1 && !res.multiple)
    throw new Error('That input takes one file. Give it one, or upload them one at a time.')
  const ref = await page.sendCommand<{ result?: { objectId?: string } }>('Runtime.evaluate', {
    expression: UPLOAD_TARGET_JS
  })
  const objectId = ref.result?.objectId
  if (!objectId) throw new Error('Lost the file input before the files could be set — try again.')
  await page.sendCommand('DOM.setFileInputFiles', { files: paths, objectId })
  return withDialogs(
    paneId,
    `attached ${paths.map((p) => p.split('/').pop()).join(', ')} — the page has the file${
      paths.length > 1 ? 's' : ''
    } now; submit the form if it needs submitting`
  )
}

/**
 * Scroll the page, or the scrolling box an element sits in. With an element
 * and no direction, brings that element into view.
 */
export async function scroll(
  paneId: string,
  opts: { index?: number; text?: string; direction?: string; pages?: number }
): Promise<string> {
  const page = await driver(paneId)
  let root = rootsOf(paneId, page)[0]
  const o = { ...opts }
  if (opts.index !== undefined) {
    const seg = segmentFor(paneId, page, opts.index)
    root = seg.root
    o.index = seg.local
  }
  if (opts.index === undefined && !opts.text && !opts.direction) o.direction = 'down'
  const res = (await withTimeout(root.exec(scrollJs(o)), 8000, 'scroll')) as {
    error?: string
    y: number
    height: number
    viewport: number
    atTop: boolean
    atBottom: boolean
  }
  if (res.error) throw new Error(describeTarget(opts))
  const where = res.atBottom ? ' (the bottom)' : res.atTop ? ' (the top)' : ''
  return `scrolled to ${res.y} of ${Math.max(0, res.height - res.viewport)}${where}. Call browser_read_page to see what is on screen now.`
}

/** Back, forward, or load the page again — the three buttons beside the address. */
export async function history(
  paneId: string,
  action: 'back' | 'forward' | 'reload'
): Promise<string> {
  return withoutStealingFocus(async () => {
    const page = await driver(paneId)
    const before = await page.getURL()
    markAgentLoad(paneId)
    await page.executeJavaScript(action === 'reload' ? 'location.reload()' : `history.${action}()`)
    // Give the navigation a moment to start, then wait for the page it lands on.
    const until = Date.now() + 10_000
    await new Promise((r) => setTimeout(r, 250))
    while (Date.now() < until) {
      const ready = await page.executeJavaScript('document.readyState').catch(() => 'loading')
      if (ready === 'complete') break
      await new Promise((r) => setTimeout(r, 150))
    }
    segments.delete(paneId)
    const after = await page.getURL()
    const stayed = action !== 'reload' && after === before
    return withDialogs(
      paneId,
      stayed ? `Still at ${after} — there is nothing to go ${action} to.` : `Now at ${after}`
    )
  })
}

export async function typeText(paneId: string, text: string): Promise<string> {
  return withoutStealingFocus(async () => {
    const page = await driver(paneId)
    for (const char of text) {
      await page.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: char })
    }
    return withDialogs(paneId, `typed ${text.length} characters`, 0)
  })
}

export async function pressKey(paneId: string, key: string): Promise<string> {
  return withoutStealingFocus(() => pressKeyInner(paneId, key))
}

async function pressKeyInner(paneId: string, key: string): Promise<string> {
  const page = await driver(paneId)
  const codes: Record<string, { keyCode: number; code: string }> = {
    Enter: { keyCode: 13, code: 'Enter' },
    Tab: { keyCode: 9, code: 'Tab' },
    Escape: { keyCode: 27, code: 'Escape' },
    Backspace: { keyCode: 8, code: 'Backspace' },
    ArrowDown: { keyCode: 40, code: 'ArrowDown' },
    ArrowUp: { keyCode: 38, code: 'ArrowUp' },
    ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
    ArrowRight: { keyCode: 39, code: 'ArrowRight' },
    Delete: { keyCode: 46, code: 'Delete' },
    Home: { keyCode: 36, code: 'Home' },
    End: { keyCode: 35, code: 'End' },
    PageUp: { keyCode: 33, code: 'PageUp' },
    PageDown: { keyCode: 34, code: 'PageDown' },
    Space: { keyCode: 32, code: 'Space' }
  }
  const k = codes[key]
  if (!k) throw new Error(`Unsupported key "${key}" (supported: ${Object.keys(codes).join(', ')})`)
  // Space is the one key here that also writes a character.
  const name = key === 'Space' ? ' ' : key
  await page.sendCommand('Input.dispatchKeyEvent', {
    type: key === 'Space' ? 'keyDown' : 'rawKeyDown',
    windowsVirtualKeyCode: k.keyCode,
    code: k.code,
    key: name,
    ...(key === 'Space' ? { text: ' ' } : {})
  })
  await page.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: k.keyCode,
    code: k.code,
    key: name
  })
  return withDialogs(paneId, `pressed ${key}`)
}

export function consoleLogs(paneId: string): ConsoleEntry[] {
  // An external tab records from the moment it's opened (see driver()).
  if (!externalBrowserForPane(paneId)) ensureDebugger(paneId)
  const buf = consoleBuffers.get(paneId) ?? []
  return [
    ...buf.filter((e) => e.level === 'error'),
    ...buf.filter((e) => e.level !== 'error')
  ].slice(0, 50)
}

export async function evaluate(paneId: string, expression: string): Promise<string> {
  const page = await driver(paneId)
  const result = await withTimeout(
    page.executeJavaScript(
      `(() => { try { return JSON.stringify((function(){ return (${expression}); })()); } catch (e) { return 'ERROR: ' + e.message; } })()`
    ),
    10000,
    'evaluate'
  )
  return withDialogs(paneId, typeof result === 'string' ? result : JSON.stringify(result), 0)
}

export function network(paneId: string): NetEntry[] {
  if (!externalBrowserForPane(paneId)) ensureDebugger(paneId)
  const buf = netBuffers.get(paneId) ?? []
  // Failed and error-status requests first — that's what a debugging agent wants.
  const bad = buf.filter((e) => e.failed || (e.status && e.status >= 400))
  const ok = buf.filter((e) => !e.failed && (!e.status || e.status < 400))
  return [...bad, ...ok].slice(0, 50)
}

export async function waitFor(paneId: string, text: string, timeoutMs: number): Promise<string> {
  const page = await driver(paneId)
  const deadline = Date.now() + Math.min(timeoutMs, 15000)
  const needle = JSON.stringify(text)
  while (Date.now() < deadline) {
    const found = (await page.executeJavaScript(
      `(document.body?.innerText || '').toLowerCase().includes(${needle}.toLowerCase())`
    )) as boolean
    if (found) return `"${text}" is on the page`
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for "${text}"`)
}

/**
 * browser_set_viewport for a project browsing in the user's real browser: that
 * tab has no pane around it to resize, so Chrome's own phone emulation does it
 * (390×844, touch, mobile layout). Returns false for the built-in pane, whose
 * device buttons the caller switches instead.
 */
export async function setExternalViewport(
  paneId: string,
  viewport: 'mobile' | 'desktop' | 'both' | 'fit'
): Promise<boolean> {
  if (!externalBrowserForPane(paneId)) return false
  const page = await driver(paneId)
  if (viewport === 'mobile') {
    await page.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })
    await page.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5
    })
  } else {
    await page.sendCommand('Emulation.clearDeviceMetricsOverride')
    await page.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
  }
  return true
}
