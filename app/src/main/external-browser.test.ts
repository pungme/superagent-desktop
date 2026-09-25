import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'fs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
  closeExternalBrowsers
} from './external-browser'

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const haveBrave = existsSync(BRAVE)

beforeEach(() => kv.clear())

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

  it.skipIf(!haveBrave)('routes every pane of a Brave project to Brave', () => {
    kv.set('browser:ws1', 'brave')
    expect(externalBrowserForPane('ws1')).toBe('brave')
    expect(externalBrowserForPane('ws1::chat1')).toBe('brave')
    expect(externalBrowserForPane('ws1::chat1::t1')).toBe('brave')
  })
})

// Against the real browser, with a throwaway profile. Skipped where Brave isn't
// installed (CI), so it proves the CDP path on a developer's Mac.
describe.skipIf(!haveBrave)('driving a real Brave', () => {
  it('launches, navigates, reads, screenshots, emulates a phone and streams frames', async () => {
    try {
      const port = await ensureRunning('brave')
      expect(port).toBeGreaterThan(0)
      // Reused, not relaunched.
      expect(await ensureRunning('brave')).toBe(port)

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
    } finally {
      closeExternalBrowsers()
      await new Promise((r) => setTimeout(r, 1500))
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
