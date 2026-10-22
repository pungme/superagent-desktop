import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), on: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  nativeImage: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
const { gitDirFast } = await import('./files')

describe('a worktree’s git folder, without running git', () => {
  it('agrees with git for a real linked worktree and the main checkout', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gdf-')))
    const git = (...a: string[]): string =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
    const wt = join(repo, '.worktrees', 'one')
    mkdirSync(join(repo, '.worktrees'))
    git('worktree', 'add', '-q', wt)
    const viaGit = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: wt,
      encoding: 'utf8'
    }).trim()
    expect(gitDirFast(wt)).toBe(viaGit)
    expect(gitDirFast(repo)).toBe(join(repo, '.git'))
  })

  it('follows a relative gitdir line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gdf-rel-'))
    writeFileSync(join(dir, '.git'), 'gitdir: ../elsewhere/.git/worktrees/x\n')
    expect(gitDirFast(dir)).toBe(join(dir, '..', 'elsewhere', '.git', 'worktrees', 'x'))
  })
})
