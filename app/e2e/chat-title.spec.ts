import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A name the user gave a conversation is theirs. The first message puts a
 * placeholder on an unnamed chat and the agent's own summary replaces it after
 * the turn; neither may touch a chat that already had a name, whether it was
 * given in the window before anything was said, or elsewhere (the phone, the
 * dot) while the turn ran. The agent here is stood in for: no tokens spent.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-title-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-title-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  // An agent that starts at once and names every conversation the same way.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { fake: { n: number; ids: string[] } }
    g.fake = { n: 0, ids: [] }
    ipcMain.removeHandler('agent:start')
    ipcMain.handle('agent:start', () => {
      const id = `fake-${++g.fake.n}`
      g.fake.ids.push(id)
      return id
    })
    ipcMain.removeHandler('agent:suggestTitle')
    ipcMain.handle('agent:suggestTitle', () => 'Named by the agent')
    ipcMain.removeAllListeners('agent:send')
    ipcMain.on('agent:send', () => undefined)
  })
})
test.afterAll(async () => {
  await app?.close()
  for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
})

/** A new, unnamed chat in the project, open in the window. Returns its id. */
async function freshChat(named?: string): Promise<string> {
  const id = await window.evaluate(async (title) => {
    const tree = await window.cove.storeTree()
    const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
    for (const c of await window.cove.chatList(wsId)) await window.cove.chatDelete(c.id)
    const chatId = await window.cove.chatCreate(wsId)
    if (title) await window.cove.chatUpdate(chatId, { title })
    return chatId
  }, named ?? '')
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(window.locator('textarea.easy-input:visible')).toBeVisible({ timeout: 15_000 })
  return id
}

const titleOf = (id: string): Promise<string | null> =>
  window.evaluate(async (chatId) => {
    const tree = await window.cove.storeTree()
    const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
    return (await window.cove.chatList(wsId)).find((c) => c.id === chatId)?.title ?? null
  }, id)

async function say(text: string): Promise<void> {
  const input = window.locator('textarea.easy-input:visible')
  await input.fill(text)
  await input.press('Enter')
}

/** The stood-in agent answers and ends its turn. */
async function finishTurn(): Promise<void> {
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { fake: { n: number } }).fake.n))
    .toBeGreaterThan(0)
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { fake: { ids: string[] } }
    const id = g.fake.ids[g.fake.ids.length - 1]
    const send = (e: unknown): void =>
      BrowserWindow.getAllWindows()[0].webContents.send(`agent:event:${id}`, e)
    send({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'Done, as asked.' }] }
    })
    send({ type: 'result', subtype: 'success', usage: {} })
  })
}

test('an unnamed chat takes its first message, then the name the agent gives it', async () => {
  const id = await freshChat()
  await say('please tidy the header')
  await expect.poll(() => titleOf(id)).toBe('please tidy the header')
  await finishTurn()
  await expect.poll(() => titleOf(id), { timeout: 15_000 }).toBe('Named by the agent')
})

test('a chat named before anything was said keeps that name', async () => {
  const id = await freshChat('Mine, thank you')
  await say('please tidy the header')
  await expect(window.locator('.easy-msg', { hasText: 'please tidy the header' })).toBeVisible()
  expect(await titleOf(id)).toBe('Mine, thank you')
  await finishTurn()
  await expect(window.getByText('Done, as asked.')).toBeVisible({ timeout: 15_000 })
  // Long enough for a late suggestion to have landed, had one been asked for.
  await window.waitForTimeout(1500)
  expect(await titleOf(id)).toBe('Mine, thank you')
})

test('a name given elsewhere while the turn ran is not written over', async () => {
  const id = await freshChat()
  await say('please tidy the footer')
  await expect.poll(() => titleOf(id)).toBe('please tidy the footer')
  // As the phone or the dot renames: in the store, behind this window's back.
  await window.evaluate((chatId) => window.cove.chatUpdate(chatId, { title: 'From my phone' }), id)
  await finishTurn()
  await expect(window.getByText('Done, as asked.')).toBeVisible({ timeout: 15_000 })
  await window.waitForTimeout(1500)
  expect(await titleOf(id)).toBe('From my phone')
})
