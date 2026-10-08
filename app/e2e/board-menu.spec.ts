import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The stage picker must stay on top of the card below it.
 *
 * The hover lift (`transform: translateY(-1px)`) makes a row a stacking
 * context, which traps the menu's z-index inside it — so the next sibling
 * card painted over the menu's lower options. On any board with a card
 * below, "Done" was invisible and unclickable. The user found it: the menu
 * showed Todo/Doing/Testing and simply ended.
 */
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')
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
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

test('every stage in the picker is clickable with a card below', async () => {
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  await window.click('.toolbar-btn:has-text("Todo")')
  await window.waitForSelector('.board-add-row input', { timeout: 10_000 })
  await window.fill('.board-add-row input', 'the card whose menu we open')
  await window.keyboard.press('Enter')
  await window.fill('.board-add-row input', 'the card below, which used to paint over the menu')
  await window.keyboard.press('Enter')
  await window.waitForSelector('.board-row >> nth=1', { timeout: 5_000 })

  // Open the picker on the first card while hovering it — hover is what adds
  // the transform, and you are always hovering when you have just clicked.
  await window.hover('.board-row >> nth=0')
  await window.click('.board-row-dot >> nth=0')
  await window.waitForSelector('.board-stage-menu', { timeout: 5_000 })
  await window.waitForTimeout(250) // let the hover transform settle

  const opts = await window.locator('.board-stage-opt').allTextContents()
  expect(opts).toEqual(['Todo', 'Doing', 'Testing', 'Done'])

  // Each option must win the hit test where it overlaps the card below —
  // being in the DOM is not the same as being clickable.
  const buried = await window.evaluate(() => {
    return [...document.querySelectorAll('.board-stage-opt')].filter((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 4)
      return !(hit === el || el.contains(hit))
    }).length
  })
  expect(buried).toBe(0)

  // And the click really lands: the card moves to Done.
  await window.click('.board-stage-opt:has-text("Done")')
  await expect(window.locator('.board-stage:has-text("Done") .board-row')).toHaveCount(1, {
    timeout: 5_000
  })
})

test('the add field stays at the top, in view, however long the list gets', async () => {
  const input = window.locator('.board-add-row input')
  for (let i = 0; i < 30; i++) {
    await input.fill(`item ${i}`)
    await input.press('Enter')
  }
  await expect(window.locator('.board-row')).toHaveCount(32, { timeout: 10_000 })
  // The list is longer than the panel: it scrolls, and the field is not in it.
  const list = window.locator('.board-list')
  expect(await list.evaluate((l) => l.scrollHeight > l.clientHeight)).toBe(true)
  expect(await list.locator('.board-add-row').count()).toBe(0)
  const [field, top] = await Promise.all([input.boundingBox(), list.boundingBox()])
  expect(field!.y + field!.height).toBeLessThanOrEqual(top!.y)
  // Scrolled to the very end, it has not moved and can still be typed in.
  await list.evaluate((l) => l.scrollTo(0, l.scrollHeight))
  await expect(input).toBeInViewport()
  expect((await input.boundingBox())!.y).toBe(field!.y)
  await input.fill('added from the bottom of the list')
  await input.press('Enter')
  await expect(window.locator('.board-row')).toHaveCount(33)
})

test('Work on this hands the item over and leaves the list open', async () => {
  const list = window.locator('.board-list')
  await list.evaluate((l) => l.scrollTo(0, 0))
  const row = window.locator('.board-stage:has-text("Todo") .board-row').first()
  const title = (await row.locator('.board-row-title').innerText()).trim()
  await row.hover()
  await row.locator('.board-row-work').click()
  // It moved to Doing, and the panel is still there to pick the next one from.
  await expect(
    window.locator('.board-stage:has-text("Doing") .board-row', { hasText: title })
  ).toHaveCount(1, { timeout: 5_000 })
  await expect(window.locator('.board-panel')).toBeVisible()
  await expect(window.locator('.board-add-row input')).toBeVisible()
})
