import { describe, expect, it } from 'vitest'
import {
  branchLabel,
  cleanable,
  cleanUpQuestion,
  isHomeBranch,
  otherBranchesLabel
} from './other-branches'

describe('branches with no conversation', () => {
  it('are called by their branch, or by where they are when on none', () => {
    expect(branchLabel({ path: '/a', branch: 'feat/x' })).toBe('feat/x')
    expect(branchLabel({ path: '/a', branch: null, head: 'c37e2ea' })).toBe(
      'no branch · at c37e2ea'
    )
    expect(branchLabel({ path: '/a', branch: null })).toBe('no branch')
  })
  it('fold into one line', () => {
    expect(otherBranchesLabel(1)).toBe('1 other branch')
    expect(otherBranchesLabel(7)).toBe('7 other branches')
  })
  it('the main line is never one to delete', () => {
    expect(isHomeBranch('main')).toBe(true)
    expect(isHomeBranch('master')).toBe(true)
    expect(isHomeBranch('trunk', 'trunk')).toBe(true)
    expect(isHomeBranch('feat/x', 'trunk')).toBe(false)
    expect(isHomeBranch(null)).toBe(false)
  })
  it('only what would lose nothing may be cleaned up', () => {
    const b = { path: '/a', branch: 'feat/x', merged: true, dirty: false }
    expect(cleanable(b)).toBe(true)
    expect(cleanable({ ...b, merged: false })).toBe(false)
    expect(cleanable({ ...b, dirty: true })).toBe(false)
    expect(cleanable({ ...b, branch: 'main' })).toBe(false)
    // On no branch, merged and clean: a leftover checkout, safe to go.
    expect(cleanable({ ...b, branch: null })).toBe(true)
  })
  it('the question names every one', () => {
    const q = cleanUpQuestion(['feat/x', 'fix/y'])
    expect(q).toContain('these 2 branches')
    expect(q).toContain('  feat/x\n  fix/y')
    expect(cleanUpQuestion(['feat/x'])).toContain('this branch and its checkout?')
  })
})
