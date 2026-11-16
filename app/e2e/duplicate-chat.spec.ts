import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/** Duplicate chat: the copy is a new chat in the same project, with the same agent. */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-e2e-dup-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-e2e-dup-proj-'))
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
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
})

test('a duplicate is a new chat in the same project, on the same agent', async () => {
  const { wsId, chatId, provider } = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    const id = await window.cove.chatCreate(ws.id)
    const chat = (await window.cove.chatList(ws.id)).find((c) => c.id === id)!
    return { wsId: ws.id, chatId: id, provider: chat.provider }
  })
  const before = await window.evaluate((w) => window.cove.chatList(w).then((l) => l.length), wsId)
  const copy = await window.evaluate((id) => window.cove.chatDuplicate(id), chatId)
  expect(copy).not.toBeNull()
  expect(copy!.workspaceId).toBe(wsId)
  expect(copy!.chatId).not.toBe(chatId)
  const after = await window.evaluate((w) => window.cove.chatList(w), wsId)
  expect(after.length).toBe(before + 1)
  expect(after.find((c) => c.id === copy!.chatId)?.provider).toBe(provider ?? 'claude')
  // A chat that is not there gives nothing.
  expect(await window.evaluate(() => window.cove.chatDuplicate('missing'))).toBeNull()
})
