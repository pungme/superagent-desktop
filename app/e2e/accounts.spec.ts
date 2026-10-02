import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Settings → Agents → Accounts: a second subscription per agent, and what
 * happens when one runs dry. The token here is shaped right but fake; nothing
 * is spent, and the CLI is never asked to use it.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
const TOKEN = 'sk-ant-oat01-' + 'e2e'.repeat(14)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-accounts-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-accounts-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# accounts e2e project\n')
  // What the login last said about its allowance, as a chat would have left it.
  const soon = Date.now() + 2 * 3_600_000
  writeFileSync(
    join(userDataDir, 'accounts.json'),
    JSON.stringify({
      accounts: [],
      usage: {
        'claude:login': {
          windows: [
            { label: '5-hour', percent: 48, resetsAt: soon },
            { label: 'Weekly', percent: 92, resetsAt: soon + 3 * 86_400_000 }
          ],
          at: Date.now()
        }
      }
    })
  )
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

async function openAccounts(): Promise<void> {
  await window.click('.sidebar-settings[title="Settings"]')
  await window.click('.settings-nav-item:has-text("Agents")')
  await expect(window.locator('.settings-accounts')).toBeVisible()
}

test("each agent lists the CLI's own login first", async () => {
  await openAccounts()
  const claude = window.locator('.settings-accounts-provider', { hasText: 'Claude' })
  await expect(claude.locator('.settings-account').first()).toContainText('Your Claude login')
  const codex = window.locator('.settings-accounts-provider', { hasText: 'Codex' })
  await expect(codex.locator('.settings-account').first()).toContainText('Your Codex login')
  // Antigravity keeps one sign-in per machine: its login is listed, and there
  // is no second account to add.
  const antigravity = window.locator('.settings-accounts-provider', { hasText: 'Antigravity' })
  await expect(antigravity.locator('.settings-account').first()).toContainText(
    'Your Antigravity login'
  )
  await expect(antigravity.locator('button', { hasText: 'Add account' })).toHaveCount(0)
  await expect(codex.locator('button', { hasText: 'Add account' })).toHaveCount(1)
  // The login row says who it is once the CLI has answered.
  await expect(claude.locator('.settings-account').first()).not.toContainText('Checking…', {
    timeout: 30_000
  })
})

test('each account says how much of its allowance is used', async () => {
  const login = window
    .locator('.settings-accounts-provider', { hasText: 'Claude' })
    .locator('.settings-account')
    .first()
  const windows = login.locator('.settings-usage-window')
  await expect(windows).toHaveCount(2)
  await expect(windows.nth(0)).toContainText('5-hour')
  await expect(windows.nth(0)).toContainText('48%')
  await expect(windows.nth(0)).toContainText('resets')
  // Nearly out reads as nearly out.
  await expect(windows.nth(1)).toContainText('92%')
  await expect(windows.nth(1)).toHaveClass(/high/)
  // An account nothing has been read for yet shows no meter at all.
  const codex = window.locator('.settings-accounts-provider', { hasText: 'Codex' })
  await expect(codex.locator('.settings-usage-window')).toHaveCount(0)
  await login.screenshot({ path: 'test-results/accounts-usage.png' })
})

test('a Claude token is added, kept encrypted, and removed again', async () => {
  const claude = window.locator('.settings-accounts-provider', { hasText: 'Claude' })
  await claude.getByRole('button', { name: 'Add account…' }).click()
  await claude.locator('.settings-accounts-input').first().fill('Work')
  await claude.locator('.settings-accounts-input').nth(1).fill('not-a-token')
  await claude.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(claude.locator('.settings-accounts-error')).toContainText('setup-token')
  await claude.locator('.settings-accounts-input').nth(1).fill(TOKEN)
  await claude.getByRole('button', { name: 'Add', exact: true }).click()
  const row = claude.locator('.settings-account', { hasText: 'Work' })
  await expect(row).toBeVisible()
  await expect(row.locator('.settings-account-state')).toHaveText('ready')
  expect(readFileSync(join(userDataDir, 'accounts.json'), 'utf8')).not.toContain(TOKEN)
  await row.getByRole('button', { name: 'Remove' }).click()
  await expect(row).toHaveCount(0)
})

test('the limit mode is a setting that sticks', async () => {
  const modes = window.locator('.settings-accounts .mode-switch')
  await expect(modes.locator('.mode-switch-btn.active')).toHaveText('Ask')
  await modes.getByRole('button', { name: 'Automatic' }).click()
  await expect(modes.locator('.mode-switch-btn.active')).toHaveText('Automatic')
  expect(JSON.parse(readFileSync(join(userDataDir, 'accounts.json'), 'utf8')).mode).toBe('auto')
})

test('the panel reads well', async () => {
  await window.locator('.settings-accounts').screenshot({ path: 'test-results/accounts-panel.png' })
})

test('an account running dry puts a card in its chat, and Switch pins the chat to the other one', async () => {
  // A second account to offer.
  const claude = window.locator('.settings-accounts-provider', { hasText: 'Claude' })
  await claude.getByRole('button', { name: 'Add account…' }).click()
  await claude.locator('.settings-accounts-input').first().fill('Work')
  await claude.locator('.settings-accounts-input').nth(1).fill(TOKEN)
  await claude.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(claude.locator('.settings-account', { hasText: 'Work' })).toBeVisible()
  const workId = (
    JSON.parse(readFileSync(join(userDataDir, 'accounts.json'), 'utf8')) as {
      accounts: { id: string }[]
    }
  ).accounts[0].id
  await window.click('main button:has-text("Done")')

  // A chat to put the card in.
  const chatId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return await window.cove.chatCreate(ws.id)
  })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('textarea.easy-input', { timeout: 20_000 })

  // What main broadcasts when the CLI reports the limit (see accounts.ts reportLimit).
  const notice = {
    chatId,
    provider: 'claude',
    account: { id: 'claude:login', name: 'Your Claude login' },
    until: Date.now() + 3_600_000,
    alternatives: [{ id: workId, name: 'Work' }],
    switchedTo: null,
    mode: 'ask'
  }
  await app.evaluate(({ BrowserWindow }, n) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('accounts:limit', n)
  }, notice)
  const card = window.locator('.easy-limit')
  await expect(card).toContainText('Your Claude login is out of allowance until')
  await expect(card.getByRole('button', { name: 'Switch to Work' })).toBeVisible()
  await card.getByRole('button', { name: 'Wait' }).click()
  await expect(card).toHaveCount(0)

  await app.evaluate(({ BrowserWindow }, n) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('accounts:limit', n)
  }, notice)
  await card.screenshot({ path: 'test-results/limit-card.png' })
  await card.getByRole('button', { name: 'Switch to Work' }).click()
  await expect(card).toHaveCount(0)
  await expect
    .poll(
      () =>
        (
          JSON.parse(readFileSync(join(userDataDir, 'accounts.json'), 'utf8')) as {
            chats: Record<string, string>
          }
        ).chats[chatId]
    )
    .toBe(workId)
})

test('one model running out moves the chat to the next one down, and says so', async () => {
  const chatId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return (await window.cove.chatList(ws.id))[0].id
  })
  await app.evaluate(({ BrowserWindow }, id) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('accounts:model-limit', {
        chatId: id,
        model: 'fable',
        fallback: 'opus',
        until: Date.now() + 3_600_000
      })
  }, chatId)
  await expect(window.locator('.easy-system').last()).toContainText(
    'Fable has used up its allowance until about'
  )
  await expect(window.locator('.easy-system').last()).toContainText('continuing on Opus')
  // No account card: the account is fine.
  await expect(window.locator('.easy-limit')).toHaveCount(0)
})

test('the model menu is wide enough for its hints', async () => {
  const pill = window.locator('.easy-control-btn:has(.easy-control-key:text-is("Model"))').first()
  await pill.click()
  const menu = window.locator('.easy-control-menu')
  await expect(menu).toBeVisible()
  expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(320)
  await menu.screenshot({ path: 'test-results/model-menu.png' })
  await window.keyboard.press('Escape')
})
