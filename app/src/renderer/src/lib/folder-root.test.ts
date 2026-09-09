import { describe, it, expect, beforeEach } from 'vitest'
import { isFolderRoot } from './folder-root'
import type { Chat } from '../../../preload'

const chat = (over: Partial<Chat>): Chat =>
  ({ id: 'c1', title: null, cwd: null, pending: 0, ...over }) as Chat

describe('isFolderRoot', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the only pending chat on a newly added project row', () => {
    const solo = chat({ id: 'a', pending: 1 })
    expect(isFolderRoot([solo], solo)).toBe(true)
  })

  it('puts a pending chat below the project when a root chat already exists', () => {
    const root = chat({ id: 'a' })
    const extra = chat({ id: 'b', pending: 1 })
    expect(isFolderRoot([root, extra], root)).toBe(true)
    expect(isFolderRoot([root, extra], extra)).toBe(false)
  })

  it('never treats a chat with its own worktree as the project root', () => {
    const branched = chat({ id: 'a', cwd: '/tmp/worktree' })
    expect(isFolderRoot([branched], branched)).toBe(false)
  })

  it('uses the local pending flag before the refreshed chat list arrives', () => {
    const extra = chat({ id: 'b' })
    localStorage.setItem('pendingBranch:b', '1')
    expect(isFolderRoot([chat({ id: 'a' }), extra], extra)).toBe(false)
  })
})
