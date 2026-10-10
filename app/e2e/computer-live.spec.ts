import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What a real agent is actually given: with computer use turned on, its tool
 * server has the computer_* tools (they are only there for a caller whose
 * address carries the right token, so this is the proof the address it gets is
 * right), and asked for a project it switches the app rather than explaining.
 *
 * Nothing on the Mac is touched: the agent is asked to name its tools, not to
 * use them. Real Claude turns, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/computer-live.spec.ts
 */
const LIVE = process.env.CLAUDE_LIVE === '1'

test('a real agent has the computer-use tools, and switches project when asked', async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  test.setTimeout(300_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-culive-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-culive-proj-'))
  writeFileSync(join(proj, 'README.md'), '# Lighthouse\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_DOT: '1',
      COVE_E2E_MCP_URL_FILE: join(data, 'mcp-url.txt'),
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
    // On before the agent starts: the tools are registered when it connects.
    expect((await main.evaluate(() => window.cove.setComputerUse(true))).enabled).toBe(true)
    await dot.waitForSelector('.dot-tile', { timeout: 20_000 })
    await dot.locator('.dot-tile').click()
    const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
    await expect(panel.locator('.dot-chip-name')).toHaveText('Computer')

    await panel
      .locator('.dot-input')
      .fill(
        'Do NOT call any tool. From your list of available tools, write the exact names of every tool whose name contains "computer_" or "app_", separated by commas, and nothing else.'
      )
    await panel.locator('.dot-input').press('Enter')
    const answer = panel.locator('.dot-answer')
    await expect(answer).toContainText('computer_screenshot', { timeout: 150_000 })
    await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible({
      timeout: 60_000
    })
    const named = (await answer.innerText()).replace(/\s+/g, ' ')
    console.log('TOOLS NAMED:', named)
    for (const tool of [
      'computer_click',
      'computer_type',
      'computer_key',
      'computer_open_mac_app',
      // The Computer chat's own, which share the prefix and must both be there.
      'computer_state',
      'computer_open_app',
      'app_open_project',
      'app_list_projects'
    ])
      expect(named, tool).toContain(tool)

    // Settings is showing; asked for the project, the app goes to it.
    await main.click('.sidebar-settings[title="Settings"]')
    await expect(main.getByLabel('Shortcut that brings Superagent forward')).toBeVisible()
    await panel.locator('.dot-input').fill('open the e2e project')
    await panel.locator('.dot-input').press('Enter')
    await expect(main.locator('.workspace-toolbar:visible')).toBeVisible({ timeout: 150_000 })
    await expect(main.getByLabel('Shortcut that brings Superagent forward')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible({
      timeout: 60_000
    })
    console.log('SAID:', (await panel.locator('.dot-answer').innerText()).replace(/\s+/g, ' '))

    // A conversation, described rather than named: it finds it and goes there.
    await expect.poll(() => existsSync(join(data, 'mcp-url.txt'))).toBe(true)
    const mcpUrl = readFileSync(join(data, 'mcp-url.txt'), 'utf8')
    const made = await main.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      return {
        ws: ws.id,
        a: await window.cove.chatCreate(ws.id),
        b: await window.cove.chatCreate(ws.id)
      }
    })
    const name = (chatId: string, title: string): Promise<Response> =>
      fetch(`${mcpUrl}?ws=${made.ws}&chat=setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'app_rename_chat', arguments: { chatId, title } }
        })
      })
    await name(made.a, 'Checkout e2e testing is flaky')
    await name(made.b, 'Pricing page copy')
    await main.click('.sidebar-settings[title="Settings"]')
    await expect(main.getByLabel('Shortcut that brings Superagent forward')).toBeVisible()
    await panel
      .locator('.dot-input')
      .fill('hey go to the chat in the e2e project about the flaky checkout testing')
    await panel.locator('.dot-input').press('Enter')
    await expect(main.getByLabel('Shortcut that brings Superagent forward')).toHaveCount(0, {
      timeout: 150_000
    })
    await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible({
      timeout: 60_000
    })
    const went = (await panel.locator('.dot-answer').innerText()).replace(/\s+/g, ' ')
    console.log('WENT:', went)
    expect(went).toMatch(/Checkout e2e testing is flaky/i)

    // And what is going on, asked plainly.
    await panel.locator('.dot-input').fill('what is running right now? one line')
    await panel.locator('.dot-input').press('Enter')
    await expect(panel.locator('.dot-answer')).toContainText(/nothing|no |none|idle|not/i, {
      timeout: 150_000
    })
    console.log('STATUS:', (await panel.locator('.dot-answer').innerText()).replace(/\s+/g, ' '))
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
