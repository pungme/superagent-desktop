import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'

/**
 * "Send me the screenshots": the agent puts a picture from disk in its reply
 * and the chat shows it. It used to answer with a list of file names, since an
 * image pointing at a path on the Mac never loaded.
 *
 * A real Claude turn, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/images-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNwaDiAFTEMLQkAYvNgAXSglMMAAAAASUVORK5CYII=',
  'base64'
)
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-img-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-img-proj-'))
  mkdirSync(join(projectDir, 'shots'))
  writeFileSync(join(projectDir, 'README.md'), '# images\n')
  writeFileSync(join(projectDir, 'shots', 'one.png'), PNG)
  writeFileSync(join(projectDir, 'shots', 'two.png'), PNG)
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
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
  })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('textarea.easy-input', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir]) if (d) rmSync(d, { recursive: true, force: true })
})

test('asked for the screenshots, the agent shows them in the chat', async () => {
  const input = window.locator('textarea.easy-input:visible').first()
  await input.fill(
    'There are two screenshots in the shots/ folder of this project. Send me the photos. Do not run anything else.'
  )
  await input.press('Enter')
  // Pictures in the reply, loaded from disk — not file names.
  const pics = window.locator('.easy-assistant .md-img-thumb img')
  await expect(pics).toHaveCount(2, { timeout: 120_000 })
  expect(await pics.first().getAttribute('src')).toMatch(/^data:image\//)
  await expect(window.locator('.md-img-missing')).toHaveCount(0)
  // And one opens full size.
  await pics.first().click()
  await expect(window.locator('.easy-lightbox img, .lightbox img').first()).toBeVisible()
})
