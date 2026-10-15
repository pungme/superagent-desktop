import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * After a restart (an update, most often) the app comes back where you were:
 * the conversation you were reading, not the project's newest one, and the
 * Chats view if that is where you were. A reload starts the page from nothing
 * but what it saved, which is what a restart does.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

type Store = {
  getState: () => {
    activeWorkspaceId: string | null
    activeChatId: Record<string, string>
    overlay: 'computer' | 'chats' | null
    selectChat: (ws: string, chat: string) => void
    setOverlay: (o: 'computer' | 'chats' | null) => void
  }
}

const state = (): Promise<{ ws: string | null; chat: string | null; overlay: string | null }> =>
  window.evaluate(() => {
    const s = (window as unknown as { __store: Store }).__store.getState()
    const ws = s.activeWorkspaceId
    return { ws, chat: ws ? (s.activeChatId[ws] ?? null) : null, overlay: s.overlay }
  })

const restart = async (): Promise<void> => {
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  // Let the first chat listing land: it is what used to pick the newest chat.
  await window.waitForTimeout(800)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-reopen-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-reopen-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# reopen\n')
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
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.e2e', '1')
  })
  await restart()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

test('the conversation you were reading, not the newest one', async () => {
  // Two conversations; the OLDER one is the one on screen.
  const { ws, older } = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    const older = await window.cove.chatCreate(ws.id)
    await window.cove.chatRename?.(older, 'Older chat')
    await new Promise((r) => setTimeout(r, 30))
    const newer = await window.cove.chatCreate(ws.id)
    await window.cove.chatRename?.(newer, 'Newer chat')
    return { ws: ws.id, older }
  })
  await window.locator('.sidebar-item', { hasText: 'e2e-project' }).first().click()
  await window.evaluate(
    ([w, c]) => (window as unknown as { __store: Store }).__store.getState().selectChat(w, c),
    [ws, older]
  )
  expect((await state()).chat).toBe(older)

  await restart()
  const after = await state()
  expect(after.ws).toBe(ws)
  expect(after.chat).toBe(older)
})

test('the Chats view, if that is where you were', async () => {
  await window.evaluate(() =>
    (window as unknown as { __store: Store }).__store.getState().setOverlay('chats')
  )
  await restart()
  expect((await state()).overlay).toBe('chats')

  // And a project, if that is where you went next.
  await window.locator('.sidebar-item', { hasText: 'e2e-project' }).first().click()
  await expect.poll(async () => (await state()).overlay).toBe(null)
  await restart()
  expect((await state()).overlay).toBe(null)
})
