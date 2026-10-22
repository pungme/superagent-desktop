import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * The simulator pane with the screen embedded, against a REAL booted device.
 * Opt-in: SIM_LIVE=<udid of a booted simulator you do not mind being driven>.
 *
 * Checks the two halves end to end in the built app: the screen attaches as a
 * native layer over the pane (no stream), and input sent the way the pane sends
 * it reaches the device through Xcode 27's dtuhidd — proven by the device
 * actually changing, read back with simctl.
 */
const UDID = process.env.SIM_LIVE
test.skip(!UDID, 'SIM_LIVE=<udid> to run against a real simulator')

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

const shot = (): Buffer => {
  const file = join(tmpdir(), `sim-embed-${Date.now()}.png`)
  execFileSync('xcrun', ['simctl', 'io', UDID!, 'screenshot', file], { stdio: 'ignore' })
  const { readFileSync } = require('fs') as typeof import('fs')
  return readFileSync(file)
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-sim-embed-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-sim-embed-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# sim embed\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

test('the screen embeds as a native layer, with no stream', async () => {
  const r = await window.evaluate((u) => window.cove.simViewAttach(u), UDID!)
  expect(r.ok, JSON.stringify(r)).toBe(true)
  if (!r.ok) return
  // Points, not pixels: what the pane maps gestures onto.
  expect(r.width).toBeGreaterThan(300)
  expect(r.width).toBeLessThan(1400)
  await window.evaluate((u) => {
    window.cove.simViewBounds(u, { x: 40, y: 80, width: 200, height: 430 }, 24, 0)
    window.cove.simViewVisible(u, true)
  }, UDID!)
  await window.waitForTimeout(500)
  // Turned on its side and back, which must not throw.
  await window.evaluate((u) => {
    window.cove.simViewBounds(u, { x: 40, y: 80, width: 430, height: 200 }, 24, 90)
    window.cove.simViewBounds(u, { x: 40, y: 80, width: 200, height: 430 }, 24, 0)
    window.cove.simViewVisible(u, false)
    window.cove.simViewDetach(u)
  }, UDID!)
})

/**
 * 2026-10-22: the embed's once-a-second heartbeat asked CoreSimulator about the
 * device on Electron's main thread, and waited whenever that service was busy —
 * 62% of the main thread in a sample of the owner's Mac, and stalls of seconds
 * to minutes. It runs on a queue of its own now: sampling the main thread while
 * a screen is embedded finds nothing of simview in it.
 */
test("the embed's heartbeat stays off the main thread", async () => {
  test.setTimeout(60_000)
  const r = await window.evaluate((u) => window.cove.simViewAttach(u), UDID!)
  expect(r.ok, JSON.stringify(r)).toBe(true)
  await window.evaluate((u) => {
    window.cove.simViewBounds(u, { x: 40, y: 80, width: 200, height: 430 }, 24, 0)
    window.cove.simViewVisible(u, true)
  }, UDID!)
  await window.waitForTimeout(1500)
  const pid = app.process().pid!
  const file = join(tmpdir(), `sim-embed-sample-${Date.now()}.txt`)
  execFileSync('sample', [String(pid), '4', '-file', file], { stdio: 'ignore' })
  const out = readFileSync(file, 'utf8')
  const main =
    out
      .split(/\n\s+\d+ Thread_/)
      .find((t) => /CrBrowserMain|com\.apple\.main-thread/.test(t.split('\n')[0])) ?? ''
  expect(main.length).toBeGreaterThan(0)
  expect(main).not.toMatch(/simview\.node/)
  await window.evaluate((u) => {
    window.cove.simViewVisible(u, false)
    window.cove.simViewDetach(u)
  }, UDID!)
})

test('the pane shows the embedded screen, not the stream', async () => {
  test.setTimeout(60_000)
  // Open this project's simulator pane on the device, as a remembered pane does.
  await window.evaluate((u) => {
    return window.cove.storeTree().then((tree) => {
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      localStorage.setItem(`cove.simDevice:${ws.id}`, u)
      localStorage.setItem(`simOpen:${ws.id}`, '1')
    })
  }, UDID!)
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.locator('.sidebar-item', { hasText: 'e2e-project' }).first().click()
  const box = window.locator('.sim-screen.sim-native')
  await expect(box).toBeVisible({ timeout: 20_000 })
  const r = await box.boundingBox()
  expect(r && r.width > 100 && r.height > 200, JSON.stringify(r)).toBe(true)
  // The device's proportions, so taps map one to one.
  expect(Math.abs(r!.width / r!.height - 402 / 874)).toBeLessThan(0.02)
  // No streamed picture alongside it.
  await expect(window.locator('img.sim-screen')).toHaveCount(0)
  await window.screenshot({ path: 'test-results/sim-embed-pane.png' })
})

test('input reaches the device through dtuhidd: Home, then a held finger opens Settings', async () => {
  test.setTimeout(90_000)
  const ready = await window.evaluate((u) => window.cove.simHidReady(u), UDID!)
  expect(ready).toBe(true)
  // Somewhere that is not the home screen, then Home.
  execFileSync('xcrun', ['simctl', 'launch', UDID!, 'com.apple.Preferences'], { stdio: 'ignore' })
  await window.waitForTimeout(1500)
  const home = await window.evaluate(
    (u) => window.cove.simInput(u, { type: 'press', button: 'home' }),
    UDID!
  )
  expect(home.ok).toBe(true)
  await window.waitForTimeout(1200)
  const atHome = shot()
  // Settings' icon, on this device's home screen, as a finger down and up in
  // the pane's own terms: points against the screen's size in points.
  const pt = { width: 402, height: 874 }
  const at = { x: Math.round(0.835 * pt.width), y: Math.round(0.48 * pt.height) }
  for (const phase of ['start', 'end'] as const) {
    const res = await window.evaluate(([u, p]) => window.cove.simInput(u as string, p as never), [
      UDID!,
      { type: 'touch', phase, ...at, ...pt }
    ] as const)
    expect(res.ok, JSON.stringify(res)).toBe(true)
  }
  await window.waitForTimeout(1500)
  // The device moved on from the home screen.
  expect(shot().equals(atHome)).toBe(false)
  // Settings is in front.
  const front = execFileSync('xcrun', ['simctl', 'spawn', UDID!, 'launchctl', 'list'], {
    encoding: 'utf8'
  })
  expect(front).toContain('com.apple.Preferences')
})

test('a trackpad pinch on the pane pinches the device', async () => {
  test.setTimeout(60_000)
  // A fresh page each time, at its own zoom.
  execFileSync('xcrun', ['simctl', 'terminate', UDID!, 'com.apple.mobilesafari'], {
    stdio: 'ignore'
  })
  execFileSync('xcrun', ['simctl', 'openurl', UDID!, 'https://example.com'], { stdio: 'ignore' })
  await window.waitForTimeout(3500)
  // The page only, below the status bar and above Safari's bar: the clock
  // changing is not a zoom.
  const page = (): Promise<Buffer> => sharpCrop(shot())
  const before = await page()
  const box = window.locator('.sim-screen.sim-native')
  await expect(box).toBeVisible({ timeout: 20_000 })
  const r = (await box.boundingBox())!
  // As Chromium reports a trackpad pinch: wheel events with Ctrl held, a few
  // tens of milliseconds apart.
  for (let i = 0; i < 20; i++) {
    await box.evaluate(
      (el, at) =>
        el.dispatchEvent(
          new WheelEvent('wheel', {
            ctrlKey: true,
            deltaY: -12,
            clientX: at.x,
            clientY: at.y,
            bubbles: true,
            cancelable: true
          })
        ),
      { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    )
    await window.waitForTimeout(25)
  }
  await window.waitForTimeout(1500)
  expect((await page()).equals(before)).toBe(false)
})

/** The middle of a screenshot (PNG), as raw pixels to compare. */
async function sharpCrop(png: Buffer): Promise<Buffer> {
  const { PNG } = await import('pngjs')
  const img = PNG.sync.read(png)
  const top = Math.round(img.height * 0.2)
  const bottom = Math.round(img.height * 0.8)
  return img.data.subarray(top * img.width * 4, bottom * img.width * 4)
}
