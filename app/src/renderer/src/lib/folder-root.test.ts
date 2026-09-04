import { describe, it, expect } from 'vitest'
import { isFolderRoot } from './folder-root'
import type { Chat } from '../../../preload'

const chat = (over: Partial<Chat>): Chat =>
  ({ id: 'c1', title: null, cwd: null, pending: 0, ...over }) as Chat

describe('isFolderRoot', () => {
  it('is the root when it has no cwd and is not pending', () => {
    const solo = chat({ id: 'a', pending: 0 })
    expect(isFolderRoot([solo], solo)).toBe(true)
  })

  it('is not the root once a cwd (branch) has been cut for it', () => {
    const branched = chat({ id: 'a', cwd: '/some/worktree' })
    expect(isFolderRoot([branched], branched)).toBe(false)
  })

  it("a pending chat is still the root when it is the workspace's only chat", () => {
    // The bug: a brand-new git-repo project auto-creates one chat via newChat,
    // which marks it pendingBranch since nothing has been sent yet. With only
    // that one chat in the workspace, it IS the folder's chat, not an "extra"
    // waiting on a branch — there is nothing else here to be an extra of.
    const solo = chat({ id: 'a', pending: 1 })
    expect(isFolderRoot([solo], solo)).toBe(true)
  })

  it('a pending chat is NOT the root once a sibling already claims the folder', () => {
    const root = chat({ id: 'a', pending: 0 })
    const extra = chat({ id: 'b', pending: 1 })
    expect(isFolderRoot([root, extra], extra)).toBe(false)
  })

  it('a pending chat is NOT the root when another pending chat also has no home', () => {
    const first = chat({ id: 'a', pending: 1 })
    const second = chat({ id: 'b', pending: 1 })
    // Neither is alone, so neither gets the "only chat" exception.
    expect(isFolderRoot([first, second], first)).toBe(false)
    expect(isFolderRoot([first, second], second)).toBe(false)
  })
})
