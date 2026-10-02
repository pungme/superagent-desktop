import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  nativeImage: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
const chats = new Map<string, { cwd?: string }>()
vi.mock('./store', () => ({
  getChat: (id: string) => chats.get(id),
  setChatCwd: (id: string, cwd: string) => chats.set(id, { cwd }),
  takePendingBranch: () => true
}))
vi.mock('./util', () => ({ broadcastToWindows: () => undefined }))

import {
  copyKind,
  copyStatus,
  createWorktreeSet,
  cutChatBranch,
  cutRepo,
  ensureChatBranch,
  listWorktreeSets,
  mergeCopy,
  removeCopy,
  renameCopy,
  setBranch,
  shrinkCopy,
  MAX_SET_REPOS
} from './chat-copy'
import {
  describeRepoSet,
  isRepoSet,
  linkedRepos,
  projectMemoryDir,
  repoAt,
  repoSetOf,
  setMetaPath
} from './repo-set'
import { copyBeforeWrite, writesFiles } from './copy-on-write'

// Real git, in a throwaway folder. Everything here is about what ends up on
// disk and in each repo's history, which a mock of git could only agree with.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com'
}
const saved = { ...process.env }
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

let root: string

/** A repo with one commit on main, inside the project folder. */
function repo(
  name: string,
  files: Record<string, string> = { 'README.md': `# ${name}\n` }
): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

/** The chat is about to change these repos: give it a worktree of each. */
async function change(dir: string, ...names: string[]): Promise<void> {
  for (const name of names) expect(await cutRepo(dir, name)).toMatchObject({ ok: true })
}

const isLink = (path: string): boolean => lstatSync(path).isSymbolicLink()

const subjects = (dir: string, ref = 'main'): string[] =>
  git(dir, 'log', '--format=%s', ref).split('\n')
const branches = (dir: string): string[] =>
  git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n')

beforeEach(() => {
  Object.assign(process.env, env)
  // realpath: macOS hands out /var/… and git answers /private/var/….
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-set-')))
  chats.clear()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('copyKind', () => {
  it('is the project when it is a repo, its repos when it is a folder of them', () => {
    expect(copyKind(root)).toBeNull()
    repo('api')
    expect(copyKind(root)).toBe('repos')
    expect(copyKind(join(root, 'api'))).toBe('repo')
  })

  it('leaves a folder of a great many repos alone', () => {
    for (let i = 0; i <= MAX_SET_REPOS; i++) {
      mkdirSync(join(root, `r${i}`, '.git'), { recursive: true })
      writeFileSync(join(root, `r${i}`, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    }
    expect(copyKind(root)).toBeNull()
  })
})

describe('a copy of a folder of repos', () => {
  it('starts as links to everything, with no worktree and no branch anywhere', async () => {
    const api = repo('api')
    const web = repo('web')
    mkdirSync(join(root, 'designs'))
    writeFileSync(join(root, 'designs', 'logo.txt'), 'logo')
    writeFileSync(join(root, 'notes.md'), 'notes')
    writeFileSync(join(root, 'CLAUDE.md'), 'rules')

    const set = await createWorktreeSet(root, { newBranch: 'add-login', autoName: true })
    expect(set).not.toBeNull()
    const dir = set!.path
    expect(dir.startsWith(join(root, '.worktrees') + '/')).toBe(true)
    expect(set!.branch).toBe('add-login')
    expect(isRepoSet(dir)).toBe(true)

    for (const name of ['api', 'web', 'designs', 'notes.md'])
      expect(isLink(join(dir, name))).toBe(true)
    // Reading a repo reads the project's.
    expect(readFileSync(join(dir, 'api', 'README.md'), 'utf8')).toBe('# api\n')
    expect(readFileSync(join(dir, 'designs', 'logo.txt'), 'utf8')).toBe('logo')
    // Claude Code reads the project's CLAUDE.md from two levels up; a link
    // here would have it read twice.
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['api', 'designs', 'notes.md', 'web'])
    // Nothing was done to either repo: this is the whole point.
    for (const r of [api, web]) {
      expect(branches(r)).toEqual(['main'])
      expect(git(r, 'worktree', 'list').split('\n')).toHaveLength(1)
    }

    expect(describeRepoSet(dir)).toEqual({ root, repos: [], linked: ['api', 'web'] })
    expect(linkedRepos(dir)).toEqual(['api', 'web'])
    expect(setBranch(dir)).toEqual({ branch: 'add-login', autoName: true })
    // A copy with no worktree holds no work, so it is not listed as some.
    expect(listWorktreeSets(root)).toEqual([])
    expect(await copyStatus(root, dir)).toEqual({ dirty: false, ahead: 0, repos: [] })
  })

  it('cuts a worktree of the one repo a chat is about to change, in place of its link', async () => {
    const api = repo('api')
    const web = repo('web')
    const dir = (await createWorktreeSet(root, { newBranch: 'add-login', autoName: true }))!.path

    const cut = await cutRepo(dir, 'api')
    expect(cut).toEqual({ ok: true, path: join(dir, 'api'), branch: 'add-login', fresh: true })
    expect(isLink(join(dir, 'api'))).toBe(false)
    expect(git(join(dir, 'api'), 'symbolic-ref', '--short', 'HEAD')).toBe('add-login')
    expect(readFileSync(join(dir, 'api', 'README.md'), 'utf8')).toBe('# api\n')
    // The original is exactly where it was.
    expect(git(api, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(api, 'status', '--porcelain')).toBe('')
    expect(branches(api)).toEqual(['add-login', 'main'])
    // And the repo it did not change has had nothing done to it.
    expect(isLink(join(dir, 'web'))).toBe(true)
    expect(branches(web)).toEqual(['main'])
    expect(git(web, 'worktree', 'list').split('\n')).toHaveLength(1)

    expect(describeRepoSet(dir)).toEqual({ root, repos: ['api'], linked: ['web'] })
    expect(listWorktreeSets(root)).toEqual([
      { path: dir, branch: 'add-login', repos: [{ name: 'api', branch: 'add-login' }] }
    ])

    // Asking again is free, and a second repo joins on the same branch.
    expect(await cutRepo(dir, 'api')).toMatchObject({ ok: true, fresh: false })
    expect(await cutRepo(dir, 'web')).toMatchObject({ ok: true, branch: 'add-login', fresh: true })
    expect(branches(web)).toEqual(['add-login', 'main'])
    expect(await cutRepo(dir, 'nope')).toEqual({ ok: false, reason: 'not-a-repo' })
  })

  it('cuts one worktree when two tools reach for the same repo at once', async () => {
    const api = repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    const [a, b] = await Promise.all([cutRepo(dir, 'api'), cutRepo(dir, 'api')])
    expect([a, b].map((r) => r.ok)).toEqual([true, true])
    expect([a, b].filter((r) => r.ok && r.fresh)).toHaveLength(1)
    expect(git(api, 'worktree', 'list').split('\n')).toHaveLength(2)
  })

  it('steps round a branch name the repo has gained since the copy was made', async () => {
    const api = repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'fix', autoName: true }))!.path
    git(api, 'branch', 'fix')
    expect(await cutRepo(dir, 'api')).toMatchObject({ ok: true, branch: 'fix-2' })
  })

  it('takes a name no repo has yet, so two chats that open alike both get a copy', async () => {
    const api = repo('api')
    repo('web')
    git(api, 'branch', 'fix-login')
    const a = await createWorktreeSet(root, { newBranch: 'fix-login', autoName: true })
    expect(a!.branch).toBe('fix-login-2')
    const b = await createWorktreeSet(root, { newBranch: 'fix-login', autoName: true })
    expect(b!.branch).toBe('fix-login-3')
    expect(b!.path).not.toBe(a!.path)
    await change(a!.path, 'web')
    await change(b!.path, 'web')
    expect(git(join(b!.path, 'web'), 'symbolic-ref', '--short', 'HEAD')).toBe('fix-login-3')
  })

  it('leaves a repo git cannot cut as a link, and says why', async () => {
    repo('api')
    mkdirSync(join(root, 'fresh'))
    git(join(root, 'fresh'), 'init', '-q', '-b', 'main') // no commits: nothing to branch from
    const set = await createWorktreeSet(root, { newBranch: 'x', autoName: true })
    expect(await cutRepo(set!.path, 'fresh')).toMatchObject({ ok: false, reason: 'error' })
    expect(isLink(join(set!.path, 'fresh'))).toBe(true)
    expect(describeRepoSet(set!.path)!.repos).toEqual([])
  })

  it('links installed dependencies in, one folder down as well', async () => {
    const web = repo('web', { 'app/package.json': '{}', '.gitignore': 'node_modules\n' })
    mkdirSync(join(web, 'app', 'node_modules', 'left-pad'), { recursive: true })
    const set = await createWorktreeSet(root, { newBranch: 'x', autoName: true })
    await change(set!.path, 'web')
    const linked = join(set!.path, 'web', 'app', 'node_modules')
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(existsSync(join(linked, 'left-pad'))).toBe(true)
    expect(git(join(set!.path, 'web'), 'status', '--porcelain')).toBe('')
  })

  it('is what a new chat is given, and is thrown away if the chat died meanwhile', async () => {
    repo('api')
    chats.set('c1', {})
    const cwd = await cutChatBranch('c1', root, 'Please add a login page')
    expect(cwd && isRepoSet(cwd)).toBe(true)
    expect(chats.get('c1')!.cwd).toBe(cwd)
    // The first message names the branch; nothing is on it until a repo changes.
    expect(branches(join(root, 'api'))).toEqual(['main'])
    await change(cwd!, 'api')
    expect(git(join(cwd!, 'api'), 'symbolic-ref', '--short', 'HEAD')).toBe('add-login-page')

    expect(await cutChatBranch('gone', root, 'another thing')).toBeNull()
    expect(readdirSync(join(root, '.worktrees')).sort()).toEqual(
      [cwd!, setMetaPath(cwd!)].map((p) => p.split('/').pop()).sort()
    )
    expect(branches(join(root, 'api'))).toEqual(['add-login-page', 'main'])
  })
})

describe('status', () => {
  it('says which repos a chat changed, and counts a file written beside them', async () => {
    repo('api')
    repo('web')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    expect(await copyStatus(root, dir)).toEqual({ dirty: false, ahead: 0, repos: [] })

    await change(dir, 'web')
    expect(await copyStatus(root, dir)).toEqual({ dirty: false, ahead: 0, repos: [] })
    writeFileSync(join(dir, 'web', 'new.txt'), 'hi')
    expect(await copyStatus(root, dir)).toEqual({ dirty: true, ahead: 0, repos: ['web'] })

    git(join(dir, 'web'), 'add', '-A')
    git(join(dir, 'web'), 'commit', '-q', '-m', 'wip')
    expect(await copyStatus(root, dir)).toEqual({ dirty: false, ahead: 1, repos: ['web'] })

    writeFileSync(join(dir, 'plan.md'), 'a plan')
    expect((await copyStatus(root, dir)).dirty).toBe(true)
  })
})

describe('keep', () => {
  it('lands one change in each repo the chat touched and removes the copy', async () => {
    const api = repo('api')
    const web = repo('web')
    const docs = repo('docs')
    const dir = (await createWorktreeSet(root, { newBranch: 'add-login', autoName: true }))!.path
    await change(dir, 'api', 'web')

    writeFileSync(join(dir, 'api', 'login.ts'), 'api')
    git(join(dir, 'api'), 'add', '-A')
    git(join(dir, 'api'), 'commit', '-q', '-m', 'step one')
    writeFileSync(join(dir, 'api', 'login.ts'), 'api v2') // and more, uncommitted
    writeFileSync(join(dir, 'web', 'login.tsx'), 'web')
    writeFileSync(join(dir, 'plan.md'), 'a plan')

    const res = await mergeCopy(root, dir, 'Add login')
    expect(res).toEqual({ ok: true, committed: true, repos: ['api', 'web'] })

    expect(subjects(api)).toEqual(['Add login', 'first'])
    expect(readFileSync(join(api, 'login.ts'), 'utf8')).toBe('api v2')
    expect(subjects(web)).toEqual(['Add login', 'first'])
    expect(subjects(docs)).toEqual(['first'])
    for (const r of [api, web, docs]) {
      expect(branches(r)).toEqual(['main'])
      expect(git(r, 'status', '--porcelain')).toBe('')
      expect(git(r, 'worktree', 'list').split('\n')).toHaveLength(1)
    }
    // What it wrote beside the repos goes beside the real ones.
    expect(readFileSync(join(root, 'plan.md'), 'utf8')).toBe('a plan')
    expect(existsSync(join(root, '.worktrees'))).toBe(false)
  })

  it('lands nothing anywhere when one repo clashes', async () => {
    const api = repo('api')
    const web = repo('web', { 'page.txt': 'one\n' })
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    await change(dir, 'api', 'web')
    writeFileSync(join(dir, 'api', 'a.txt'), 'fine')
    writeFileSync(join(dir, 'web', 'page.txt'), 'from the chat\n')
    // Meanwhile the project moved on, on the same line.
    writeFileSync(join(web, 'page.txt'), 'from elsewhere\n')
    git(web, 'commit', '-q', '-am', 'elsewhere')

    const res = await mergeCopy(root, dir, 'Keep')
    expect(res).toMatchObject({ ok: false, reason: 'conflict', repo: 'web' })
    // api could have landed, and did not.
    expect(subjects(api)).toEqual(['first'])
    expect(subjects(web)).toEqual(['elsewhere', 'first'])
    expect(git(web, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(web, 'page.txt'), 'utf8')).toBe('from elsewhere\n')
    // And the copy is still there to sort it out in.
    expect(readFileSync(join(dir, 'web', 'page.txt'), 'utf8')).toBe('from the chat\n')
    expect(listWorktreeSets(root)).toHaveLength(1)
  })

  it('refuses over unsaved work in a repo it would land in — but only in those', async () => {
    const api = repo('api')
    const web = repo('web')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    await change(dir, 'api')
    writeFileSync(join(dir, 'api', 'a.txt'), 'change')

    writeFileSync(join(web, 'scratch.txt'), 'mine') // untouched by the chat: not its business
    expect((await mergeCopy(root, dir, 'Keep')).ok).toBe(true)
    expect(subjects(api)).toEqual(['Keep', 'first'])
    expect(readFileSync(join(web, 'scratch.txt'), 'utf8')).toBe('mine')

    const dir2 = (await createWorktreeSet(root, { newBranch: 'y', autoName: true }))!.path
    await change(dir2, 'web')
    writeFileSync(join(dir2, 'web', 'b.txt'), 'change')
    expect(await mergeCopy(root, dir2, 'Keep')).toMatchObject({
      ok: false,
      reason: 'base-dirty',
      repo: 'web'
    })
    expect(subjects(web)).toEqual(['first'])
  })

  it('lands on the branch each copy was cut from, even when the project has moved off it', async () => {
    const api = repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    await change(dir, 'api')
    writeFileSync(join(dir, 'api', 'a.txt'), 'change')
    git(api, 'checkout', '-q', '-b', 'elsewhere')
    writeFileSync(join(api, 'wip.txt'), 'unsaved') // not on main, so not in the way

    expect((await mergeCopy(root, dir, 'Keep')).ok).toBe(true)
    expect(subjects(api, 'main')).toEqual(['Keep', 'first'])
    expect(subjects(api, 'elsewhere')).toEqual(['first'])
    expect(readFileSync(join(api, 'wip.txt'), 'utf8')).toBe('unsaved')
  })

  it('treats a repo the agent started in its copy as something it made, not one of the project’s', async () => {
    const api = repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    mkdirSync(join(dir, 'tools'))
    git(join(dir, 'tools'), 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'tools', 'run.sh'), 'echo hi')
    expect(describeRepoSet(dir)).toEqual({ root, repos: [], linked: ['api'] })
    expect(await copyStatus(root, dir)).toEqual({ dirty: true, ahead: 0, repos: [] })

    expect(await mergeCopy(root, dir, 'Keep')).toEqual({ ok: true, committed: true, repos: [] })
    // Moved out beside the real repos, whole.
    expect(readFileSync(join(root, 'tools', 'run.sh'), 'utf8')).toBe('echo hi')
    expect(existsSync(join(root, 'tools', '.git'))).toBe(true)
    expect(subjects(api)).toEqual(['first'])
  })

  it('has nothing to keep from a chat that changed nothing', async () => {
    repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    expect(await mergeCopy(root, dir, 'Keep')).toEqual({ ok: false, reason: 'nothing' })
    expect(existsSync(dir)).toBe(true)
    // Nor from one that took a worktree and then left it as it found it.
    await change(dir, 'api')
    expect(await mergeCopy(root, dir, 'Keep')).toEqual({ ok: false, reason: 'nothing' })
    expect(listWorktreeSets(root)).toHaveLength(1)
  })
})

describe('throw away', () => {
  it('removes every worktree and branch, and nothing the links point at', async () => {
    const api = repo('api')
    const web = repo('web')
    mkdirSync(join(root, 'designs'))
    writeFileSync(join(root, 'designs', 'logo.txt'), 'logo')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    await change(dir, 'api')
    writeFileSync(join(dir, 'api', 'a.txt'), 'doomed')
    writeFileSync(join(dir, 'plan.md'), 'doomed too')

    expect(await removeCopy(root, dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(root, '.worktrees'))).toBe(false)
    for (const r of [api, web]) {
      expect(branches(r)).toEqual(['main'])
      expect(subjects(r)).toEqual(['first'])
      expect(git(r, 'worktree', 'list').split('\n')).toHaveLength(1)
    }
    expect(readFileSync(join(root, 'designs', 'logo.txt'), 'utf8')).toBe('logo')
    expect(existsSync(join(root, 'plan.md'))).toBe(false)
    // The repo it only linked to is the project's, and is still there.
    expect(readFileSync(join(web, 'README.md'), 'utf8')).toBe('# web\n')
  })

  it('leaves the other chats’ copies where they are', async () => {
    repo('api')
    const a = (await createWorktreeSet(root, { newBranch: 'a', autoName: true }))!.path
    const b = (await createWorktreeSet(root, { newBranch: 'b', autoName: true }))!.path
    await change(a, 'api')
    await change(b, 'api')
    await removeCopy(root, a)
    expect(listWorktreeSets(root).map((s) => s.path)).toEqual([b])
    expect(branches(join(root, 'api'))).toEqual(['b', 'main'])
  })
})

describe('rename', () => {
  it('moves every repo to the same new name', async () => {
    const api = repo('api')
    const web = repo('web')
    const dir = (await createWorktreeSet(root, { newBranch: 'can-you-help', autoName: true }))!.path
    await change(dir, 'api', 'web')
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login' })
    expect(branches(api)).toEqual(['add-login', 'main'])
    expect(branches(web)).toEqual(['add-login', 'main'])
    // Saying it again changes nothing, rather than hunting for a free name.
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login' })
    expect(branches(api)).toEqual(['add-login', 'main'])
  })

  it('renames a copy with no worktree yet, so the first one is cut on the new name', async () => {
    const api = repo('api')
    const web = repo('web')
    git(web, 'branch', 'add-login')
    const dir = (await createWorktreeSet(root, { newBranch: 'can-you-help', autoName: true }))!.path
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login-2' })
    expect(branches(api)).toEqual(['main'])
    await change(dir, 'api')
    expect(branches(api)).toEqual(['add-login-2', 'main'])
  })

  it('cuts a later repo on the name the earlier ones were renamed to', async () => {
    const web = repo('web')
    repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'can-you-help', autoName: true }))!.path
    await change(dir, 'api')
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login' })
    await change(dir, 'web')
    expect(branches(web)).toEqual(['add-login', 'main'])
  })

  it('steps round a name one repo already has, in all of them', async () => {
    const api = repo('api')
    const web = repo('web')
    git(web, 'branch', 'add-login')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    await change(dir, 'api', 'web')
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login-2' })
    expect(branches(api)).toEqual(['add-login-2', 'main'])
    expect(branches(web)).toEqual(['add-login', 'add-login-2', 'main'])
  })

  it('never renames a branch the user named', async () => {
    const api = repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'release-2' }))!.path
    expect((await renameCopy(dir, 'something-else')).ok).toBe(false)
    await change(dir, 'api')
    expect((await renameCopy(dir, 'something-else')).ok).toBe(false)
    expect(branches(api)).toEqual(['main', 'release-2'])
  })
})

describe('a project that is one repo', () => {
  it('still gets one worktree, and a second chat with the same opening gets its own', async () => {
    const api = repo('api')
    const a = await ensureChatBranch(api, 'fix the login')
    const b = await ensureChatBranch(api, 'fix the login')
    expect(a && b && a !== b).toBe(true)
    expect(isRepoSet(a!)).toBe(false)
    expect(branches(api)).toEqual(['fix-login', 'fix-login-2', 'main'])
    expect(listWorktreeSets(api)).toEqual([])

    writeFileSync(join(a!, 'a.txt'), 'change')
    expect(await copyStatus(api, a!)).toEqual({ dirty: true, ahead: 0 })
    expect(await mergeCopy(api, a!, 'Fix login')).toEqual({ ok: true, committed: true })
    expect(subjects(api)).toEqual(['Fix login', 'first'])
    expect(await removeCopy(api, b!)).toBe(true)
    expect(branches(api)).toEqual(['main'])
  })
})

describe('projectMemoryDir', () => {
  it('points an agent in a copy at the memory of the project, not of the copy', async () => {
    repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    await change(dir, 'api')
    process.env.CLAUDE_CONFIG_DIR = '/cfg'
    try {
      expect(projectMemoryDir(dir)).toBe(
        `/cfg/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/memory`
      )
      // A worktree of one repo is traced to its repo by Claude Code itself.
      expect(projectMemoryDir(root)).toBeNull()
      expect(projectMemoryDir(join(dir, 'api'))).toBeNull()
      expect(projectMemoryDir(undefined)).toBeNull()
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
    }
  })
})

describe('shrinking a copy', () => {
  it('puts back as links the repos a chat has a worktree of and never changed', async () => {
    const api = repo('api')
    const web = repo('web')
    const docs = repo('docs')
    const dir = (await createWorktreeSet(root, { newBranch: 'add-login', autoName: true }))!.path
    await change(dir, 'api', 'web', 'docs')
    // A copy from before the branch was written down.
    rmSync(setMetaPath(dir))
    writeFileSync(join(dir, 'api', 'login.ts'), 'unsaved')
    writeFileSync(join(dir, 'web', 'login.tsx'), 'web')
    git(join(dir, 'web'), 'add', '-A')
    git(join(dir, 'web'), 'commit', '-q', '-m', 'wip')
    // The project moving on is not the chat changing anything.
    writeFileSync(join(docs, 'more.md'), 'more')
    git(docs, 'add', '-A')
    git(docs, 'commit', '-q', '-m', 'elsewhere')

    expect(await shrinkCopy(dir)).toEqual({ linked: ['docs'], kept: ['api', 'web'] })
    expect(isLink(join(dir, 'docs'))).toBe(true)
    expect(branches(docs)).toEqual(['main'])
    expect(git(docs, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(readFileSync(join(dir, 'api', 'login.ts'), 'utf8')).toBe('unsaved')
    expect(branches(api)).toEqual(['add-login', 'main'])
    expect(branches(web)).toEqual(['add-login', 'main'])
    expect(describeRepoSet(dir)).toEqual({ root, repos: ['api', 'web'], linked: ['docs'] })

    // Shrunk to nothing, it still knows its branch, and cuts on it again.
    const bare = (await createWorktreeSet(root, { newBranch: 'other', autoName: true }))!.path
    await change(bare, 'docs')
    rmSync(setMetaPath(bare))
    expect(await shrinkCopy(bare)).toEqual({ linked: ['docs'], kept: [] })
    expect(setBranch(bare)).toEqual({ branch: 'other', autoName: true })
    await change(bare, 'docs')
    expect(git(join(bare, 'docs'), 'symbolic-ref', '--short', 'HEAD')).toBe('other')
  })
})

describe('which repo a path is in', () => {
  it('knows a link from a worktree, through the copy or through the project', async () => {
    repo('api')
    repo('web')
    writeFileSync(join(root, 'notes.md'), 'notes')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    await change(dir, 'web')

    expect(repoAt(dir, join(dir, 'api', 'src', 'a.ts'))).toEqual({
      name: 'api',
      state: 'linked',
      viaOriginal: false,
      inCopy: join(dir, 'api', 'src', 'a.ts')
    })
    expect(repoAt(dir, 'src/a.ts', join(dir, 'api'))).toMatchObject({
      name: 'api',
      state: 'linked'
    })
    expect(repoAt(dir, join(root, 'api', 'a.ts'))).toEqual({
      name: 'api',
      state: 'linked',
      viaOriginal: true,
      inCopy: join(dir, 'api', 'a.ts')
    })
    expect(repoAt(dir, join(dir, 'web', 'a.ts'))).toMatchObject({
      state: 'copied',
      viaOriginal: false
    })
    expect(repoAt(dir, join(root, 'web', 'a.ts'))).toMatchObject({
      state: 'copied',
      viaOriginal: true
    })
    // Not in a repo at all: a loose file, the copy itself, somewhere else.
    expect(repoAt(dir, join(dir, 'notes.md'))).toBeNull()
    expect(repoAt(dir, join(dir, 'plan.md'))).toBeNull()
    expect(repoAt(dir, dir)).toBeNull()
    expect(repoAt(dir, '/tmp/elsewhere.txt')).toBeNull()
    expect(repoAt(dir, join(root, '.worktrees', 'other', 'api', 'a.ts'))).toBeNull()

    expect(repoSetOf(dir)).toBe(dir)
    expect(repoSetOf(join(dir, 'web', 'src'))).toBe(dir)
    expect(repoSetOf(join(root, 'api'))).toBeNull()
    expect(repoSetOf(undefined)).toBeNull()
  })
})

describe('a change about to happen', () => {
  it('cuts the repo a file edit is aimed at, once, and holds the edit back to be repeated', async () => {
    const api = repo('api')
    const web = repo('web')
    const dir = (await createWorktreeSet(root, { newBranch: 'add-login', autoName: true }))!.path
    const file = join(dir, 'api', 'README.md')

    // Reading and loose files are nobody's business.
    expect(await copyBeforeWrite('Read', { file_path: file }, dir)).toBeNull()
    expect(await copyBeforeWrite('Write', { file_path: join(dir, 'plan.md') }, dir)).toBeNull()
    expect(branches(api)).toEqual(['main'])

    const held = await copyBeforeWrite('Edit', { file_path: file }, dir)
    expect(held).toContain('Not an error')
    expect(held).toContain(join(dir, 'api'))
    expect(held).toContain('`add-login`')
    expect(isLink(join(dir, 'api'))).toBe(false)
    expect(branches(api)).toEqual(['add-login', 'main'])
    // The same edit again goes through, into the worktree.
    expect(await copyBeforeWrite('Edit', { file_path: file }, dir)).toBeNull()
    // The other repo was never touched.
    expect(isLink(join(dir, 'web'))).toBe(true)
    expect(branches(web)).toEqual(['main'])
  })

  it("catches an edit aimed at the project's own checkout, before and after the cut", async () => {
    const api = repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    const original = join(api, 'README.md')
    expect(await copyBeforeWrite('Write', { file_path: original }, dir)).toContain(
      join(dir, 'api', 'README.md')
    )
    expect(branches(api)).toEqual(['main', 'x'])
    const again = await copyBeforeWrite('Write', { file_path: original }, dir)
    expect(again).toContain('shared checkout')
    expect(again).toContain(join(dir, 'api', 'README.md'))
  })

  it('cuts the repo a shell command that writes is run in or names — and no other', async () => {
    const api = repo('api')
    const web = repo('web')
    const docs = repo('docs')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path

    expect(
      await copyBeforeWrite('Bash', { command: 'git status && ls -la' }, dir, join(dir, 'api'))
    ).toBeNull()
    expect(
      await copyBeforeWrite('Bash', { command: 'cat api/README.md | head -3' }, dir, dir)
    ).toBeNull()
    expect(await copyBeforeWrite('Bash', { command: 'mkdir -p /tmp/out' }, dir, dir)).toBeNull()
    expect(branches(api)).toEqual(['main'])

    const inside = await copyBeforeWrite(
      'Bash',
      { command: 'git commit -am wip' },
      dir,
      join(dir, 'api')
    )
    expect(inside).toContain('Run the command again')
    expect(branches(api)).toEqual(['main', 'x'])
    expect(
      await copyBeforeWrite('Bash', { command: 'git commit -am wip' }, dir, join(dir, 'api'))
    ).toBeNull()

    // A shell that stepped through the link reports the project's folder.
    expect(
      await copyBeforeWrite('Bash', { command: 'npm install' }, dir, join(web, 'app'))
    ).toContain('`web`')
    expect(branches(web)).toEqual(['main', 'x'])

    expect(
      await copyBeforeWrite('Bash', { command: 'cd docs && echo hi > notes.txt' }, dir, dir)
    ).toContain('`docs`')
    expect(branches(docs)).toEqual(['main', 'x'])
  })

  it('stops a search from the top passing over the repos that are only links', async () => {
    repo('api')
    repo('web')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    const held = await copyBeforeWrite('Grep', { pattern: 'login' }, dir, dir)
    expect(held).toContain('`api`')
    expect(held).toContain('rg --follow')
    expect(
      await copyBeforeWrite('Glob', { pattern: '**/*.ts', path: dir }, dir, dir)
    ).not.toBeNull()
    // Pointed at a repo, search follows the link and is left alone.
    expect(await copyBeforeWrite('Grep', { pattern: 'login', path: 'api' }, dir, dir)).toBeNull()
    expect(
      await copyBeforeWrite('Grep', { pattern: 'login', path: join(dir, 'web') }, dir, dir)
    ).toBeNull()
    // With every repo its own worktree there is nothing to miss.
    await change(dir, 'api', 'web')
    expect(await copyBeforeWrite('Grep', { pattern: 'login' }, dir, dir)).toBeNull()
  })

  it('has nothing to say outside a copy of a folder of repos', async () => {
    const api = repo('api')
    const wt = await ensureChatBranch(api, 'fix the login')
    expect(await copyBeforeWrite('Edit', { file_path: join(wt!, 'README.md') }, wt!)).toBeNull()
    expect(await copyBeforeWrite('Grep', { pattern: 'x' }, wt!, wt!)).toBeNull()
    expect(
      await copyBeforeWrite('Edit', { file_path: join(api, 'README.md') }, undefined)
    ).toBeNull()
  })
})

describe('writesFiles', () => {
  it('tells a command that changes files from one that only looks', () => {
    for (const c of [
      'git commit -m "x"',
      'git -C api checkout -b feature',
      'git stash',
      'cd api && npm install',
      'pnpm add zod',
      'rm -rf dist',
      'ls && mv a b',
      "sed -i '' 's/a/b/' file.ts",
      'echo hi > out.txt',
      'node gen.js >> log.txt',
      'pod install'
    ]) {
      expect(writesFiles(c), c).toBe(true)
    }
    for (const c of [
      'git status',
      'git log --oneline -5',
      'git diff main...HEAD',
      'git branch --list',
      'ls -la',
      'rg -n "foo" src | head -20',
      'npm test 2>&1 | tail -5',
      'npm run typecheck',
      'cat a.txt 2>/dev/null',
      'echo "a => b"',
      'test 3 -gt 2 && echo yes',
      'grep -rn "x" . > /dev/null'
    ]) {
      expect(writesFiles(c), c).toBe(false)
    }
  })
})
