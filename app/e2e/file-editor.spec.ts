import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

const DOC = `# WePush: How we build in 2026
*Tech & Product Vision, draft by pung*

---

## 1. Everything has changed

In 2026, writing software is no longer the hard part. What matters now is **knowing what to build** and building it **fast, safely and well**.

### Three shifts that change our game

**1. Code is cheap now.**
Small teams now build what used to take big ones. See [Gamma](https://gamma.app) and \`lovable\`.

- our creators and brands
- our data on what 21,800 real deals delivered

> People do the judging. Agents do the work.

| | Revenue per employee |
|---|---|
| Classic software company | $0.2M |
`

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-proj-'))
  writeFileSync(join(projectDir, 'vision.md'), DOC)
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

/** The coloured layer must show exactly what the textarea holds, or the caret drifts. */
const layerMatches = (): Promise<boolean> =>
  window.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.fv-editor-input')!
    const layer = document.querySelector('.fv-editor-layer')!
    return layer.textContent === `${ta.value}\n `
  })

test('the Markdown editor colours, continues lists and saves', async () => {
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  await window.click('.toolbar-btn:has-text("Files")')
  await window.click('.file-tree :text("vision.md")')
  await window.waitForSelector('.file-viewer-md', { timeout: 10_000 })
  if (process.env.SHOT) await window.screenshot({ path: process.env.SHOT + '/file-view.png' })

  await window.click('.file-viewer-tab:has-text("Edit")')
  await window.waitForSelector('.fv-editor-input')
  await expect(window.locator('.fv-editor-layer .mde-h1')).toHaveCount(1)
  await expect(window.locator('.fv-editor-layer .mde-strong').first()).toBeVisible()
  expect(await layerMatches()).toBe(true)
  await expect(window.locator('.file-viewer-foot')).toContainText('Markdown')
  await expect(window.locator('.file-viewer-foot')).toContainText('Saved')
  if (process.env.SHOT) await window.screenshot({ path: process.env.SHOT + '/file-edit.png' })

  // Return at the end of a list item starts the next one; Return on an empty one ends the list.
  const ta = window.locator('.fv-editor-input')
  const at = DOC.indexOf('delivered') + 'delivered'.length
  await ta.evaluate((el: HTMLTextAreaElement, pos) => el.setSelectionRange(pos, pos), at)
  await ta.press('Enter')
  await ta.pressSequentially('the trust that we handle the money correctly')
  await ta.press('Enter')
  await ta.press('Enter')
  const value = await ta.inputValue()
  expect(value).toContain('delivered\n- the trust that we handle the money correctly\n\n')
  expect(await layerMatches()).toBe(true)
  await expect(window.locator('.file-viewer-foot')).toContainText('Edited')
  await expect(window.locator('.file-viewer-save')).toBeEnabled()

  // ⌘Z undoes through the browser's own stack (our inserts go through execCommand).
  await ta.press('Meta+z')
  expect(await ta.inputValue()).not.toBe(value)
  await ta.press('Meta+Shift+z')
  expect(await ta.inputValue()).toBe(value)

  await ta.press('Meta+s')
  await expect(window.locator('.file-viewer-foot')).toContainText('Saved')
  expect(readFileSync(join(projectDir, 'vision.md'), 'utf8')).toBe(value)
  if (process.env.SHOT) await window.screenshot({ path: process.env.SHOT + '/file-edit-typed.png' })
})
