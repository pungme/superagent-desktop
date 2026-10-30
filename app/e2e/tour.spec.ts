import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "How it works": short recordings of the app and animated scenes, shown while
 * setting up and again from Settings. SHOT=1 saves a picture of each slide
 * part-way through, to look at.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-tour-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-tour-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate((theme) => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
    if (theme) localStorage.setItem('cove.theme', theme)
  }, process.env.THEME ?? '')
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) if (d) rmSync(d, { recursive: true, force: true })
})

/** Put the slide's recording or its animations at a moment, so a picture of it means something. */
async function at(seconds: number): Promise<void> {
  await window.evaluate(async (ms) => {
    const video = document.querySelector<HTMLVideoElement>('.tour-frame video')
    if (video) {
      video.pause()
      video.currentTime = Math.min(ms / 1000, video.duration - 0.05)
      await new Promise((r) => video.addEventListener('seeked', r, { once: true }))
    }
    for (const a of document.querySelector('.tour-frame')!.getAnimations({ subtree: true })) {
      a.pause()
      a.currentTime = ms
    }
  }, seconds * 1000)
}

test('it is shown again from Settings, one scene at a time, and ends where you were', async () => {
  await window.click('.sidebar-settings[title="Settings"]')
  await window
    .getByRole('button', { name: /^About/ })
    .first()
    .click()
  const row = window.locator('.settings-row', { hasText: 'How it works' })
  await row.getByRole('button', { name: 'Show me' }).click()
  const tour = window.getByRole('dialog', { name: 'How Superagent works' })
  await expect(tour).toBeVisible()

  const slides: [title: string, beta: boolean, moment: number][] = [
    ['Every chat in one list.', false, 4.6],
    ['It checks its own work.', false, 6],
    ['Watch several chats at once.', false, 4],
    ['It tells you when it needs you.', false, 6],
    ['Answer from your phone.', false, 3],
    ['Jobs that run on a schedule.', false, 4.5],
    ['Ask from any app.', true, 10],
    ['It can use your Mac, if you let it.', true, 6.3],
    ['Keys worth knowing.', false, 0]
  ]
  for (const [i, [title, beta, moment]] of slides.entries()) {
    await expect(tour.getByRole('heading', { name: title })).toBeVisible()
    await expect(tour.locator('.tour-beta')).toHaveCount(beta ? 1 : 0)
    await expect(tour.getByRole('tab', { selected: true })).toHaveAccessibleName(title)
    if (title === 'Keys worth knowing.') {
      // The last page is a list, not a scene: the menu's own shortcuts.
      await expect(tour.locator('.tour-key')).toHaveCount(10)
      await expect(tour.locator('.tour-key', { hasText: 'Search everything' })).toContainText('K')
    } else if (await tour.locator('.tour-frame video').count()) {
      // A recording of the app: it loads, it plays, silently.
      const video = tour.locator('.tour-frame video')
      await expect(video).toBeVisible()
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0.2), {
          timeout: 10_000
        })
        .toBe(true)
      expect(
        await video.evaluate((v: HTMLVideoElement) => ({
          muted: v.muted,
          loop: v.loop,
          width: v.videoWidth,
          poster: !!v.poster
        }))
      ).toEqual({ muted: true, loop: true, width: 1920, poster: true })
    } else {
      // A drawn scene: it has the desk it sits on, and it is moving.
      await expect(tour.locator('.tour-scene .d7-desk')).toBeVisible()
      expect(
        await window.evaluate(
          () => document.querySelector('.tour-frame')!.getAnimations({ subtree: true }).length
        )
      ).toBeGreaterThan(2)
    }
    if (process.env.SHOT) {
      // Past the slide's own entrance, then at a telling moment of its scene.
      await window.waitForTimeout(700)
      await at(moment)
      await tour.locator('.tour-card').screenshot({ path: `/tmp/sa-tour-${i + 1}.png` })
    }
    await tour
      .getByRole('button', { name: i === slides.length - 1 ? 'Get started' : 'Next' })
      .click()
  }
  await expect(tour).toHaveCount(0)
  expect(await window.evaluate(() => localStorage.getItem('cove.tourSeen'))).toBe('1')
  await expect(window.locator('.sidebar')).toBeVisible()
})

test('the keys work, the dot can be turned on on its own slide, and Esc leaves', async () => {
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('cove:replay-tour')))
  const tour = window.getByRole('dialog', { name: 'How Superagent works' })
  await expect(tour.getByRole('heading', { name: 'Every chat in one list.' })).toBeVisible()
  for (let i = 0; i < 6; i++) await window.keyboard.press('ArrowRight')
  await expect(tour.getByRole('heading', { name: 'Ask from any app.' })).toBeVisible()
  // Only this slide has the switch, and it says what the app has.
  const keep = tour.getByLabel('Show the dot on my screen')
  // Off until turned on; the switch here is one place to do that.
  await expect(keep).not.toBeChecked()
  await keep.check()
  expect(await window.evaluate(() => window.cove.dotEnabled())).toBe(true)
  await keep.uncheck()
  expect(await window.evaluate(() => window.cove.dotEnabled())).toBe(false)
  await window.keyboard.press('ArrowLeft')
  await expect(tour.getByRole('heading', { name: 'Jobs that run on a schedule.' })).toBeVisible()
  await expect(tour.getByLabel('Show the dot on my screen')).toHaveCount(0)
  // A dot of the row goes straight to its scene.
  await tour.getByRole('tab', { name: 'Keys worth knowing.' }).click()
  await expect(tour.getByRole('button', { name: 'Get started' })).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(tour).toHaveCount(0)
})
