import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Answering an older question: a choice picked a few messages up goes with its
 * question quoted, so the agent knows what it answers. Sent bare, it read as an
 * answer to the agent's latest message.
 *
 * Real Claude turns, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/choices-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-choices-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-choices-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# choices e2e project\n')

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

async function say(text: string): Promise<void> {
  const input = window.locator('textarea.easy-input:visible').first()
  await input.fill(text)
  await input.press('Enter')
  await expect(window.locator('.easy-thinking:visible, .easy-working:visible')).toHaveCount(0, {
    timeout: 120_000
  })
  await window.waitForTimeout(1500)
}

test('a choice picked from an older question is sent with that question', async () => {
  await say(
    'Ask me one question with the clickable choices block: "Which colour for the header?" ' +
      'with the options Red and Blue. Nothing else.'
  )
  const colour = window.locator('.easy-choices', { hasText: 'Which colour' })
  await expect(colour).toBeVisible({ timeout: 60_000 })
  // The conversation moves on before it's answered.
  await say('Unrelated: name one fruit, in one word.')
  await say('And one vegetable, in one word.')

  await colour.getByRole('button', { name: 'Blue' }).click()
  const sent = window.locator('.easy-user').last()
  await expect(sent).toContainText('Blue', { timeout: 10_000 })
  // It went with the question it answers.
  await expect(sent.locator('.easy-reply-quote')).toContainText('Which colour', { timeout: 10_000 })
  // And the agent took it for the colour, not the vegetable.
  await expect(window.locator('.easy-assistant:not(.easy-system)').last()).toContainText(
    /colou?r|header/i,
    { timeout: 120_000 }
  )
})

test('a choice on the latest question goes as it is', async () => {
  await say(
    'Ask me one question with the clickable choices block: "Which size?" ' +
      'with the options Small and Large. Nothing else.'
  )
  const size = window.locator('.easy-choices', { hasText: 'Which size' })
  await expect(size).toBeVisible({ timeout: 60_000 })
  await size.getByRole('button', { name: 'Large' }).click()
  const sent = window.locator('.easy-user').last()
  await expect(sent).toContainText('Large', { timeout: 10_000 })
  await expect(sent.locator('.easy-reply-quote')).toHaveCount(0)
})
