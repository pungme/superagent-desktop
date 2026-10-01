import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The real Brave these tests start runs headless: no window on the user's screen.
process.env.COVE_E2E_QUIET ??= '1'

const kv = new Map<string, string>()
const dataDir = mkdtempSync(join(tmpdir(), 'sa-ext-browser-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./store', () => ({
  kvGet: (k: string) => kv.get(k),
  kvSet: (k: string, v: string) => kv.set(k, v),
  DESKTOP_WORKSPACE_ID: '__desktop_chat__'
}))

import {
  externalBrowserForPane,
  browserFor,
  installedBrowsers,
  ensureRunning,
  externalPage,
  adoptTab,
  externalTabs,
  switchExternalTab,
  openExternalTab,
  closeExternalTab,
  stopBrowser,
  closeExternalBrowsers,
  windowCount,
  BrowserConnection
} from './external-browser'

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const haveBrave = existsSync(BRAVE)

beforeEach(() => kv.clear())

describe('talking to the browser', () => {
  it("gives up on a command the browser never answers, instead of hanging the agent's step", async () => {
    vi.useFakeTimers()
    try {
      // A browser that reads commands and never replies.
      const { PassThrough } = await import('stream')
      const { EventEmitter } = await import('events')
      const proc = Object.assign(new EventEmitter(), {
        stdio: [null, null, null, new PassThrough(), new PassThrough()]
      })
      const conn = new BrowserConnection(proc as never)
      const pending = conn.send('Page.navigate', { url: 'https://example.com' })
      const settled = pending.then(
        () => 'answered',
        (e: Error) => e.message
      )
      await vi.advanceTimersByTimeAsync(29_000)
      expect(await Promise.race([settled, Promise.resolve('still waiting')])).toBe('still waiting')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await settled).toMatch(/didn't answer \(Page\.navigate\)/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('seeing the sign-in window close', () => {
  it("counts a process's real windows from the system list, and none for one without", async () => {
    // This test process has no windows; the reading works and says so.
    expect(await windowCount(process.pid)).toBe(0)
    // A pid that doesn't exist has none either — never a false "still open".
    expect(await windowCount(999_999)).toBe(0)
  })
})

describe('which browser a pane uses', () => {
  it('is the built-in pane unless the project picked another', () => {
    expect(externalBrowserForPane('ws1::chat1')).toBeNull()
    expect(browserFor('ws1')).toBe('builtin')
  })

  it('never routes routines or the Computer chat to an external browser', () => {
    kv.set('browser:ws1', 'brave')
    kv.set('browser:__desktop_chat__', 'brave')
    expect(externalBrowserForPane('ws1::routine')).toBeNull()
    expect(externalBrowserForPane('__desktop_chat__::c1')).toBeNull()
  })

  it('falls back to the built-in pane when the picked browser is not installed', () => {
    kv.set('browser:ws1', 'edge')
    const edgeInstalled = installedBrowsers().some((b) => b.id === 'edge')
    expect(browserFor('ws1')).toBe(edgeInstalled ? 'edge' : 'builtin')
  })

  it.skipIf(!haveBrave)("routes a conversation's panes to its own pick, and no one else's", () => {
    kv.set('browser:ws1::chat1', 'brave')
    expect(externalBrowserForPane('ws1::chat1')).toBe('brave')
    // A tab of that conversation goes with it.
    expect(externalBrowserForPane('ws1::chat1::t1')).toBe('brave')
    // Another conversation in the same project keeps the built-in browser —
    // one chat switching to Brave used to switch them all.
    expect(externalBrowserForPane('ws1::chat2')).toBeNull()
    // So does a project-wide pick left over from before: it no longer leaks in.
    kv.set('browser:ws1', 'brave')
    expect(externalBrowserForPane('ws1::chat3')).toBeNull()
  })
})

// Against the real browser, with a throwaway profile. Skipped where Brave isn't
// installed (CI), so it proves the CDP path on a developer's Mac.
describe.skipIf(!haveBrave)('driving a real Brave', () => {
  it('launches, navigates, reads, screenshots, emulates a phone and streams frames', async () => {
    try {
      const conn = await ensureRunning('brave')
      // Reused, not relaunched.
      expect(await ensureRunning('brave')).toBe(conn)
      // Controlled over a private pipe only: the browser listens on no port
      // another program on the Mac could connect to.
      const pid = conn.proc.pid!
      const tcp = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid} || true`).toString().trim()
      expect(tcp).toBe('')

      const page = await externalPage('ws1::chat1', 'brave')
      await page.loadURL(
        // With a viewport tag, like any real site: without one a phone lays the
        // page out 980px wide (as Safari on an iPhone does), not 390.
        'data:text/html,<meta name="viewport" content="width=device-width"><title>Hi</title>' +
          '<h1 style="width:1100px">Wide heading</h1>'
      )
      expect(await page.executeJavaScript('document.title')).toBe('Hi')
      // A real browser, not flagged as automated (what Google and Cloudflare check).
      expect(await page.executeJavaScript('navigator.webdriver')).toBe(false)

      const shot = await page.sendCommand<{ data: string }>('Page.captureScreenshot', {
        format: 'png'
      })
      expect(Buffer.from(shot.data, 'base64').subarray(1, 4).toString()).toBe('PNG')

      await page.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      })
      // The layout viewport is the phone's width. (innerWidth is the visual
      // viewport, which a phone zooms out to fit over-wide content, as Chrome on
      // Android does.)
      expect(await page.executeJavaScript('document.documentElement.clientWidth')).toBe(390)
      // The wide heading overflows at phone size — what the agent would find.
      expect(
        (await page.executeJavaScript('document.documentElement.scrollWidth')) as number
      ).toBeGreaterThan(390)

      const frame = new Promise<string>((resolve) => {
        const off = page.session.on((method, params) => {
          if (method === 'Page.screencastFrame') {
            off()
            resolve(params.data as string)
          }
        })
      })
      await page.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 60 })
      await page.executeJavaScript('document.body.style.background = "red"')
      expect((await frame).length).toBeGreaterThan(100)

      // Same pane → same tab.
      expect(await externalPage('ws1::chat1', 'brave')).toBe(page)

      // The tab is closed (by the user, say): the next step opens a fresh one.
      await page.close()
      await new Promise((r) => setTimeout(r, 500))
      const again = await externalPage('ws1::chat1', 'brave')
      expect(again).not.toBe(page)
      await again.loadURL('data:text/html,<title>Again</title>')
      expect(await again.executeJavaScript('document.title')).toBe('Again')

      // A crash: Superagent's end of the pipe goes away, and the browser quits
      // by itself — no remote-controllable browser is left behind.
      const exited = new Promise((r) => conn.proc.once('exit', r))
      ;(conn.proc.stdio[3] as import('stream').Writable).destroy()
      ;(conn.proc.stdio[4] as import('stream').Readable).destroy()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
      expect(conn.proc.exitCode !== null || conn.proc.signalCode !== null).toBe(true)
    } finally {
      closeExternalBrowsers()
      await new Promise((r) => setTimeout(r, 1500))
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('a pane shown before the agent has done anything takes the tab at the front', async () => {
    try {
      const conn = await ensureRunning('brave')
      kv.set('browser:ws1::fresh', 'brave')
      // What the user is looking at in Brave…
      const front = await conn.send<{ targetId: string }>('Target.createTarget', {
        url: 'data:text/html,<title>Front</title><h1>what is on screen</h1>'
      })
      // …and tabs opened behind it afterwards, so the newest is not the one showing.
      for (const n of [1, 2])
        await conn.send('Target.createTarget', {
          url: `data:text/html,<title>Behind ${n}</title>`,
          background: true
        })
      await new Promise((r) => setTimeout(r, 500))
      const page = await adoptTab('ws1::fresh')
      expect(page?.targetId).toBe(front.targetId)
      expect(await page!.executeJavaScript('document.title')).toBe('Front')
      // Asking again gives nothing new: the pane has its tab.
      expect(await adoptTab('ws1::fresh')).toBeNull()
    } finally {
      await stopBrowser('brave')
    }
  }, 60_000)

  it("sees every tab in the window, the user's own included, and can move to one", async () => {
    try {
      const conn = await ensureRunning('brave')
      const mine = await externalPage('ws1::chat1', 'brave')
      await mine.loadURL('data:text/html,<title>Agent tab</title>')
      // A tab the user opened themselves: the agent never attached to it.
      const { targetId } = await conn.send<{ targetId: string }>('Target.createTarget', {
        url: 'data:text/html,<title>Merchant Center</title><h1>opened by hand</h1>'
      })
      const titles = async (): Promise<string[]> =>
        (await externalTabs('ws1::chat1', 'brave')).map(
          (t) => `${t.title}${t.mine ? ' (mine)' : ''}${t.taken ? ' (taken)' : ''}`
        )
      await expect
        .poll(titles, { timeout: 10_000 })
        .toEqual(expect.arrayContaining(['Agent tab (mine)', 'Merchant Center']))
      // Another chat sees the same tabs, with the first chat's marked as taken.
      const other = await externalTabs('ws1::chat2', 'brave')
      expect(other.find((t) => t.title === 'Agent tab')).toMatchObject({ mine: false, taken: true })

      // "Look at the tab I opened": the agent moves to it and reads it.
      const moved = await switchExternalTab('ws1::chat1', 'brave', targetId)
      expect(await moved.executeJavaScript('document.querySelector("h1").textContent')).toBe(
        'opened by hand'
      )
      expect(await moved.executeJavaScript('navigator.webdriver')).toBe(false)
      expect(await externalPage('ws1::chat1', 'brave')).toBe(moved)
      await expect
        .poll(titles)
        .toEqual(expect.arrayContaining(['Agent tab', 'Merchant Center (mine)']))

      // A new tab of its own, then closing it.
      const fresh = await openExternalTab(
        'ws1::chat1',
        'brave',
        'data:text/html,<title>Fresh</title>'
      )
      await expect.poll(titles).toEqual(expect.arrayContaining(['Fresh (mine)', 'Merchant Center']))
      await closeExternalTab('brave', fresh.targetId)
      await expect.poll(titles).not.toEqual(expect.arrayContaining(['Fresh (mine)']))
      // Its tab gone, the chat's next step opens one rather than failing.
      const again = await externalPage('ws1::chat1', 'brave')
      expect(again.targetId).not.toBe(fresh.targetId)
    } finally {
      await stopBrowser('brave')
    }
  }, 60_000)
})
