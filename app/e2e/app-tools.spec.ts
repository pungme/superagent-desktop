import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Superagent as something an agent can be asked about: "open that project",
 * called the way Claude Code calls a tool (over MCP), and the shortcut that
 * brings the window forward, in Settings.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string
let mcpUrl: string
let wsId: string
let chatId: string
let projectName: string

async function rpc(
  method: string,
  params: Record<string, unknown>,
  ws = wsId,
  chat = chatId,
  token = ''
): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(ws)}&chat=${encodeURIComponent(chat)}${token ? `&k=${token}` : ''}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    }
  )
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6)
  return JSON.parse(json)
}

/** One tool call: what it said, and whether it was an error. */
async function tool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean }> {
  const msg = await rpc('tools/call', { name, arguments: args })
  if (msg.error) throw new Error(msg.error.message)
  const r = msg.result as { isError?: boolean; content: { text?: string }[] }
  return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
}

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-apptools-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-apptools-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const urlFile = join(data, 'mcp-url.txt')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await expect.poll(() => existsSync(urlFile)).toBe(true)
  mcpUrl = readFileSync(urlFile, 'utf8')
  const made = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces)[0]
    return { wsId: ws.id, name: ws.name, chatId: await window.cove.chatCreate(ws.id) }
  })
  wsId = made.wsId
  chatId = made.chatId
  projectName = made.name
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) if (d) rmSync(d, { recursive: true, force: true })
})

test('the shortcut that brings Superagent forward can be chosen, and is remembered', async () => {
  await window.click('.sidebar-settings[title="Settings"]')
  const pick = window.getByLabel('Shortcut that brings Superagent forward')
  await expect(pick).toHaveValue('Control+Alt+S')
  await pick.selectOption('Alt+Command+S')
  expect(await window.evaluate(() => window.cove.appHotkey())).toEqual({
    hotkey: 'Alt+Command+S',
    ok: true
  })
  await pick.selectOption('none')
  expect((await window.evaluate(() => window.cove.appHotkey())).hotkey).toBe('none')
  // A test run never takes a key from the person at the Mac.
  for (const acc of ['Control+Alt+S', 'Alt+Command+S'])
    expect(await app.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), acc)).toBe(
      false
    )
})

test('an agent can say which projects there are', async () => {
  const { text } = await tool('app_list_projects')
  expect(text.split('\n')[0]).toContain('Computer')
  expect(text).toContain(projectName)
})

test('asked to open a project, it switches to it, from wherever the app was', async () => {
  // Settings is still open from the first test: the project is not showing.
  await expect(window.getByLabel('Shortcut that brings Superagent forward')).toBeVisible()
  // Said loosely: part of the name, in capitals.
  const said = await tool('app_open_project', { name: projectName.slice(0, -2).toUpperCase() })
  expect(said.isError).toBe(false)
  expect(said.text).toBe(`Superagent is now showing ${projectName}.`)
  await expect(window.getByLabel('Shortcut that brings Superagent forward')).toHaveCount(0)
  await expect(window.locator('.workspace-toolbar:visible')).toBeVisible()
})

test('a name that fits nothing is not guessed at: it says what there is', async () => {
  const said = await tool('app_open_project', { name: 'zebra' })
  expect(said.isError).toBe(true)
  expect(said.text).toContain('No project is called "zebra"')
  expect(said.text).toContain('Computer')
})

test("the Computer chat's tools still start when computer use is on", async () => {
  // Two sets of tools begin computer_; one name used twice stopped the whole
  // server for that chat, so it had no tools at all.
  await window.evaluate(() => window.cove.setComputerUse(true))
  // What an agent is given for its own conversation, and nothing else.
  const token = await app.evaluate(
    (_e, [ws, chat]) =>
      (globalThis as unknown as { __mcpToken: (ws: string, chat: string) => string }).__mcpToken(
        ws,
        chat
      ),
    ['__desktop_chat__', 'c-desktop']
  )
  const list = async (chat: string, k: string): Promise<string[]> => {
    const msg = await rpc('tools/list', {}, '__desktop_chat__', chat, k)
    expect(msg.error).toBeUndefined()
    return (msg.result as { tools: { name: string }[] }).tools.map((t) => t.name)
  }
  const names = await list('c-desktop', token)
  expect(names).toContain('computer_state')
  expect(names).toContain('computer_open_app')
  expect(names).toContain('computer_open_mac_app')
  expect(names).toContain('app_open_project')
  expect(new Set(names).size).toBe(names.length)

  // The same address with another conversation's id written in, or with no
  // token at all: no hands on the Mac. Everything else is still there.
  for (const [chat, k] of [
    ['someone-else', token],
    ['c-desktop', ''],
    ['c-desktop', 'a'.repeat(32)]
  ]) {
    const got = await list(chat, k)
    expect(
      got.filter((n) =>
        /^computer_(screenshot|click|type|key|drag|move|scroll|open_mac_app)$/.test(n)
      )
    ).toEqual([])
    expect(got).toContain('computer_state')
  }
  await window.evaluate(() => window.cove.setComputerUse(false))
})
