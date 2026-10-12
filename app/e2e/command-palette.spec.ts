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
  await expect(window.locator('.cmdk-input')).toBeFocused()
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

test('landing on a project from ⌘K leaves the cursor in its composer', async () => {
  // The seeded project starts with no conversation; ⌘K → New chat makes one,
  // and you are typing in it without another click.
  await openPalette()
  await window.keyboard.type('New chat')
  await window.keyboard.press('Enter')
  const composer = window.locator('textarea.easy-input:visible')
  await expect(composer).toBeFocused({ timeout: 15_000 })

  // Jumping to the project by name does the same, from wherever focus was.
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(composer).not.toBeFocused()
  await openPalette()
  await window.keyboard.type('e2e-proj')
  await expect(window.locator('.cmdk-item', { hasText: 'e2e-project' }).first()).toBeVisible()
  await window.keyboard.press('Enter')
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
  await expect(composer).toBeFocused({ timeout: 10_000 })
  await window.keyboard.type('typed straight away')
  await expect(composer).toHaveValue('typed straight away')
  await composer.fill('')
})

test('a conversation in Chats opens from ⌘K with the cursor in its composer', async () => {
  // One that belongs to no project, made the way File → New Chat makes it.
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('cove:new-chat')))
  const composer = window.locator('.chats-host textarea.easy-input:visible')
  await expect(composer).toBeEnabled({ timeout: 15_000 })
  // Away to the project, so getting back is the palette's doing.
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(window.locator('.chats-host')).toBeHidden()

  await openPalette()
  await window.click('.cmdk-item:has(.cmdk-item-subtitle:text-is("Chat"))')
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
  await expect(composer).toBeFocused({ timeout: 10_000 })
  await window.keyboard.type('typed straight away')
  await expect(composer).toHaveValue('typed straight away')
  await composer.fill('')
  await window.click('.sidebar-item:has-text("e2e-project")')
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

test('a pointer already resting over the list does not take the highlight; moving it does', async () => {
  // Open once to learn where the third row is, then close.
  await openPalette()
  const third = window.locator('.cmdk-item').nth(2)
  const box = (await third.boundingBox())!
  await window.keyboard.press('Escape')
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
  // The pointer rests there before the palette opens under it (the page's
  // synthetic pointer: nothing reaches the Mac).
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await openPalette()
  await window.waitForTimeout(150)
  // The keyboard has it: the first result, not the row under the pointer.
  await expect(window.locator('.cmdk-item').first()).toHaveClass(/active/)
  await window.keyboard.press('ArrowDown')
  await expect(window.locator('.cmdk-item').nth(1)).toHaveClass(/active/)
  // The pointer moves: now it votes, and the row under it is the one.
  await window.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 2)
  await expect(window.locator('.cmdk-item').nth(2)).toHaveClass(/active/)
  // Still after that, the keyboard has it again until the pointer moves.
  await window.keyboard.press('ArrowUp')
  await expect(window.locator('.cmdk-item').nth(1)).toHaveClass(/active/)
  await window.keyboard.press('Escape')
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
})

test('clicking the backdrop closes it without picking anything', async () => {
  await openPalette()
  await window.click('.cmdk-backdrop', { position: { x: 5, y: 5 } })
  await expect(window.locator('.cmdk-panel')).toHaveCount(0)
})
