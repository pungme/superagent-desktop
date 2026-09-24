import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * ⌘K command palette. The real accelerator is a native Electron Menu item —
 * Playwright's synthetic key events don't reach that (it's intercepted below
 * the DOM) — so these open it the same way every other menu action reaches
 * the renderer: the `menu:command-palette` IPC message `app.evaluate` sends
 * on the app's behalf, exactly what `main/menu.ts`'s accelerator triggers.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

async function openPalette(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command-palette')
  })
  await window.waitForSelector('.cmdk-panel', { timeout: 5_000 })
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-cmdk-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-cmdk-proj-'))
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
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  // Active project gives the palette its "Current chat" / Files / Browser items.
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('⌘K opens a centered overlay with Navigate and Current chat sections', async () => {
  await openPalette()
  await expect(window.locator('.cmdk-input')).toBeFocused()
  await expect(window.locator('.cmdk-section-label', { hasText: 'Navigate' })).toBeVisible()
  await expect(window.locator('.cmdk-section-label', { hasText: 'Current chat' })).toBeVisible()
  // "New chat" is the one "Current chat" action that doesn't need a live chat
  // to already exist — "Focus composer" / "Stop agent" only show once one
  // does, which a freshly opened, chat-less project correctly doesn't have.
  await expect(window.locator('.cmdk-item', { hasText: 'New chat' })).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
})

test('typing filters to a matching project, and Enter jumps to it', async () => {
  await openPalette()
  await window.keyboard.type('e2e-proj')
  const hit = window.locator('.cmdk-item', { hasText: 'e2e-project' })
  await expect(hit).toBeVisible()
  // The project's own icon, as the sidebar shows it.
  await expect(hit.locator('.cmdk-item-icon')).toBeVisible()
  await window.keyboard.press('Enter')
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
  await expect(window.locator('.workspace-toolbar')).toBeVisible()
})

test('arrow keys move the highlighted result', async () => {
  await openPalette()
  const items = window.locator('.cmdk-item')
  await expect(items.first()).toHaveClass(/active/)
  await window.keyboard.press('ArrowDown')
  await expect(items.first()).not.toHaveClass(/active/)
  await expect(items.nth(1)).toHaveClass(/active/)
  await window.keyboard.press('Escape')
})

test('clicking the backdrop closes it without picking anything', async () => {
  await openPalette()
  await window.click('.cmdk-backdrop', { position: { x: 5, y: 5 } })
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
})
