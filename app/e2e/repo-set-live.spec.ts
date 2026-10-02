import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

/**
 * A real agent in a folder of repos: its first message makes the copy, it works
 * there and not in the folder, it still has the project's CLAUDE.md, the repo
 * it changes becomes its own worktree at the moment it changes it — and the
 * repo it does not change is never touched — and Keep lands what it did in the
 * real repo.
 *
 * repo-set.spec.ts covers the copy itself without an agent. This is the part
 * only an agent can show — that the process is started IN the copy, that the
 * edit it makes is caught and redone in a worktree, and that what it is told
 * about where it stands is enough to keep it there.
 *
 * A real Claude turn, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/repo-set-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-setlive-data-'))
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'cove-setlive-proj-')))
  for (const r of ['api', 'web']) {
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
  writeFileSync(join(projectDir, 'CLAUDE.md'), 'The project codeword is PELICAN-42.\n')
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
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir]) if (d) rmSync(d, { recursive: true, force: true })
})

test('the agent works in its copy, knows the project, and Keep lands its work', async () => {
  test.setTimeout(240_000)
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.locator('.project-empty:visible').getByRole('button', { name: '+ New chat' }).click()
  const input = window.locator('textarea.easy-input:visible')
  await expect(input).toBeVisible({ timeout: 15_000 })
  // Nothing is cut for a chat that has said nothing.
  expect(existsSync(join(projectDir, '.worktrees'))).toBe(false)

  await input.fill(
    'Write a file called hello.txt containing the word hi in the api repository. Then reply ' +
      'with exactly three lines: the output of `pwd`, the git branch the api repository is on, ' +
      'and the project codeword.'
  )
  await window.getByRole('button', { name: 'Send message' }).click()
  const reply = window.locator('.easy-assistant:not(.easy-system)').last()
  await expect(reply).toContainText('PELICAN-42', { timeout: 150_000 })
  // Started in the copy, on the branch cut for it.
  await expect(reply).toContainText('.worktrees')

  // Beside each copy is the note of which branch its worktrees go on.
  const copies = readdirSync(join(projectDir, '.worktrees')).filter((n) => !n.endsWith('.json'))
  expect(copies).toHaveLength(1)
  const copy = join(projectDir, '.worktrees', copies[0])
  expect(existsSync(join(copy, 'api', 'hello.txt'))).toBe(true)
  // The whole point: not in the folder everyone else is working in.
  expect(existsSync(join(projectDir, 'api', 'hello.txt'))).toBe(false)
  expect(git(join(projectDir, 'api'), 'status', '--porcelain')).toBe('')
  // The repo it changed is its own worktree now, on a branch of its own…
  expect(lstatSync(join(copy, 'api')).isSymbolicLink()).toBe(false)
  const branch = git(join(copy, 'api'), 'symbolic-ref', '--short', 'HEAD')
  expect(branch).not.toBe('main')
  await expect(reply).toContainText(branch)
  // …and the one it did not change has had nothing done to it at all.
  expect(lstatSync(join(copy, 'web')).isSymbolicLink()).toBe(true)
  expect(
    git(join(projectDir, 'web'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
  ).toBe('main')
  expect(git(join(projectDir, 'web'), 'worktree', 'list').split('\n')).toHaveLength(1)
  // One conversation, one row.
  await expect(window.locator('[data-chat-id]')).toHaveCount(1)

  // Keep, saying yes to the native question.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
  })
  await window.locator('.easy-keep:visible').click()
  await expect
    .poll(() => existsSync(join(projectDir, 'api', 'hello.txt')), { timeout: 30_000 })
    .toBe(true)
  expect(git(join(projectDir, 'api'), 'log', '--format=%s', 'main').split('\n')).toHaveLength(2)
  expect(git(join(projectDir, 'web'), 'log', '--format=%s', 'main').split('\n')).toHaveLength(1)
  await expect
    .poll(() => existsSync(join(projectDir, '.worktrees')), { timeout: 15_000 })
    .toBe(false)
})
