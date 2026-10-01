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
  ensureChatBranch,
  listWorktreeSets,
  mergeCopy,
  removeCopy,
  renameCopy,
  MAX_SET_REPOS
} from './chat-copy'
import { describeRepoSet, isRepoSet, projectMemoryDir } from './repo-set'

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
  it('is the folder over again: a worktree of each repo on one branch, and links to the rest', async () => {
    repo('api')
    repo('web')
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

    for (const name of ['api', 'web']) {
      expect(git(join(dir, name), 'symbolic-ref', '--short', 'HEAD')).toBe('add-login')
      expect(readFileSync(join(dir, name, 'README.md'), 'utf8')).toBe(`# ${name}\n`)
      // The original is exactly where it was.
      expect(git(join(root, name), 'symbolic-ref', '--short', 'HEAD')).toBe('main')
      expect(git(join(root, name), 'status', '--porcelain')).toBe('')
    }
    // What belongs to no repo is shared, not copied.
    expect(lstatSync(join(dir, 'designs')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dir, 'designs', 'logo.txt'), 'utf8')).toBe('logo')
    expect(lstatSync(join(dir, 'notes.md')).isSymbolicLink()).toBe(true)
    // Claude Code reads the project's CLAUDE.md from two levels up; a link
    // here would have it read twice.
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['api', 'designs', 'notes.md', 'web'])

    expect(describeRepoSet(dir)).toEqual({ root, repos: ['api', 'web'] })
    expect(listWorktreeSets(root)).toEqual([
      {
        path: dir,
        branch: 'add-login',
        repos: [
          { name: 'api', branch: 'add-login' },
          { name: 'web', branch: 'add-login' }
        ]
      }
    ])
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
    expect(git(join(b!.path, 'web'), 'symbolic-ref', '--short', 'HEAD')).toBe('fix-login-3')
  })

  it('links a repo git cannot cut, rather than leaving it out', async () => {
    repo('api')
    mkdirSync(join(root, 'fresh'))
    git(join(root, 'fresh'), 'init', '-q', '-b', 'main') // no commits: nothing to branch from
    const set = await createWorktreeSet(root, { newBranch: 'x', autoName: true })
    expect(lstatSync(join(set!.path, 'fresh')).isSymbolicLink()).toBe(true)
    expect(describeRepoSet(set!.path)!.repos).toEqual(['api'])
  })

  it('links installed dependencies in, one folder down as well', async () => {
    const web = repo('web', { 'app/package.json': '{}', '.gitignore': 'node_modules\n' })
    mkdirSync(join(web, 'app', 'node_modules', 'left-pad'), { recursive: true })
    const set = await createWorktreeSet(root, { newBranch: 'x', autoName: true })
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
    expect(git(join(cwd!, 'api'), 'symbolic-ref', '--short', 'HEAD')).toBe('add-login-page')

    expect(await cutChatBranch('gone', root, 'another thing')).toBeNull()
    expect(listWorktreeSets(root).map((s) => s.path)).toEqual([cwd])
    expect(branches(join(root, 'api'))).toEqual(['add-login-page', 'main'])
  })
})

describe('status', () => {
  it('says which repos a chat changed, and counts a file written beside them', async () => {
    repo('api')
    repo('web')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
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
    writeFileSync(join(dir, 'api', 'a.txt'), 'change')

    writeFileSync(join(web, 'scratch.txt'), 'mine') // untouched by the chat: not its business
    expect((await mergeCopy(root, dir, 'Keep')).ok).toBe(true)
    expect(subjects(api)).toEqual(['Keep', 'first'])
    expect(readFileSync(join(web, 'scratch.txt'), 'utf8')).toBe('mine')

    const dir2 = (await createWorktreeSet(root, { newBranch: 'y', autoName: true }))!.path
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
    expect(describeRepoSet(dir)!.repos).toEqual(['api'])
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
  })

  it('leaves the other chats’ copies where they are', async () => {
    repo('api')
    const a = (await createWorktreeSet(root, { newBranch: 'a', autoName: true }))!.path
    const b = (await createWorktreeSet(root, { newBranch: 'b', autoName: true }))!.path
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
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login' })
    expect(branches(api)).toEqual(['add-login', 'main'])
    expect(branches(web)).toEqual(['add-login', 'main'])
    // Saying it again changes nothing, rather than hunting for a free name.
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login' })
    expect(branches(api)).toEqual(['add-login', 'main'])
  })

  it('steps round a name one repo already has, in all of them', async () => {
    const api = repo('api')
    const web = repo('web')
    git(web, 'branch', 'add-login')
    const dir = (await createWorktreeSet(root, { newBranch: 'x', autoName: true }))!.path
    expect(await renameCopy(dir, 'add-login')).toEqual({ ok: true, branch: 'add-login-2' })
    expect(branches(api)).toEqual(['add-login-2', 'main'])
    expect(branches(web)).toEqual(['add-login', 'add-login-2', 'main'])
  })

  it('never renames a branch the user named', async () => {
    const api = repo('api')
    const dir = (await createWorktreeSet(root, { newBranch: 'release-2' }))!.path
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
