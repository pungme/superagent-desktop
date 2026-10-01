import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

/**
 * A worktree made outside Superagent — an agent running `git worktree add` for
 * itself — shows as a branch in the sidebar. Clicking it used to create a
 * conversation without a word, which read as a session appearing by itself.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let strayDir: string
let wsId: string

const git = (args: string[], cwd = projectDir): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })
const chatCount = (): Promise<number> =>
  window.evaluate(async (id) => (await window.cove.chatList(id)).length, wsId)
const stray = (): ReturnType<Page['locator']> =>
  window.locator('.sidebar-branch', { hasText: 'banned-wording' })

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-stray-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-stray-proj-'))
  strayDir = join(mkdtempSync(join(tmpdir(), 'cove-stray-wt-')), 'wp-banned')
  writeFileSync(join(projectDir, 'README.md'), '# stray\n')
  git(['init', '-q', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
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
  wsId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
    return ws.id
  })
  // What the agent did, in its own terminal.
  git(['worktree', 'add', '-q', '-b', 'banned-wording', strayDir])
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir, strayDir && join(strayDir, '..')])
    if (d) rmSync(d, { recursive: true, force: true })
})

test('it is listed, as a branch with no conversation', async () => {
  await expect(stray()).toBeVisible({ timeout: 20_000 })
  expect(await stray().getAttribute('data-chat-id')).toBeNull()
  await expect(stray()).toHaveAttribute('title', /no conversation/)
})

test('clicking it asks first; saying no leaves no session behind', async () => {
  const before = await chatCount()
  let asked = ''
  window.once('dialog', (d) => {
    asked = d.message()
    void d.dismiss()
  })
  await stray().click()
  await window.waitForTimeout(800)
  expect(asked).toContain('has no conversation yet')
  expect(await chatCount()).toBe(before)
  expect(await stray().getAttribute('data-chat-id')).toBeNull()
})

test('↑/↓ in the sidebar step past it rather than make one', async () => {
  const before = await chatCount()
  await window.locator('.sidebar-item:has-text("e2e-project")').first().click()
  for (let i = 0; i < 4; i++) await window.keyboard.press('ArrowDown')
  await window.waitForTimeout(500)
  expect(await chatCount()).toBe(before)
})

test('saying yes starts a conversation on it', async () => {
  const before = await chatCount()
  window.once('dialog', (d) => void d.accept())
  await stray().click()
  await expect.poll(chatCount, { timeout: 10_000 }).toBe(before + 1)
  await expect.poll(() => stray().getAttribute('data-chat-id')).not.toBeNull()
})
