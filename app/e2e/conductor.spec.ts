import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Conductor: a project's Main chat and its sessions. Turned on, chats connected to it with
 * their numbers, listed and read by the Main chat's own tools (called over HTTP the way Claude
 * Code calls them), closed and reopened from the Sessions tab, routing set to Auto.
 */
let mcpUrl = ''
let wsId = ''
let mainId = ''

async function tool(
  name: string,
  args: Record<string, unknown> = {},
  chat = mainId
): Promise<string> {
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(wsId)}&chat=${encodeURIComponent(chat)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    }
  )
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6)
  const msg = JSON.parse(json) as {
    result?: { content: { text?: string }[] }
    error?: { message: string }
  }
  if (msg.error) throw new Error(msg.error.message)
  return msg.result!.content.map((c) => c.text ?? '').join('\n')
}

test('conductor: Main chat, numbered sessions, the Sessions tab, its own tools', async () => {
  test.setTimeout(40_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-conductor-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-conductor-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const urlFile = join(data, 'mcp-url.txt')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      NODE_ENV: 'production'
    }
  })
  try {
    const page: Page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect.poll(() => existsSync(urlFile)).toBe(true)
    mcpUrl = readFileSync(urlFile, 'utf8')

    const made = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      const a = await window.cove.chatCreate(ws.id)
      const b = await window.cove.chatCreate(ws.id)
      const state = await window.cove.conductorEnable(ws.id, [a])
      return { wsId: ws.id, a, b, state }
    })
    wsId = made.wsId
    mainId = made.state!.chatId
    await tool('app_rename_chat', { chatId: made.a, title: 'Fix the header' }, made.a)
    await tool('app_rename_chat', { chatId: made.b, title: 'Pricing page' }, made.b)
    // Main exists, chat `a` is connected as #101.
    expect(made.state!.sessions.map((s) => s.ticket)).toEqual([101])
    expect(made.state!.unlinked.map((c) => c.chatId)).toContain(made.b)

    // The Main chat's own tools.
    const list = await tool('conductor_list_sessions')
    expect(list).toContain('#101')
    expect(list).toContain('Routing: Confirm')
    expect(await tool('conductor_adopt_session', { chatId: made.b })).toContain('#102')
    expect(
      await tool('conductor_note_session', { ticket: 102, summary: 'Waiting on the design' })
    ).toContain('Noted')
    expect(await tool('conductor_list_sessions')).toContain('Waiting on the design')
    expect(await tool('conductor_inspect_session', { ticket: 101 })).toContain('#101')
    // Any other chat of the project has no Conductor tools.
    const other = await tool('conductor_list_sessions', {}, made.a).catch((e) => String(e))
    expect(other).not.toContain('#101')

    // The Sessions tab.
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    await page.locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible').first().click()
    await page.getByTestId('tab-sessions').click()
    const panel = page.getByTestId('conductor-panel')
    await expect(panel.getByTestId('conductor-session')).toHaveCount(2)
    await expect(panel).toContainText('#101')
    await expect(panel).toContainText('Pricing page')
    await expect(panel).toContainText('Waiting on the design')
    if (process.env.SHOT) {
      await page.evaluate(() => document.querySelector('.intro')?.remove())
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(process.env.SHOT, 'conductor-panel.png') })
    }

    // Routing, from the panel and as the Main chat sees it.
    await panel.getByTestId('conductor-routing').selectOption('auto')
    await expect.poll(() => tool('conductor_list_sessions')).toContain('Routing: Auto')

    // Closed from the panel, reopened.
    await panel.getByTestId('conductor-session').first().hover()
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click()
    await expect(panel.getByTestId('conductor-session')).toHaveCount(1)
    await panel.getByText(/Closed \(1\)/).click()
    await panel.getByRole('button', { name: 'Reopen' }).click({ force: true })
    await expect(panel.getByTestId('conductor-session')).toHaveCount(2)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
