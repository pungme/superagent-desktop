import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

/**
 * A project that is a folder of repos (like wepush): a new chat gets a copy of
 * every repo, on one branch, and is still ONE row in the sidebar.
 *
 * Its chats used to share the single checkout of each repo, because the folder
 * is not a repo and there was nothing to cut a worktree of. The copy is several
 * worktrees now, and the easy way to get this wrong is on screen: a row per
 * worktree is seven rows per conversation here. So the fixture is shaped like
 * the real thing — many repos, several conversations already in the folder,
 * things that belong to no repo — and the rows are counted.
 *
 * Prereq: `npm run build`.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let wsId: string

const REPOS = ['admin', 'api', 'backend', 'docs', 'frontend', 'ios', 'relay']

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const subjects = (repo: string): string[] =>
  git(join(projectDir, repo), 'log', '--format=%s', 'main').split('\n')
const branches = (repo: string): string[] =>
  git(join(projectDir, repo), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split(
    '\n'
  )

/** Tell the sidebar git has changed, as the end of an agent's turn does. */
const settle = async (): Promise<void> => {
  await window.evaluate(
    (id) =>
      globalThis.dispatchEvent(
        new CustomEvent('cove:workspace-idle', { detail: { workspaceId: id } })
      ),
    wsId
  )
}
const send = async (channel: string, payload: unknown): Promise<void> => {
  await app.evaluate(
    ({ BrowserWindow }, [c, p]) => BrowserWindow.getAllWindows()[0].webContents.send(c, p),
    [channel, payload] as [string, unknown]
  )
}

/** + New chat, then its first message's worth of work: the copy is cut. */
const startChat = async (
  opening: string,
  /** The project's only chat: it is the project row until it has a copy. */
  alone = false
): Promise<{ id: string; cwd: string }> => {
  const before = await window.evaluate((id) => window.cove.chatList(id), wsId)
  await send('workspace:menu-action', { action: 'new-chat', id: wsId })
  let id = ''
  await expect
    .poll(async () => {
      const now = await window.evaluate((w) => window.cove.chatList(w), wsId)
      id = now.find((c) => !before.some((b) => b.id === c.id))?.id ?? ''
      return id
    })
    .not.toBe('')
  // Not started yet: nothing is cut for a chat that has said nothing.
  if (!alone) await expect(window.locator(`[data-chat-id="${id}"]`)).toContainText('not started')
  expect(existsSync(join(projectDir, '.worktrees'))).toBe(false)
  const cwd = await window.evaluate(
    async ([chatId, path, hint]) => {
      localStorage.removeItem(`pendingBranch:${chatId}`) // as the first send does
      return window.cove.chatEnsureBranch(chatId, path, hint)
    },
    [id, projectDir, opening]
  )
  expect(cwd).toBeTruthy()
  await settle()
  return { id, cwd: cwd! }
}

const chatRows = (): ReturnType<Page['locator']> => window.locator('[data-chat-id]')
const orphanRows = (): ReturnType<Page['locator']> =>
  window.locator('.sidebar-branch:not([data-chat-id])')
const toggle = (): ReturnType<Page['locator']> => window.locator('.repo-tree-toggle')
const repoRows = (): ReturnType<Page['locator']> =>
  window.locator('.repo-tree-row:not(.repo-tree-toggle)')

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-set-data-'))
  // Resolved: macOS hands out /var/…, and the app compares paths as it is given them.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'cove-set-proj-')))
  for (const r of REPOS) {
    const d = join(projectDir, r)
    mkdirSync(d)
    git(d, 'init', '-q', '-b', 'main')
    git(d, 'config', 'user.email', 'e2e@example.com')
    git(d, 'config', 'user.name', 'e2e')
    git(d, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(d, 'README.md'), `# ${r}\n`)
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'first')
  }
  mkdirSync(join(projectDir, 'designs'))
  writeFileSync(join(projectDir, 'designs', 'logo.txt'), 'logo')
  writeFileSync(join(projectDir, 'notes.md'), '# notes\n')

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
  // The conversations already in the folder, from before chats had copies.
  wsId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    for (const title of ['General improvements', 'Motion design', 'Landing page SEO']) {
      const id = await window.cove.chatCreate(ws.id)
      await window.cove.chatUpdate(id, { title })
    }
    return ws.id
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(chatRows()).toHaveCount(3, { timeout: 15_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir]) rmSync(d, { recursive: true, force: true })
})

let chat: { id: string; cwd: string }

test('a new chat gets every repo on one branch, and is still one row', async () => {
  chat = await startChat('Please add a login page')

  expect(chat.cwd.startsWith(join(projectDir, '.worktrees') + '/')).toBe(true)
  for (const r of REPOS) {
    expect(git(join(chat.cwd, r), 'symbolic-ref', '--short', 'HEAD')).toBe('add-login-page')
    // The folder's own checkout is where it was.
    expect(git(join(projectDir, r), 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  }
  // What belongs to no repo is there too.
  expect(existsSync(join(chat.cwd, 'designs', 'logo.txt'))).toBe(true)

  // One row, saying which branch — not seven.
  await expect(window.locator(`[data-chat-id="${chat.id}"]`)).toContainText('add-login-page')
  await expect(chatRows()).toHaveCount(4)
  await expect(orphanRows()).toHaveCount(0)
  const perChat = await window.evaluate(() => {
    const seen: Record<string, number> = {}
    document.querySelectorAll('[data-chat-id]').forEach((el) => {
      const id = el.getAttribute('data-chat-id')!
      seen[id] = (seen[id] ?? 0) + 1
    })
    return Object.values(seen)
  })
  expect(perChat).toEqual([1, 1, 1, 1])
  // And the copies are not mistaken for more repos.
  await expect(toggle()).toContainText('7 repos')
})

test('the repo list says which branch the open chat has each repo on', async () => {
  await window.click(`[data-chat-id="${chat.id}"]`)
  await toggle().click()
  await expect(repoRows()).toHaveCount(7)
  await expect(repoRows().filter({ hasText: 'add-login-page' })).toHaveCount(7)
  await window.waitForTimeout(300) // the caret's turn
  await window.locator('.sidebar').screenshot({ path: 'test-results/repo-set-chat.png' })

  // A conversation in the folder itself is on whatever the folder is on.
  await window.locator('[data-chat-id]', { hasText: 'Motion design' }).click()
  await expect(repoRows().filter({ hasText: 'main' })).toHaveCount(7)
  await toggle().click()
  await expect(repoRows()).toHaveCount(0)
})

test('the file list of a chat is its copy, with the shared folders in it', async () => {
  const files = await window.evaluate((cwd) => window.cove.filesList(cwd), chat.cwd)
  expect(files).toContain('backend/README.md')
  expect(files).toContain('designs/logo.txt')
  // And the folder's own list does not repeat the project once per chat.
  const rootFiles = await window.evaluate((p) => window.cove.filesList(p), projectDir)
  expect(rootFiles.filter((f) => f.includes('.worktrees'))).toEqual([])
})

test('keep lands one change in each repo the chat touched, and the chat closes', async () => {
  writeFileSync(join(chat.cwd, 'backend', 'login.ts'), 'export {}\n')
  writeFileSync(join(chat.cwd, 'ios', 'Login.swift'), '// login\n')
  await window.evaluate((id) => window.cove.chatUpdate(id, { title: 'Add login page' }), chat.id)
  await settle()
  const st = await window.evaluate(
    ([p, cwd]) => window.cove.worktreeStatus(p, cwd),
    [projectDir, chat.cwd]
  )
  expect(st).toMatchObject({ dirty: true, repos: ['backend', 'ios'] })

  await send('chat:merge-worktree', { chatId: chat.id, workspaceId: wsId })
  await expect(window.locator(`[data-chat-id="${chat.id}"]`)).toHaveCount(0, { timeout: 20_000 })

  expect(subjects('backend')).toEqual(['Add login page', 'first'])
  expect(subjects('ios')).toEqual(['Add login page', 'first'])
  expect(existsSync(join(projectDir, 'backend', 'login.ts'))).toBe(true)
  expect(subjects('frontend')).toEqual(['first'])
  for (const r of REPOS) expect(branches(r)).toEqual(['main'])
  expect(existsSync(join(projectDir, '.worktrees'))).toBe(false)
  await expect(chatRows()).toHaveCount(3)
  await expect(orphanRows()).toHaveCount(0)
})

test('a clash in one repo keeps nothing in any, and says which repo', async () => {
  const c = await startChat('Rework the readme')
  writeFileSync(join(c.cwd, 'api', 'README.md'), '# api, reworked\n')
  writeFileSync(join(c.cwd, 'docs', 'guide.md'), '# guide\n')
  // The project moves on underneath, on the same line.
  writeFileSync(join(projectDir, 'api', 'README.md'), '# api, changed elsewhere\n')
  git(join(projectDir, 'api'), 'commit', '-q', '-am', 'elsewhere')

  const dialog = window.waitForEvent('dialog')
  await send('chat:merge-worktree', { chatId: c.id, workspaceId: wsId })
  const d = await dialog
  expect(d.message()).toContain('clash with something already in api')
  await d.dismiss() // not handing it to the agent here

  expect(subjects('docs')).toEqual(['first']) // could have landed; did not
  expect(subjects('api')).toEqual(['elsewhere', 'first'])
  await expect(window.locator(`[data-chat-id="${c.id}"]`)).toHaveCount(1)

  // Throw it away: every worktree and branch goes, and the chat with them.
  await send('chat:throw-away', { chatId: c.id, workspaceId: wsId })
  await expect(window.locator(`[data-chat-id="${c.id}"]`)).toHaveCount(0, { timeout: 20_000 })
  for (const r of REPOS) expect(branches(r)).toEqual(['main'])
  expect(existsSync(join(projectDir, '.worktrees'))).toBe(false)
  expect(existsSync(join(projectDir, 'designs', 'logo.txt'))).toBe(true)
})

test('a copy left with no conversation is one row, and can be removed', async () => {
  const set = await window.evaluate(
    (p) => window.cove.worktreeCreate(p, { newBranch: 'left-behind' }),
    projectDir
  )
  expect(set?.branch).toBe('left-behind')
  await settle()
  await expect(orphanRows()).toHaveCount(1)
  await expect(orphanRows()).toContainText('left-behind')
  await expect(chatRows()).toHaveCount(3)
  await window.locator('.sidebar').screenshot({ path: 'test-results/repo-set-orphan.png' })

  window.once('dialog', (d) => void d.accept())
  await orphanRows().hover()
  await orphanRows().locator('.sidebar-branch-remove').click()
  await expect(orphanRows()).toHaveCount(0, { timeout: 20_000 })
  for (const r of REPOS) expect(branches(r)).toEqual(['main'])
  expect(existsSync(join(projectDir, '.worktrees'))).toBe(false)
})

test('the only chat of the project still has a row when it works in a copy', async () => {
  // The project row is the folder; a chat in a copy is not that, so it needs a
  // row of its own even when there is nothing else to list.
  await window.evaluate(async (id) => {
    for (const c of await window.cove.chatList(id)) await window.cove.chatDelete(c.id)
  }, wsId)
  await settle()
  await expect(chatRows()).toHaveCount(0)
  const only = await startChat('Tidy the docs', true)
  await expect(window.locator(`[data-chat-id="${only.id}"]`)).toHaveCount(1)
  await expect(window.locator(`[data-chat-id="${only.id}"]`)).toContainText('tidy-docs')
  await window.locator('.sidebar').screenshot({ path: 'test-results/repo-set-only.png' })
})
