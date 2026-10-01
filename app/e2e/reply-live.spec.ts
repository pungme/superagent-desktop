import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * With the real agent: does it quote the message it is answering when there is
 * more than one to answer, and leave an ordinary answer unquoted?
 * Opt-in (spends tokens): CLAUDE_LIVE=1.
 */
const LIVE = process.env.CLAUDE_LIVE === '1'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-reply-live-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-reply-live-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# reply e2e project\n')
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
  for (const dir of [userDataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

const idle = async (): Promise<void> => {
  await expect(window.locator('.easy-thinking:visible, .easy-working:visible')).toHaveCount(0, {
    timeout: 180_000
  })
  await window.waitForTimeout(1500)
}
const send = async (text: string): Promise<void> => {
  const input = window.locator('textarea.easy-input:visible').first()
  await expect(input).toBeEnabled({ timeout: 60_000 })
  await input.fill(text)
  await input.press('Enter')
}

test('one question, one answer: no quote', async () => {
  await send('In one word: what colour is a ripe banana?')
  await idle()
  const reply = window.locator('.easy-assistant:not(.easy-system)').last()
  await expect(reply).toContainText(/yellow/i, { timeout: 60_000 })
  await expect(window.locator('.easy-reply-quote-agent')).toHaveCount(0)
})

test('a second message sent while it works gets an answer that says which it answers', async () => {
  await send('Run `sleep 12` in the shell, and only then tell me what 12 times 12 is.')
  await window.waitForTimeout(4000)
  await send('separate question: what is the capital of Peru?')
  await idle()
  const texts = await window.locator('.easy-assistant:not(.easy-system)').allInnerTexts()
  console.log('REPLIES=' + JSON.stringify(texts.slice(-4)))
  const chips = await window
    .locator('.easy-reply-quote-agent .easy-reply-quote-text')
    .allInnerTexts()
  console.log('CHIPS=' + JSON.stringify(chips))
  await window.screenshot({ path: '/tmp/reply-live.png' })
  expect(texts.join('\n')).toMatch(/144/)
  expect(texts.join('\n')).toMatch(/Lima/)
  expect(chips.length).toBeGreaterThan(0)
})
