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
  // And three more of the kind a busy project collects: one with work of its
  // own, one with something uncommitted, and one on no branch at all.
  const more = join(strayDir, '..')
  git(['worktree', 'add', '-q', '-b', 'has-work', join(more, 'has-work')])
  writeFileSync(join(more, 'has-work', 'new.txt'), 'x\n')
  git(['add', '.'], join(more, 'has-work'))
  git(
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'],
    join(more, 'has-work')
  )
  git(['worktree', 'add', '-q', '-b', 'half-done', join(more, 'half-done')])
  writeFileSync(join(more, 'half-done', 'draft.txt'), 'x\n')
  git(['worktree', 'add', '-q', '--detach', join(more, 'loose')])
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir, strayDir && join(strayDir, '..')])
    if (d) rmSync(d, { recursive: true, force: true })
})

const fold = (): ReturnType<Page['locator']> => window.locator('.sidebar-otherbranches')

test('branches nobody is talking to are one line, not a row each', async () => {
  await expect(fold()).toBeVisible({ timeout: 20_000 })
  await expect(fold()).toContainText('4 other branches')
  await expect(fold()).toHaveAttribute('aria-expanded', 'false')
  await expect(window.locator('.sidebar-branch')).toHaveCount(0)
  await expect(window.locator('.sidebar-otherbranches-clean')).toHaveCount(0)
  if (process.env.SHOT) await window.screenshot({ path: '/tmp/sa-other-branches-folded.png' })
})

test('opened, each says what it is, and the ones that can go are marked', async () => {
  await fold().click()
  await expect(fold()).toHaveAttribute('aria-expanded', 'true')
  await expect(window.locator('.sidebar-branch')).toHaveCount(4)
  // On no branch: called by where it is, not "detached".
  const loose = window.locator('.sidebar-branch', { hasText: 'no branch · at ' })
  await expect(loose).toHaveCount(1)
  // Merged and clean: the new branch with nothing on it, and the loose checkout.
  await expect(stray().locator('.sidebar-branch-note')).toHaveText('merged')
  await expect(loose.locator('.sidebar-branch-note')).toHaveText('merged')
  // Work of its own, or something uncommitted: not marked.
  for (const name of ['has-work', 'half-done'])
    await expect(
      window.locator('.sidebar-branch', { hasText: name }).locator('.sidebar-branch-note')
    ).toHaveCount(0)
  await expect(window.locator('.sidebar-otherbranches-clean')).toHaveText('Clean up 2')
  if (process.env.SHOT) await window.screenshot({ path: '/tmp/sa-other-branches-open.png' })
  // It stays open across a reload: remembered for the project.
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await expect(fold()).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 })
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

test('Clean up shows the list first, and removes only what would lose nothing', async () => {
  // The branch that now has a conversation is a row of its own, out of the fold.
  await expect(fold()).toContainText('3 other branches')
  const clean = window.locator('.sidebar-otherbranches-clean')
  await expect(clean).toHaveText('Clean up 1')
  // Saying no removes nothing.
  let asked = ''
  window.once('dialog', (d) => {
    asked = d.message()
    void d.dismiss()
  })
  await clean.click()
  await window.waitForTimeout(500)
  expect(asked).toContain('this branch and its checkout?')
  expect(asked).toContain('no branch · at ')
  expect(asked).not.toContain('has-work')
  expect(git(['worktree', 'list'])).toContain('loose')

  window.once('dialog', (d) => void d.accept())
  await clean.click()
  await expect.poll(() => git(['worktree', 'list'])).not.toContain('loose')
  // What had work in it is untouched, on disk and in the list.
  const left = git(['worktree', 'list'])
  for (const name of ['has-work', 'half-done', 'wp-banned']) expect(left).toContain(name)
  expect(git(['branch', '--list'])).toContain('main')
  await expect(fold()).toContainText('2 other branches')
  await expect(clean).toHaveCount(0)
})
