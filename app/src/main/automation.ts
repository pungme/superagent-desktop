import { WebContents, ipcMain } from 'electron'
import { getPaneWebContents, paneLog, withoutStealingFocus, markAgentLoad } from './browser'
import { broadcastToWindows, pushBounded, normalizeUrl } from './util'
import { externalBrowserForPane, externalPage, ExternalPage } from './external-browser'

/**
 * Browser automation primitives operating on a workspace's browser pane.
 * Used by the MCP server; every action is visible in the pane (principle #5).
 *
 * Page reading uses the indexed-interactive-element model: read_page returns
 * numbered visible elements, click targets an index or visible text. Text
 * targeting survives DOM shifts (modals) better than indices.
 */

// Semantic tags/roles first — cheap and reliable. Modern SPA dashboards (ad
// managers, admin consoles) routinely style a plain <div>/<span> as a link or
// button with only a JS click handler and no role at all, which no selector
// list can fully anticipate; browser_click's x/y fallback (below) covers that
// case by clicking exactly where a screenshot shows the target, the same way
// the iOS simulator tools click by pixel coordinate rather than by widget.
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], ' +
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], ' +
  '[role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [contenteditable="true"]'

const READ_PAGE_JS = String.raw`(() => {
  const MAX = 200;
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return true;
  };
  const els = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})].filter(isVisible).slice(0, MAX);
  window.__coveIdx = new Map();
  const items = els.map((el, i) => {
    window.__coveIdx.set(i, el);
    const r = el.getBoundingClientRect();
    return {
      index: i,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      text: (el.innerText || el.value || '').trim().slice(0, 120) || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      type: el.getAttribute('type') || undefined,
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 200) : undefined,
      cx: Math.round(r.x + r.width / 2),
      cy: Math.round(r.y + r.height / 2)
    };
  });
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 12000);
  return { url: location.href, title: document.title, text, elements: items };
})()`

function elementCenterJs(target: { index?: number; text?: string }): string {
  if (target.index !== undefined) {
    return String.raw`(() => {
      const el = window.__coveIdx && window.__coveIdx.get(${target.index});
      if (!el || !el.isConnected) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`
  }
  const needle = JSON.stringify(target.text ?? '')
  return String.raw`(() => {
    const needle = ${needle}.trim().toLowerCase();
    const els = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})];
    const match = els.find((el) => {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      return t === needle;
    }) || els.find((el) => {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      return t.includes(needle);
    });
    if (!match) return null;
    match.scrollIntoView({ block: 'center', inline: 'center' });
    const r = match.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`
}

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
  const contents = getPaneWebContents(paneId)
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

const listening = new WeakSet<ExternalPage>()

/** The page this pane's tools act on: its tab in the project's external browser, or the pane. */
async function driver(paneId: string, opts: Quiet = {}): Promise<PageDriver> {
  assertNotStopped(paneId)
  const external = externalBrowserForPane(paneId)
  if (!external) {
    const contents = wc(paneId, opts)
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
    page.session.on((method, params) => recordCdpEvent(paneId, method, params))
  }
  return page
}

// Attaching the CDP debugger flips navigator.webdriver → true, which hostile
// sites (X, Google) read as a bot and block. This masks it back to false on the
// user's own browser/logins. Runs before any page script on every document.
const WEBDRIVER_MASK =
  "Object.defineProperty(navigator,'webdriver',{get:()=>false,configurable:true});"

function ensureDebugger(paneId: string, opts: Quiet = {}): WebContents {
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

export async function readPage(paneId: string): Promise<unknown> {
  const page = await driver(paneId)
  return withTimeout(page.executeJavaScript(READ_PAGE_JS), 15000, 'read_page')
}

export async function click(
  paneId: string,
  target: { index?: number; text?: string; x?: number; y?: number }
): Promise<string> {
  // A click usually navigates — same activation risk as navigate().
  return withoutStealingFocus(() => clickInner(paneId, target))
}

async function clickInner(
  paneId: string,
  target: { index?: number; text?: string; x?: number; y?: number }
): Promise<string> {
  const page = await driver(paneId)
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
  const pos =
    target.x !== undefined && target.y !== undefined
      ? await (async () => {
          const dpr = (await page.executeJavaScript('window.devicePixelRatio || 1')) as number
          return { x: Math.round(target.x! / dpr), y: Math.round(target.y! / dpr) }
        })()
      : ((await withTimeout(
          page.executeJavaScript(elementCenterJs(target)),
          8000,
          'locate element'
        )) as { x: number; y: number } | null)
  if (!pos) {
    throw new Error(
      target.index !== undefined
        ? `Element index ${target.index} not found — call browser_read_page again (indices shift when the page changes)`
        : `No visible element matching text "${target.text}" — if it's not a standard link/button (a styled div/span with its own click handler, common in dashboards), take a browser_screenshot and click its x,y instead`
    )
  }
  // Hover first: some SPA buttons (React/pointer-event handlers) only react to a
  // click after a pointer-enter, and it moves the cursor onto the target so the
  // press/release land on the element the framework expects.
  await page.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: pos.x,
    y: pos.y
  })
  const base = { x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 }
  await page.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
  await page.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
  return `clicked at ${pos.x},${pos.y}`
}

export async function typeText(paneId: string, text: string): Promise<string> {
  return withoutStealingFocus(async () => {
    const page = await driver(paneId)
    for (const char of text) {
      await page.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: char })
    }
    return `typed ${text.length} characters`
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
    ArrowUp: { keyCode: 38, code: 'ArrowUp' }
  }
  const k = codes[key]
  if (!k) throw new Error(`Unsupported key "${key}" (supported: ${Object.keys(codes).join(', ')})`)
  await page.sendCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: k.keyCode,
    code: k.code,
    key
  })
  await page.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: k.keyCode,
    code: k.code,
    key
  })
  return `pressed ${key}`
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
  return typeof result === 'string' ? result : JSON.stringify(result)
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
