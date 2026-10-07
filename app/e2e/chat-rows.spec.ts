import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

/**
 * A project's chat rows, in every state a row can be in at once: pinned,
 * unread, on a branch, on none. They are one list, so they share one shape —
 * the same height, the same left edge, and at most one status mark each.
 *
 * Written after a pinned, unread chat shipped with two dots: the mark had been
 * put inside the pin as well as after it, and the screenshots that were looked
 * at had no row that was both.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let ids: string[]

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

const MARKS = '.sidebar-unread, .chat-tree-spinner, .chat-tree-bg'
const row = (id: string): ReturnType<Page['locator']> =>
  window.locator(`.chat-tree-row[data-chat-id="${id}"]`)
const mark = (chatId: string, unread: boolean): Promise<void> =>
  app.evaluate(
    ({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('chat:mark', p),
    { chatId, unread }
  )

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-rows-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-rows-proj-'))
  // A folder of repos: the shape whose chats are a plain list.
  for (const r of ['api', 'web']) {
    const d = join(projectDir, r)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'README.md'), `# ${r}\n`)
    git(d, 'init', '-b', 'main')
    git(d, 'add', '.')
    git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init')
  }
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

  // Six chats: plain, pinned, unread, pinned and unread, and the last two
  // again on a branch of their own.
  const made = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    const out: { id: string; cwd: string | null; pinned: boolean }[] = []
    const specs = [
      { title: 'Plain', pinned: false, branch: false },
      { title: 'Pinned', pinned: true, branch: false },
      { title: 'Unread', pinned: false, branch: false },
      {
        title: 'Pinned and unread with a long name that will not fit',
        pinned: true,
        branch: false
      },
      { title: 'Unread on a branch', pinned: false, branch: true },
      { title: 'Pinned and unread on a branch, long enough to cut', pinned: true, branch: true }
    ]
    for (const s of specs) {
      const made = await window.cove.chatCreate(ws.id)
      const id = typeof made === 'string' ? made : made.id
      await window.cove.chatUpdate(id, { title: s.title })
      const cwd = await window.cove.chatEnsureBranch(id, ws.path, s.branch ? 'work' : '')
      out.push({ id, cwd: s.branch ? cwd : null, pinned: s.pinned })
    }
    return out
  })
  ids = made.map((m) => m.id)
  // A copy is on a branch once one of its repos has been cut for it.
  made.forEach((m, i) => {
    // Pinning is the chat menu's, which is native; this is what it writes.
    if (m.pinned)
      execFileSync('sqlite3', [
        join(userDataDir, 'cove.db'),
        `UPDATE chats SET pinned = 1, pinnedAt = ${Date.now()} WHERE id = '${m.id}'`
      ])
    if (!m.cwd) return
    const link = join(m.cwd, 'api')
    rmSync(link)
    git(join(projectDir, 'api'), 'worktree', 'add', '-b', `superagent/work-${i}`, link)
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(window.locator('.chat-tree-row')).toHaveCount(6, { timeout: 20_000 })
  for (const i of [2, 3, 4, 5]) await mark(ids[i], true)
  await expect(window.locator('.chat-tree-row.unread')).toHaveCount(4)
  await expect(window.locator('.chat-tree-wt')).toHaveCount(2, { timeout: 10_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir]) rmSync(d, { recursive: true, force: true })
})

test('a row carries at most one status mark, and an unread one exactly one', async () => {
  const unread = new Set([2, 3, 4, 5])
  for (let i = 0; i < ids.length; i++) {
    await expect(row(ids[i]).locator(MARKS), `row ${i}`).toHaveCount(unread.has(i) ? 1 : 0)
  }
  // Never inside the pin: that is where the second dot was.
  await expect(window.locator('.chat-tree-pinned').locator(MARKS)).toHaveCount(0)
  await expect(window.locator('.chat-tree-pinned')).toHaveCount(3)
})

test('every row is the same height and every name starts on the same edge', async () => {
  const boxes = await window.locator('.chat-tree-row').evaluateAll((rows) =>
    rows.map((r) => ({
      h: Math.round(r.getBoundingClientRect().height),
      x: Math.round(r.querySelector('.chat-tree-label')!.getBoundingClientRect().left)
    }))
  )
  expect(new Set(boxes.map((b) => b.h)).size, JSON.stringify(boxes)).toBe(1)
  expect(new Set(boxes.map((b) => b.x)).size, JSON.stringify(boxes)).toBe(1)
})

test('the name, the pin and the mark sit side by side inside the row', async () => {
  for (const i of [3, 5]) {
    const r = row(ids[i])
    const [rowBox, label, pin, dot] = await Promise.all([
      r.boundingBox(),
      r.locator('.chat-tree-label').boundingBox(),
      r.locator('.chat-tree-pinned').boundingBox(),
      r.locator(MARKS).boundingBox()
    ])
    // In order, none on top of another, and nothing past the row's own edge.
    expect(label!.x + label!.width, `row ${i}`).toBeLessThanOrEqual(pin!.x + 0.5)
    expect(pin!.x + pin!.width, `row ${i}`).toBeLessThanOrEqual(dot!.x + 0.5)
    expect(dot!.x + dot!.width, `row ${i}`).toBeLessThanOrEqual(rowBox!.x + rowBox!.width)
  }
  await window.locator('.sidebar').screenshot({ path: 'test-results/chat-rows.png' })
})

test('the × comes up beside the mark on hover, not on top of it', async () => {
  const before = await row(ids[5]).locator('.chat-tree-label').boundingBox()
  await row(ids[5]).hover()
  const x = row(ids[5]).locator('.chat-tree-remove')
  await expect(x).toHaveCSS('opacity', '1')
  const [dot, pin, close, label] = await Promise.all([
    row(ids[5]).locator(MARKS).boundingBox(),
    row(ids[5]).locator('.chat-tree-pinned').boundingBox(),
    x.boundingBox(),
    row(ids[5]).locator('.chat-tree-label').boundingBox()
  ])
  expect(pin!.x + pin!.width).toBeLessThanOrEqual(dot!.x + 0.5)
  expect(dot!.x + dot!.width).toBeLessThanOrEqual(close!.x + 0.5)
  // The name gives up room for it; it does not move.
  expect(label!.x).toBe(before!.x)
  await window.mouse.move(700, 500)
})

test('reading a chat takes its mark away and leaves the row as it was', async () => {
  const before = await row(ids[3]).boundingBox()
  await mark(ids[3], false)
  await expect(row(ids[3]).locator(MARKS)).toHaveCount(0)
  const after = await row(ids[3]).boundingBox()
  expect(Math.round(after!.height)).toBe(Math.round(before!.height))
})
