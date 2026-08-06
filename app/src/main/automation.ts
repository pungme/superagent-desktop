import { WebContents, ipcMain } from 'electron'
import { getPaneWebContents, paneLog } from './browser'
import { broadcastToWindows, pushBounded, normalizeUrl } from './util'

/**
 * Browser automation primitives operating on a workspace's browser pane.
 * Used by the MCP server; every action is visible in the pane (principle #5).
 *
 * Page reading uses the indexed-interactive-element model: read_page returns
 * numbered visible elements, click targets an index or visible text. Text
 * targeting survives DOM shifts (modals) better than indices.
 */

const READ_PAGE_JS = String.raw`(() => {
  const MAX = 200;
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return true;
  };
  const els = [...document.querySelectorAll(
    'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [contenteditable="true"]'
  )].filter(isVisible).slice(0, MAX);
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
    const els = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]')];
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

function wc(paneId: string): WebContents {
  assertNotStopped(paneId)
  const contents = getPaneWebContents(paneId)
  if (!contents) throw new Error(`No browser pane "${paneId}" — is the browser open?`)
  signalActivity(paneId)
  return contents
}

// Attaching the CDP debugger flips navigator.webdriver → true, which hostile
// sites (X, Google) read as a bot and block. This masks it back to false on the
// user's own browser/logins. Runs before any page script on every document.
const WEBDRIVER_MASK =
  "Object.defineProperty(navigator,'webdriver',{get:()=>false,configurable:true});"

function ensureDebugger(paneId: string): WebContents {
  const contents = wc(paneId)
  if (!attached.has(paneId)) {
    contents.debugger.attach('1.3')
    attached.add(paneId)
    contents.once('destroyed', () => {
      attached.delete(paneId)
      consoleBuffers.delete(paneId)
      netBuffers.delete(paneId)
    })
    contents.debugger.on('detach', () => attached.delete(paneId))
    contents.debugger.on('message', (_e, method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const message = (params.args ?? [])
          .map((a: { value?: unknown; description?: string }) =>
            a.value !== undefined ? String(a.value) : (a.description ?? '')
          )
          .join(' ')
        pushBounded(consoleBuffers, paneId, {
          level: params.type,
          message: message.slice(0, 500),
          ts: Date.now()
        })
      } else if (method === 'Network.responseReceived') {
        pushBounded(netBuffers, paneId, {
          url: params.response?.url,
          status: params.response?.status,
          ts: Date.now()
        })
      } else if (method === 'Network.loadingFailed') {
        pushBounded(netBuffers, paneId, {
          url: params.request?.url ?? '(unknown)',
          failed: params.errorText,
          ts: Date.now()
        })
      }
    })
    contents.debugger.sendCommand('Runtime.enable').catch(() => {})
    contents.debugger.sendCommand('Network.enable').catch(() => {})
    // Hide the automation tell for future navigations + the current page.
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

export async function navigate(paneId: string, url: string): Promise<string> {
  // Cold start: the agent may drive the browser before the user has opened the
  // preview, so no pane exists yet. For an interactive pane (routine panes carry
  // a "::" suffix and run offscreen), ask the renderer to open the preview, then
  // wait briefly for it to create the pane — so the navigation is actually visible.
  if (!paneId.includes('::')) {
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
  const contents = wc(paneId)
  const target = normalizeUrl(url)
  // The agent drives the user's own browser on their own machine — real sites
  // included (that's the whole point of browser automation / routines).
  try {
    await contents.loadURL(target)
  } catch (err) {
    if (/ERR_ABORTED/.test(String(err))) {
      // Superseded by a competing navigation (pane init, a redirect) — ours
      // still matters, so try once more after the dust settles.
      paneLog('agent-navigate-aborted-retry', paneId, target.slice(0, 120))
      await new Promise((r) => setTimeout(r, 600))
      await wc(paneId).loadURL(target)
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
  paneLog('agent-navigate', paneId, contents.getURL().slice(0, 120))
  return contents.getURL()
}

export async function screenshot(paneId: string): Promise<string> {
  const contents = ensureDebugger(paneId)
  const { data } = (await contents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png'
  })) as { data: string }
  return data
}

export async function readPage(paneId: string): Promise<unknown> {
  const contents = wc(paneId)
  return withTimeout(contents.executeJavaScript(READ_PAGE_JS), 15000, 'read_page')
}

export async function click(
  paneId: string,
  target: { index?: number; text?: string }
): Promise<string> {
  const contents = ensureDebugger(paneId)
  const pos = (await withTimeout(
    contents.executeJavaScript(elementCenterJs(target)),
    8000,
    'locate element'
  )) as {
    x: number
    y: number
  } | null
  if (!pos) {
    throw new Error(
      target.index !== undefined
        ? `Element index ${target.index} not found — call browser_read_page again (indices shift when the page changes)`
        : `No visible element matching text "${target.text}"`
    )
  }
  // Hover first: some SPA buttons (React/pointer-event handlers) only react to a
  // click after a pointer-enter, and it moves the cursor onto the target so the
  // press/release land on the element the framework expects.
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: pos.x,
    y: pos.y
  })
  const base = { x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 }
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
    ...base,
    type: 'mousePressed'
  })
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseReleased'
  })
  return `clicked at ${pos.x},${pos.y}`
}

export async function typeText(paneId: string, text: string): Promise<string> {
  const contents = ensureDebugger(paneId)
  for (const char of text) {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: char })
  }
  return `typed ${text.length} characters`
}

export async function pressKey(paneId: string, key: string): Promise<string> {
  const contents = ensureDebugger(paneId)
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
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: k.keyCode,
    code: k.code,
    key
  })
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: k.keyCode,
    code: k.code,
    key
  })
  return `pressed ${key}`
}

export function consoleLogs(paneId: string): ConsoleEntry[] {
  ensureDebugger(paneId)
  const buf = consoleBuffers.get(paneId) ?? []
  return [
    ...buf.filter((e) => e.level === 'error'),
    ...buf.filter((e) => e.level !== 'error')
  ].slice(0, 50)
}

export async function evaluate(paneId: string, expression: string): Promise<string> {
  const contents = wc(paneId)
  const result = await withTimeout(
    contents.executeJavaScript(
      `(() => { try { return JSON.stringify((function(){ return (${expression}); })()); } catch (e) { return 'ERROR: ' + e.message; } })()`
    ),
    10000,
    'evaluate'
  )
  return typeof result === 'string' ? result : JSON.stringify(result)
}

export function network(paneId: string): NetEntry[] {
  ensureDebugger(paneId)
  const buf = netBuffers.get(paneId) ?? []
  // Failed and error-status requests first — that's what a debugging agent wants.
  const bad = buf.filter((e) => e.failed || (e.status && e.status >= 400))
  const ok = buf.filter((e) => !e.failed && (!e.status || e.status < 400))
  return [...bad, ...ok].slice(0, 50)
}

export async function waitFor(paneId: string, text: string, timeoutMs: number): Promise<string> {
  const contents = wc(paneId)
  const deadline = Date.now() + Math.min(timeoutMs, 15000)
  const needle = JSON.stringify(text)
  while (Date.now() < deadline) {
    const found = (await contents.executeJavaScript(
      `(document.body?.innerText || '').toLowerCase().includes(${needle}.toLowerCase())`
    )) as boolean
    if (found) return `"${text}" is on the page`
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for "${text}"`)
}
