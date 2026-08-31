import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  nativeImage: {}
}))

import { branchSlug, branchSlugFromMessage } from './files'

// A branch is named from the first thing you say to a chat, and people say
// sentences. "can u fix this please and deploy" became a branch called exactly
// that, which is what these guard against.
describe('branchSlugFromMessage', () => {
  it('drops politeness and filler', () => {
    expect(branchSlugFromMessage('can u fix this please and deploy')).toBe('fix-deploy')
    expect(branchSlugFromMessage('hey could you please update the readme')).toBe('update-readme')
    expect(branchSlugFromMessage('I want to add a dark mode toggle')).toBe('add-dark-mode-toggle')
  })

  it('caps the length so a paragraph is not a branch name', () => {
    const long =
      'fix the broken checkout flow and also update the pricing page and the footer links'
    const out = branchSlugFromMessage(long)
    expect(out.split('-').length).toBeLessThanOrEqual(4)
    expect(out).toBe('fix-broken-checkout-flow')
  })

  it('keeps the one real word out of a polite sentence', () => {
    expect(branchSlugFromMessage('can you please help me')).toBe('help')
  })

  it('falls back to the raw words when everything is filler', () => {
    // Better a weak name than an empty one: an empty name means no branch, and
    // the chat would silently stay in the project folder.
    expect(branchSlugFromMessage('can you please')).toBe('can-you-please')
  })

  it('survives punctuation, emoji and casing', () => {
    expect(branchSlugFromMessage('Fix the login bug!!! 🙏')).toBe('fix-login-bug')
    expect(branchSlugFromMessage('  ')).toBe('')
  })

  it('leaves titles alone — they are already written as names', () => {
    // The rename path still uses branchSlug, so a good title stays intact.
    expect(branchSlug('Fix the flaky auth test')).toBe('fix-the-flaky-auth-test')
  })
})
