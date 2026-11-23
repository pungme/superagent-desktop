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

| Focus area | What it covers | Who |
|---|---|---|
| **Product** | What we build and why. Organises customer conversations for the whole team. Writes the 1-page spec, measures. | Product manager |
| **Experience** | How it looks and feels. Web apps, iOS, Android. The "wow" moments. | UI/UX, app builders |
| **Platform** | Backend, cloud, data, security. Fast, safe, cheap, always on. | Backend & infrastructure |
| **AI agents (shared)** | Build, review, test. Watch production 24/7. Answer support. | Used by everyone |
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
  if (process.env.SHOT) {
    await window.locator('.file-viewer-body').evaluate((el) => (el.scrollTop = el.scrollHeight))
    await window.locator('.mde-row-head').scrollIntoViewIfNeeded()
    await window.screenshot({ path: process.env.SHOT + '/file-edit-table.png' })
  }

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
  // Saved by itself, without ⌘S: what the agent reads is what you see.
  await expect.poll(() => readFileSync(join(projectDir, 'vision.md'), 'utf8')).toBe(value)
  await expect(window.locator('.file-viewer-save')).toHaveCount(0)

  // ⌘Z undoes through the browser's own stack (our inserts go through execCommand).
  await ta.press('Meta+z')
  expect(await ta.inputValue()).not.toBe(value)
  await ta.press('Meta+Shift+z')
  expect(await ta.inputValue()).toBe(value)

  await ta.press('Meta+s')
  await expect(window.locator('.file-viewer-foot')).toContainText('Saved')
  expect(readFileSync(join(projectDir, 'vision.md'), 'utf8')).toBe(value)
  if (process.env.SHOT) await window.screenshot({ path: process.env.SHOT + '/file-edit-typed.png' })

  // An agent edits the file while it is open in Edit with nothing unsaved: it shows the new text.
  const file = join(projectDir, 'vision.md')
  writeFileSync(file, value + '\nAdded by the agent.\n')
  await window.evaluate(() => window.dispatchEvent(new Event('cove:workspace-idle')))
  await expect(ta).toHaveValue(value + '\nAdded by the agent.\n')

  // With unsaved edits of yours, it never replaces them: it asks, and Save does not write over it.
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0))
  await ta.pressSequentially('MINE ')
  writeFileSync(file, 'Agent rewrote everything.\n')
  await window.evaluate(() => window.dispatchEvent(new Event('cove:workspace-idle')))
  await expect(window.locator('.file-viewer-conflict')).toBeVisible()
  expect(await ta.inputValue()).toContain('MINE ')
  // Autosave stops at the choice: neither version is written over the other.
  await window.waitForTimeout(1000)
  expect(readFileSync(file, 'utf8')).toBe('Agent rewrote everything.\n')
  await expect(window.locator('.file-viewer-foot')).toContainText('Not saved')
  if (process.env.SHOT) await window.screenshot({ path: process.env.SHOT + '/file-edit-conflict.png' })
  // Keep my edits: Save writes mine.
  await window.click('.file-viewer-conflict button:has-text("Keep Mine")')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('MINE ')
  await expect(window.locator('.file-viewer-foot')).toContainText('Saved')

  // Forgot to save and sent the agent a message: the send writes it first, at once.
  await ta.pressSequentially('sent ')
  await window.evaluate(() => window.dispatchEvent(new Event('cove:flush-edits')))
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 400 }).toContain('sent ')

  // Save checks the disk too: a change that landed without a turn ending is not overwritten.
  await ta.pressSequentially('again ')
  writeFileSync(file, 'Agent, mid-turn.\n')
  await ta.press('Meta+s')
  await expect(window.locator('.file-viewer-conflict')).toBeVisible()
  expect(readFileSync(file, 'utf8')).toBe('Agent, mid-turn.\n')
  await window.click('.file-viewer-conflict button:has-text("Use New Version")')
  await expect(ta).toHaveValue('Agent, mid-turn.\n')
})
