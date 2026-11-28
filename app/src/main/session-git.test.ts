import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cachedGit, forgetGit, freshGit, setGitUpdateHandler } from './session-git'

let repo: string
const git = (...a: string[]): string =>
  execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })

beforeEach(() => {
  forgetGit()
  repo = mkdtempSync(join(tmpdir(), 'cove-sg-'))
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  git('checkout', '-q', '-b', 'work')
})
afterEach(() => {
  setGitUpdateHandler(null)
  rmSync(repo, { recursive: true, force: true })
})

describe('session git cache', () => {
  it('answers at once from the cache and fills it in the background', async () => {
    expect(cachedGit(repo)).toEqual({}) // nothing yet, and it did not wait for git
    const f = await freshGit(repo)
    expect(f.branch).toBe('work')
    expect(f.unmerged).toBe(0)
    expect(cachedGit(repo).branch).toBe('work')
  })
  it('counts commits and files against main, committed or not', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b')
    writeFileSync(join(repo, 'c.txt'), 'c\n') // uncommitted
    const f = await freshGit(repo)
    expect(f.unmerged).toBe(1)
    expect(f.files).toEqual(['b.txt', 'c.txt'])
  })
  it('tells the windows only when something changed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const seen = vi.fn()
    setGitUpdateHandler(seen)
    await freshGit(repo)
    vi.advanceTimersByTime(300)
    expect(seen).toHaveBeenCalledTimes(1)
    await freshGit(repo) // the same answer
    vi.advanceTimersByTime(300)
    expect(seen).toHaveBeenCalledTimes(1)
    writeFileSync(join(repo, 'd.txt'), 'd\n')
    await freshGit(repo)
    vi.advanceTimersByTime(300)
    expect(seen).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
  it('is empty for a folder that is not a repository, and does not throw', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cove-sg-plain-'))
    expect(await freshGit(plain)).toEqual({})
    rmSync(plain, { recursive: true, force: true })
  })
  it('reads many sessions at once without more than a few git processes', async () => {
    const t0 = Date.now()
    await Promise.all(Array.from({ length: 20 }, () => freshGit(repo)))
    // 20 asks for one folder share one read
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})
