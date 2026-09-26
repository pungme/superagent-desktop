import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * The in-chat /loop, driven through the real app: main runs the loop
 * (main/loops.ts) and hands each round to the window showing the chat.
 *
 * A round is a real Claude turn, so it spends a few tokens and needs a
 * signed-in `claude` — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/loop-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'
const PROMPT = 'Reply with only the word pong. Use no tools.'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-loop-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-loop-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# loop e2e project\n')

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

async function type(text: string): Promise<void> {
  const input = window.locator('textarea.easy-input:visible').first()
  await input.fill(text)
  // Not Enter: with "/loop" typed, Enter picks from the slash-command menu.
  await window.getByRole('button', { name: 'Send message' }).click()
}

test('/loop on its own explains itself', async () => {
  await type('/loop')
  await expect(window.locator('.easy-system').last()).toContainText('Usage: /loop', {
    timeout: 5_000
  })
})

test('a loop runs its first round through the window and shows its bar', async () => {
  await type(`/loop 1m ${PROMPT}`)
  const bar = window.locator('.easy-loop-bar:visible')
  await expect(bar).toContainText('Looping every 1m · run 1', { timeout: 5_000 })
  // The round went out from this window, as if typed…
  await expect(window.locator('.easy-user').last()).toContainText(PROMPT, { timeout: 10_000 })
  // …and the agent answered it.
  await expect(window.locator('.easy-assistant:not(.easy-system)').last()).toContainText(/pong/i, {
    timeout: 120_000
  })
})

test('Stop ends it everywhere', async () => {
  await window.locator('.easy-loop-stop:visible').click()
  await expect(window.locator('.easy-loop-bar:visible')).toHaveCount(0, { timeout: 5_000 })
  await type('/loop stop')
  await expect(window.locator('.easy-system').last()).toContainText('No loop is running', {
    timeout: 5_000
  })
})
