import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Setting up asks, once, about the few ways the app behaves that are worth a
 * decision: what happens when an account runs out, the lid, the dot and
 * computer use. Every handler behind it is replaced here, so no password is
 * asked for, no dot appears and nothing about this Mac changes.
 */

let app: ElectronApplication
let page: Page
let dir: string
test.describe.configure({ mode: 'serial' })

type Seen = { calls: [string, unknown][]; lidFails: boolean; noLid: boolean }
const seen = (): Promise<Seen> => app.evaluate(() => (globalThis as unknown as { sa: Seen }).sa)

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'superagent-choices-'))
  app = await electron.launch({
    args: [join(__dirname, '..', 'out/main/index.js')],
    env: { ...process.env, COVE_USER_DATA: dir, NODE_ENV: 'production' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ ipcMain }) => {
    const ready = { installed: true, loggedIn: true, version: 'test' }
    const absent = { installed: false, loggedIn: false, version: null }
    const sa = { calls: [] as [string, unknown][], lidFails: true, noLid: false }
    ;(globalThis as unknown as { sa: typeof sa }).sa = sa
    const state = { mode: 'ask', lid: false, floor: 20, dot: false, computer: false }
    const swap = (name: string, fn: (arg: unknown) => unknown): void => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_e, arg) => fn(arg))
    }
    swap('env:detect', () => ({
      claude: ready,
      codex: absent,
      antigravity: absent,
      loggedIn: true,
      claudeInstalled: true,
      claudeVersion: 'test'
    }))
    swap('mail:status', () => ({ supported: true, connected: false }))
    swap('accounts:list', () => ({ accounts: [], mode: state.mode }))
    swap('accounts:set-mode', (m) => {
      sa.calls.push(['mode', m])
      state.mode = m as string
      return { accounts: [], mode: state.mode }
    })
    swap('power:lid-awake', () => state.lid)
    swap('power:set-lid-awake', (on) => {
      sa.calls.push(['lid', on])
      if (on && sa.lidFails) return { ok: false, error: 'The password was not given.' }
      state.lid = !!on
      return { ok: true, enabled: state.lid }
    })
    swap('power:has-lid', () => !sa.noLid)
    swap('power:battery-floor', () => state.floor)
    swap('power:set-battery-floor', (f) => {
      sa.calls.push(['floor', f])
      state.floor = f as number
      return state.floor
    })
    swap('dot:enabled', () => state.dot)
    swap('dot:set-enabled', (on) => {
      sa.calls.push(['dot', on])
      state.dot = !!on
      return state.dot
    })
    swap('computer:status', () => ({ supported: true, enabled: state.computer }))
    swap('computer:set-enabled', (on) => {
      sa.calls.push(['computer', on])
      state.computer = !!on
      return { supported: true, enabled: state.computer }
    })
  })
  await page.evaluate((theme) => {
    for (const k of ['cove.onboarded', 'cove.connectionsOffered', 'cove.choicesAsked'])
      localStorage.removeItem(k)
    if (theme) localStorage.setItem('cove.theme', theme)
  }, process.env.THEME ?? '')
  await page.reload()
})
test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('after the tour it asks how to behave, with the careful answers already chosen', async () => {
  const tour = page.getByRole('dialog', { name: 'How Superagent works' })
  await expect(tour).toBeVisible({ timeout: 15000 })
  await tour.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'How should it behave?' })).toBeVisible()
  await expect(page.getByText('Step 2 of 3')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByLabel('Keep working with the lid closed')).not.toBeChecked()
  await expect(page.getByLabel('Show the dot on my screen')).not.toBeChecked()
  await expect(page.getByLabel('Let agents use this Mac')).not.toBeChecked()
  // Nothing is written by looking.
  expect((await seen()).calls).toEqual([])
  if (process.env.SHOT) await page.screenshot({ path: '/tmp/superagent-choices.png' })
})

test('a Mac with no lid to close is not asked about one', async () => {
  const setNoLid = (no: boolean): Promise<void> =>
    app.evaluate((_e, no) => {
      ;(globalThis as unknown as { sa: Seen }).sa.noLid = no
    }, no)
  await setNoLid(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'How should it behave?' })).toBeVisible({
    timeout: 15000
  })
  await expect(page.getByLabel('Show the dot on my screen')).toBeAttached()
  await expect(page.getByLabel('Keep working with the lid closed')).toHaveCount(0)
  await setNoLid(false)
  await page.reload()
  await expect(page.getByLabel('Keep working with the lid closed')).toBeAttached({ timeout: 15000 })
})

test('each answer is saved as it is given', async () => {
  await page.getByRole('button', { name: 'Automatic', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Automatic', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.locator('.choice', { hasText: 'The dot' }).locator('.switch').click()
  await expect(page.getByLabel('Show the dot on my screen')).toBeChecked()
  await page.locator('.choice', { hasText: 'Computer use' }).locator('.switch').click()
  await expect(page.getByLabel('Let agents use this Mac')).toBeChecked()
  expect((await seen()).calls).toEqual([
    ['mode', 'auto'],
    ['dot', true],
    ['computer', true]
  ])
})

test('a refused password leaves the lid setting off and says why', async () => {
  const lid = page.locator('.choice', { hasText: 'Keep working with the lid closed' })
  await lid.locator('.switch').click()
  await expect(lid.getByRole('alert')).toHaveText('The password was not given.')
  await expect(page.getByLabel('Keep working with the lid closed')).not.toBeChecked()
  await expect(lid.locator('select')).toHaveCount(0)

  await app.evaluate(() => {
    ;(globalThis as unknown as { sa: Seen }).sa.lidFails = false
  })
  await lid.locator('.switch').click()
  await expect(page.getByLabel('Keep working with the lid closed')).toBeChecked()
  await expect(lid.getByRole('alert')).toHaveCount(0)
  // Only once it is on is there a battery level to choose.
  await lid.locator('select').selectOption('30')
  await expect(lid.locator('select')).toHaveValue('30')
  expect((await seen()).calls.slice(-1)).toEqual([['floor', 30]])
  {
    await page.waitForTimeout(400) // the switch has finished sliding
    // And in a window as small as it goes, where the card has to scroll.
    const size = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const was = w.getSize()
      const [mw, mh] = w.getMinimumSize()
      w.setSize(mw || 700, mh || 500)
      return was
    })
    await page.waitForTimeout(200)
    await page.screenshot({ path: '/tmp/superagent-choices-small.png' })
    // Neither end of the card is lost: the top is there, and Continue can be reached.
    expect(
      await page.evaluate(
        () => document.querySelector('.choices-card')!.getBoundingClientRect().top
      )
    ).toBeGreaterThanOrEqual(0)
    await page.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeInViewport()
    await page.screenshot({ path: '/tmp/superagent-choices-small-end.png' })
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h),
      size
    )
    await page.screenshot({ path: '/tmp/superagent-choices-set.png' })
  }
})

test('Continue goes on to the connections, and it is not asked again', async () => {
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connect your apps' })).toBeVisible()
  await expect(page.getByText('Step 3 of 3')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('cove.choicesAsked'))).toBe('1')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Connect your apps' })).toBeVisible({
    timeout: 15000
  })
  await expect(page.getByRole('heading', { name: 'How should it behave?' })).toHaveCount(0)
})
