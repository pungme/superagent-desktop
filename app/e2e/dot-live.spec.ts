import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The dot against a real agent: a question asked in the Computer, and one in a
 * project, each answered beside the tile and left behind as an ordinary chat.
 *
 * Real Claude turns, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/dot-live.spec.ts
 */
const LIVE = process.env.CLAUDE_LIVE === '1'

test('a question asked from the dot is answered by a real agent, in the right place', async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  test.setTimeout(240_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-dotlive-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-dotlive-proj-'))
  writeFileSync(
    join(proj, 'README.md'),
    '# Lighthouse\n\nThe secret word of this project is heron.\n'
  )
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_DOT: '1',
      NODE_ENV: 'production'
    }
  })
  try {
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
    const dot = app.windows().find((p) => p.url().endsWith('#dot'))!
    const main = app.windows().find((p) => !p.url().endsWith('#dot'))!
    await main.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await main.reload()
    await main.waitForSelector('.sidebar', { timeout: 20_000 })
    await dot.waitForSelector('.dot-tile', { timeout: 20_000 })
    await dot.locator('.dot-tile').click()
    const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })

    // In the Computer.
    await expect(panel.locator('.dot-chip-name')).toHaveText('Computer')
    await panel.locator('.dot-input').fill('Reply with exactly the one word: pong')
    await panel.locator('.dot-input').press('Enter')
    await expect(dot.locator('.dot-tile')).toHaveClass(/dot-working/, { timeout: 30_000 })
    await expect(panel.locator('.dot-answer')).toContainText(/pong/i, { timeout: 120_000 })
    await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible({
      timeout: 60_000
    })
    if (process.env.SHOT)
      await dot.screenshot({ path: '/tmp/sa-dot-live.png', omitBackground: true })

    // A follow-up is the same conversation: it knows what was just said.
    await panel.locator('.dot-input').fill('What one word did you just reply with? One word.')
    await panel.locator('.dot-input').press('Enter')
    await expect(panel.locator('.dot-you')).toContainText('What one word')
    // Really a new turn: the last answer is gone and it is working again.
    await expect(panel.locator('.dot-answer')).toHaveCount(0)
    await expect(dot.locator('.dot-tile')).toHaveClass(/dot-working/)
    await expect(panel.locator('.dot-answer')).toContainText(/pong/i, { timeout: 120_000 })
    await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible({
      timeout: 60_000
    })

    // In a project: it reads that project's files, and the chat is the project's.
    await panel.getByRole('button', { name: 'Clear' }).click()
    await panel.locator('.dot-chip').click()
    await dot.locator('.dot-find').fill('e2e')
    await dot.locator('.dot-find').press('Enter')
    await expect(panel.locator('.dot-chip-name')).toHaveText('e2e-project')
    await panel
      .locator('.dot-input')
      .fill('What is the secret word of this project? Read the README. One word.')
    await panel.locator('.dot-input').press('Enter')
    await expect(panel.locator('.dot-answer')).toContainText(/heron/i, { timeout: 150_000 })
    await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible({
      timeout: 60_000
    })
    // Left behind as a chat of that project, which the main window can open.
    const chats = await main.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      return (await window.cove.chatList(ws.id)).map((c) => c.title ?? '')
    })
    expect(chats.length).toBeGreaterThan(0)
    await panel.getByRole('button', { name: /Open in Superagent/ }).click()
    await expect(main.locator('.easy-transcript:visible')).toContainText(/heron/i, {
      timeout: 30_000
    })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
