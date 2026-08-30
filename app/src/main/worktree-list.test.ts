import { describe, it, expect } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  nativeImage: {}
}))

import { vi } from 'vitest'
import { parseWorktreeList } from './files'

// Real `git worktree list --porcelain` output. The sidebar's whole branch list
// is built from this, so a parse slip shows up as branches that cannot be
// reached rather than as an error.
describe('parseWorktreeList', () => {
  it('reads the main worktree and marks it', () => {
    const out = parseWorktreeList('worktree /p/app\nHEAD abc123\nbranch refs/heads/main\n')
    expect(out).toEqual([{ path: '/p/app', branch: 'main', main: true }])
  })

  it('marks only the FIRST as main — it is the folder the user opened', () => {
    const out = parseWorktreeList(
      'worktree /p/app\nHEAD a1\nbranch refs/heads/main\n\n' +
        'worktree /p/app/.worktrees/wt-1\nHEAD b2\nbranch refs/heads/feature1\n\n' +
        'worktree /p/app/.worktrees/wt-2\nHEAD c3\nbranch refs/heads/feature2\n'
    )
    expect(out.map((w) => w.main)).toEqual([true, false, false])
    expect(out.map((w) => w.branch)).toEqual(['main', 'feature1', 'feature2'])
  })

  it('keeps a detached worktree, with no branch', () => {
    const out = parseWorktreeList(
      'worktree /p/app\nHEAD a1\nbranch refs/heads/main\n\n' +
        'worktree /p/app/.worktrees/wt-1\nHEAD b2\ndetached\n'
    )
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ path: '/p/app/.worktrees/wt-1', branch: null, main: false })
  })

  it('skips a bare repo — nobody can work in one', () => {
    const out = parseWorktreeList(
      'worktree /p/bare.git\nbare\n\n' +
        'worktree /p/app/.worktrees/wt-1\nHEAD b2\nbranch refs/heads/feature1\n'
    )
    // The bare stanza is dropped, so the real worktree becomes the first —
    // and is therefore treated as main. Nothing is silently unreachable.
    expect(out).toEqual([{ path: '/p/app/.worktrees/wt-1', branch: 'feature1', main: true }])
  })

  it('survives a branch name with slashes', () => {
    const out = parseWorktreeList(
      'worktree /p/app/.worktrees/wt-1\nHEAD b2\nbranch refs/heads/superagent/wt-mabc123\n'
    )
    expect(out[0].branch).toBe('superagent/wt-mabc123')
  })

  it('survives a path with spaces', () => {
    const out = parseWorktreeList(
      'worktree /Users/me/My Projects/app\nHEAD a1\nbranch refs/heads/main\n'
    )
    expect(out[0].path).toBe('/Users/me/My Projects/app')
  })

  it('returns nothing for empty output rather than throwing', () => {
    expect(parseWorktreeList('')).toEqual([])
    expect(parseWorktreeList('\n\n')).toEqual([])
  })

  it('tolerates trailing blank lines', () => {
    const out = parseWorktreeList('worktree /p/app\nHEAD a1\nbranch refs/heads/main\n\n\n')
    expect(out).toHaveLength(1)
  })
})
