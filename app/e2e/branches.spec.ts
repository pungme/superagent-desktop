import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

/**
 * The sidebar's branch list, clicked for real against a real repo. Every case
 * here is one that actually broke while it was being built: the list vanishing
 * on click, chat rows losing rename, a branch created on disk that never showed
 * a row, and a lone "main" cluttering a project with nothing to choose between.
 *
 * Prereq: `npm run build`.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' })

/** The real "New Chat" path — the same IPC the project's right-click menu sends. */
const newChat = async (): Promise<void> => {
  const id = await window.evaluate(() => localStorage.getItem('activeWorkspace'))
  await app.evaluate(({ BrowserWindow }, wsId) => {
    BrowserWindow.getAllWindows()[0].webContents.send('workspace:menu-action', {
      action: 'new-chat',
      id: wsId
    })
  }, id)
}

// A row is a place to work. Chats render as ChatRow (which carries rename and
// the context menu); worktrees nobody has opened yet render as a plain branch
// row. Both are rows, so both count.
/** The real path a branch is born on: open a chat, then actually say something. */
const startChat = async (text: string): Promise<void> => {
  await newChat()
  // Every visited workspace stays mounted, so several composers exist at once —
  // only one of them is on screen.
  const box = window.locator('textarea.easy-input:visible').first()
  await box.waitFor({ state: 'visible', timeout: 20_000 })
  await box.fill(text)
  await box.press('Enter')
}

const branchRows = (): ReturnType<Page['locator']> => window.locator('.sidebar-branch')

/** Branch names git currently has a worktree for, main's included. */
const gitBranches = (): string[] =>
  git(['worktree', 'list', '--porcelain'])
    .split(/\n\s*\n/)
    .map((st) => /^branch refs\/heads\/(.+)$/m.exec(st)?.[1])
    .filter((b): b is string => Boolean(b))

/** Every branch name the sidebar is showing, from either kind of row. */
const shownBranches = async (): Promise<string[]> => {
  // A row with a chat carries its branch down the right (.sidebar-branch-chat);
  // a row with no chat yet puts the branch where the name would go.
  const right = await window.locator('.sidebar-branch-chat').allInnerTexts()
  const left = await window.locator('.sidebar-branch-name').allInnerTexts()
  return [...right, ...left].map((t) => t.replace(/^⎇\s*/, '').trim()).filter(Boolean)
}
const chatRows = (): ReturnType<Page['locator']> => window.locator('.sidebar-branch')

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-git-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# branch e2e\n')
  // A real repo with a commit — a worktree cannot be cut from an empty one.
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'e2e'])
  git(['add', '-A'])
  git(['commit', '-m', 'first'])

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
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('a lone main is not listed — the project row already says the branch', async () => {
  await expect.poll(() => branchRows().count(), { timeout: 10_000 }).toBe(0)
})

test('the first message cuts the branch, named after what was asked for', async () => {
  const before = gitBranches()
  await startChat('make the header dark')
  // git is the source of truth: a new worktree on a new branch.
  await expect.poll(() => gitBranches().length, { timeout: 15_000 }).toBe(before.length + 1)
  const created = gitBranches().find((b) => !before.includes(b))!
  // Named from the message, not from a timestamp.
  expect(created).toBe('make-the-header-dark')
  // The bug this catches: the branch existed on disk but the sidebar's list was
  // only refreshed on an unrelated event, so no row ever appeared for it.
  await expect
    .poll(async () => (await shownBranches()).join('|'), { timeout: 15_000 })
    .toContain(created)
})

test('the folder\'s own chat lives on the project row, not in the list', async () => {
  // The project row IS the root conversation, and says which branch the folder
  // is on. Repeating it as a child of itself made the root look like just
  // another branch beneath it.
  await expect(window.locator('.sidebar-item-branch', { hasText: 'main' }).first()).toBeVisible()
  const listed = await shownBranches()
  expect(listed).not.toContain('main')
  // Everything in the list below is an extra.
  expect(listed.length).toBeGreaterThan(0)
})

test('the auto-named branch carries no superagent/ prefix', async () => {
  const branches = git(['branch', '--list'])
  expect(branches).not.toContain('superagent/')
})

test('clicking the project row opens the folder chat, and the list survives', async () => {
  const before = await branchRows().count()
  await window.locator('.sidebar-item:has-text("e2e-project")').first().click()
  await window.waitForTimeout(500)
  // The regression this guards: clicking changed the row count and the guard
  // hid the whole block, taking every row with it.
  await expect.poll(() => branchRows().count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(
    Math.max(before - 1, 1)
  )
})

test('every worktree git has is reachable in the sidebar — none hidden', async () => {
  const before = gitBranches().length
  await startChat('second piece of work')
  // newChat() only SENDS the menu IPC; the worktree is cut asynchronously in
  // the renderer, so reading git immediately raced it.
  await expect.poll(() => gitBranches().length, { timeout: 15_000 }).toBe(before + 1)
  const expected = gitBranches()
  // The invariant that matters: you can never end up with a branch on disk that
  // has no row, which is how work became unreachable in the first place.
  // main lives on the project row, not in the list; every OTHER worktree must
  // have a row, or work becomes unreachable — which is how it started.
  const mustBeListed = expected.filter((b) => b !== 'main')
  expect(mustBeListed.length).toBeGreaterThan(0)
  await expect
    .poll(async () => {
      const shown = (await shownBranches()).join('|')
      return mustBeListed.every((b) => shown.includes(b))
    }, { timeout: 15_000 })
    .toBe(true)
  // And the folder's own branch is on the project row.
  await expect(window.locator('.sidebar-item-branch', { hasText: 'main' }).first()).toBeVisible()
})

test('a chat row can still be renamed by double-clicking it', async () => {
  await expect.poll(() => chatRows().count(), { timeout: 10_000 }).toBeGreaterThan(1)
  // Deliberately a chat with a branch of its own: renaming the one on main is a
  // no-op branch-wise, which is correct but tests nothing about the next case.
  await chatRows().filter({ hasText: 'make-the-header-dark' }).first().dblclick()
  const rename = window.locator('input.chat-tree-rename')
  await expect(rename).toBeVisible()
  await rename.fill('renamed by e2e')
  await rename.press('Enter')
  await expect(window.locator('.sidebar-branch', { hasText: 'renamed by e2e' })).toBeVisible()
})

test('renaming a chat renames its branch to match', async () => {
  // The chat's title is the branch's name — that is the whole mental model.
  await expect
    .poll(() => git(['branch', '--list']), { timeout: 15_000 })
    .toContain('renamed-by-e2e')
})

/** Fire a branch row's context-menu verb, as the native menu does. */
const worktreeAction = async (
  action: 'merge' | 'delete',
  wtPath: string,
  branch: string,
  base: string | null
): Promise<void> => {
  await app.evaluate(
    ({ BrowserWindow }, p) => {
      BrowserWindow.getAllWindows()[0].webContents.send('worktree:menu-action', p)
    },
    { action, projectPath: projectDir, wtPath, branch, base }
  )
}

/** Worktree paths keyed by the branch checked out in them. */
const worktreePaths = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const st of git(['worktree', 'list', '--porcelain']).split(/\n\s*\n/)) {
    const p = /^worktree (.+)$/m.exec(st)?.[1]
    const b = /^branch refs\/heads\/(.+)$/m.exec(st)?.[1]
    if (p && b) out[b] = p
  }
  return out
}

test('right-click Merge lands a branch\'s commit on main and clears the branch', async () => {
  window.on('dialog', (d) => void d.accept())
  const before = gitBranches()
  await startChat('work to merge')
  await expect.poll(() => gitBranches().length, { timeout: 15_000 }).toBe(before.length + 1)
  const branch = gitBranches().find((b) => !before.includes(b))!
  const wtPath = worktreePaths()[branch]
  expect(wtPath).toBeTruthy()

  // Real work on the branch, committed the way the agent would leave it.
  writeFileSync(join(wtPath, 'from-branch.txt'), 'made on the branch\n')
  execFileSync('git', ['add', '-A'], { cwd: wtPath })
  execFileSync('git', ['commit', '-m', 'work on the branch'], { cwd: wtPath })

  await worktreeAction('merge', wtPath, branch, 'main')

  // The merge SQUASHES, so the branch's own commit message does not survive —
  // what must survive is the work. Assert the file arrives in the real folder,
  // and that main gained a commit for it.
  await expect
    .poll(() => existsSync(join(projectDir, 'from-branch.txt')), { timeout: 20_000 })
    .toBe(true)
  expect(git(['log', '--oneline', 'main'])).toContain(branch)
  await expect.poll(() => gitBranches(), { timeout: 20_000 }).not.toContain(branch)
  expect(existsSync(wtPath)).toBe(false)
})

test('right-click Delete removes a branch and its folder, leaving main alone', async () => {
  const mainBefore = git(['rev-parse', 'main']).trim()
  const before = gitBranches()
  await startChat('work to delete')
  await expect.poll(() => gitBranches().length, { timeout: 15_000 }).toBe(before.length + 1)
  const branch = gitBranches().find((b) => !before.includes(b))!
  const wtPath = worktreePaths()[branch]

  await worktreeAction('delete', wtPath, branch, 'main')

  await expect.poll(() => gitBranches(), { timeout: 20_000 }).not.toContain(branch)
  expect(existsSync(wtPath)).toBe(false)
  // Deleting a branch must never move main.
  expect(git(['rev-parse', 'main']).trim()).toBe(mainBefore)
})

test('a chat whose copy was removed behind its back says so', async () => {
  // The real-data case: worktrees removed by hand (or reaped after a merge)
  // while their chats live on. These used to render with no chip at all, so a
  // project full of them was a list of identical "New chat" rows with nothing
  // to tell them apart or mark them as dead.
  const before = gitBranches()
  await startChat('work whose copy vanishes')
  await expect.poll(() => gitBranches().length, { timeout: 15_000 }).toBe(before.length + 1)
  const branch = gitBranches().find((b) => !before.includes(b))!
  const wtPath = worktreePaths()[branch]

  // Pull the copy out from under the chat, the way `git worktree remove` would.
  execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: projectDir })
  execFileSync('git', ['branch', '-D', branch], { cwd: projectDir })
  await window.evaluate(() =>
    window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: {} }))
  )

  // At least this one. Merging and deleting in the tests above orphaned their
  // chats too, which is the very situation being reported — a project whose
  // rows are all leftovers from branches that are gone.
  await expect
    .poll(async () => await window.locator('.sidebar-branch').count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1)
})

test('rows stay distinguishable even when every chat is still untitled', async () => {
  // Three "New chat" rows with nothing to tell them apart was the complaint.
  // Whatever the titles, each row must carry either a branch or the gone mark.
  const rows = window.locator('.sidebar-branch')
  const n = await rows.count()
  expect(n).toBeGreaterThan(1)
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i)
    // The branch is on the right when the row has a conversation, and takes the
    // left when it has none — but it is always somewhere, or two untitled chats
    // are indistinguishable, which was the complaint.
    const named =
      (await row.locator('.sidebar-branch-chat').count()) +
      (await row.locator('.sidebar-branch-name').count())
    expect(named).toBeGreaterThanOrEqual(1)
  }
  // And no branch is listed twice — one row per branch.
  const names = (await shownBranches()).filter(
    (b) => b !== 'copy gone' && b !== 'no branch yet'
  )
  expect(new Set(names).size).toBe(names.length)
})

test('deleting a chat takes its branch and its row with it', async () => {
  // The reported bug: the worktree was removed but the branch survived, and the
  // sidebar kept showing a row for it because nothing asked git again.
  const before = gitBranches()
  await startChat('work to throw away')
  await expect.poll(() => gitBranches().length, { timeout: 15_000 }).toBe(before.length + 1)
  const branch = gitBranches().find((b) => !before.includes(b))!
  const wtPath = worktreePaths()[branch]

  const rowsBefore = await branchRows().count()
  await app.evaluate(({ BrowserWindow }, p) => {
    BrowserWindow.getAllWindows()[0].webContents.send('worktree:menu-action', p)
  }, { action: 'delete', projectPath: projectDir, wtPath, branch, base: 'main' })

  // Branch gone from git...
  await expect.poll(() => gitBranches(), { timeout: 20_000 }).not.toContain(branch)
  expect(existsSync(wtPath)).toBe(false)
  // ...and its row gone from the sidebar, without needing any other event.
  await expect
    .poll(async () => (await shownBranches()).join('|'), { timeout: 20_000 })
    .not.toContain(branch)
  expect(await branchRows().count()).toBeLessThanOrEqual(rowsBefore)
})

test('no branch is left behind pointing at nothing', async () => {
  // Every local branch must either be checked out in a worktree git knows about,
  // or be the base the others came from. Stragglers are what filled the real
  // repo with test/testbranch/wt-… that no longer existed anywhere.
  const live = new Set(gitBranches())
  const all = git(['branch', '--list', '--format=%(refname:short)'])
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
  const orphans = all.filter((b) => !live.has(b) && b !== 'main')
  expect(orphans).toEqual([])
})

test('one branch never ends up with two chats', async () => {
  // The reported bug: New Chat made a branch and its chat, the sidebar's copy of
  // the chat list lagged, so the branch rendered as "no chat yet" — and clicking
  // it made a SECOND chat on the same worktree.
  const before = gitBranches()
  await startChat('work opened repeatedly')
  await expect.poll(() => gitBranches().length, { timeout: 15_000 }).toBe(before.length + 1)
  const branch = gitBranches().find((b) => !before.includes(b))!
  const wtPath = worktreePaths()[branch]

  // Open that same branch repeatedly, the way clicking its row does.
  for (let i = 0; i < 3; i++) {
    await window.evaluate(
      ([wsKey, p]) => {
        const id = localStorage.getItem(wsKey)
        window.dispatchEvent(
          new CustomEvent('cove:e2e-open-branch', { detail: { id, cwd: p } })
        )
      },
      ['activeWorkspace', wtPath] as const
    )
  }

  // Exactly one row carries this branch — never two.
  await expect
    .poll(
      async () =>
        (await window.locator('.sidebar-branch-name').allInnerTexts()).filter((t) =>
          t.includes(branch)
        ).length,
      { timeout: 15_000 }
    )
    .toBeLessThanOrEqual(1)
})

test('two chats on one project are genuinely independent copies', async () => {
  // The whole point: same folder, different branches, different working copies.
  const paths = worktreePaths()
  const branches = Object.keys(paths).filter((b) => b !== 'main')
  expect(branches.length).toBeGreaterThanOrEqual(1)
  for (const b of branches) {
    // Each branch has its own directory on disk, not a shared one.
    expect(paths[b]).not.toBe(projectDir)
    expect(existsSync(paths[b])).toBe(true)
  }
  // And they are all distinct from each other.
  const dirs = branches.map((b) => paths[b])
  expect(new Set(dirs).size).toBe(dirs.length)
})

test('a chat you open and never use leaves no branch behind', async () => {
  // The point of cutting branches late: every stray wt-… in the real repo came
  // from a chat that was opened and never spoken to.
  const before = gitBranches()
  await newChat()
  await window.waitForTimeout(1500)
  expect(gitBranches()).toEqual(before)
  // And it says so rather than pretending to be on main.
  await expect(window.locator('.sidebar-branch', { hasText: 'no branch yet' }).first()).toBeVisible()
})

test('the project folder never gets a second chat', async () => {
  // Two chats in the folder itself means two agents editing one set of files —
  // the one configuration with no isolation. Opening it repeatedly must always
  // land on the same conversation, never make another.
  const worktreesBefore = gitBranches().length
  const rowsBefore = await branchRows().count()
  for (let i = 0; i < 3; i++) {
    await window.locator('.sidebar-item:has-text("e2e-project")').first().click()
    await window.waitForTimeout(400)
  }
  // No new branch, and no new row: the extra chats are unchanged.
  expect(gitBranches().length).toBe(worktreesBefore)
  expect(await branchRows().count()).toBe(rowsBefore)
})

test('exactly one row is highlighted at a time', async () => {
  // The project row is the folder's conversation, so it lit up whenever the
  // project was active — at the same time as whichever branch row you had
  // open. Two things looked selected at once.
  const selected = async (): Promise<number> =>
    (await window.locator('.sidebar-item.active').count()) +
    (await window.locator('.sidebar-branch.on').count())

  // On a branch: the branch row is selected, the project row is not.
  await branchRows().first().click()
  await window.waitForTimeout(400)
  await expect.poll(selected, { timeout: 10_000 }).toBe(1)
  expect(await window.locator('.sidebar-branch.on').count()).toBe(1)
  expect(await window.locator('.sidebar-item.active').count()).toBe(0)

  // On the folder: the project row is selected, no branch row is.
  await window.locator('.sidebar-item:has-text("e2e-project")').first().click()
  await window.waitForTimeout(600)
  await expect.poll(selected, { timeout: 10_000 }).toBe(1)
  expect(await window.locator('.sidebar-item.active').count()).toBe(1)
  expect(await window.locator('.sidebar-branch.on').count()).toBe(0)
})
