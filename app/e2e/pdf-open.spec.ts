import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

// A minimal but valid one-page PDF.
const pdf = (label: string): string =>
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%${label}\n%%EOF\n`

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')
  writeFileSync(join(projectDir, 'alpha.pdf'), pdf('alpha'))
  writeFileSync(join(projectDir, 'bravo.pdf'), pdf('bravo'))
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: userDataDir, COVE_E2E_PROJECT: projectDir, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

/**
 * Clicking a file must open THAT file. The pane keeps its page loaded while
 * closed; before the fix, clicking a different PDF remounted the pane, the old
 * page was "left exactly as it was", and the request was dropped — the chip
 * named the new file over the old one's pixels. Asserted against the native
 * pane's real URL in main, because the chip derives from the request and lies.
 */
test('clicking a second PDF after closing the pane shows THAT pdf', async () => {
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  await window.click('.toolbar-btn:has-text("Files")')
  await window.waitForSelector('.file-tree', { timeout: 10_000 })

  // Open the first PDF: the doc chip must name it.
  await window.click('.file-tree :text("alpha.pdf")')
  await expect(window.locator('.workspace-doc-name')).toHaveText('alpha.pdf', { timeout: 10_000 })

  // Close the pane — the page stays loaded in main, which is the trap.
  await window.click('.workspace-doc-close')
  await expect(window.locator('.workspace-doc-close')).toHaveCount(0)

  // The truth lives in main: what URL does the native pane actually have?
  const paneUrls = (): Promise<string[]> =>
    app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((w) => w.getURL()).filter((u) => u.startsWith('file:'))
    )
  await expect.poll(paneUrls, { timeout: 10_000 }).toEqual(
    expect.arrayContaining([expect.stringContaining('alpha.pdf')])
  )

  // Click the OTHER pdf. Before the fix the pane woke with alpha and kept it.
  await window.click('.file-tree :text("bravo.pdf")')
  await expect(window.locator('.workspace-doc-name')).toHaveText('bravo.pdf', { timeout: 10_000 })
  await expect.poll(paneUrls, { timeout: 10_000 }).toEqual(
    expect.arrayContaining([expect.stringContaining('bravo.pdf')])
  )
})
