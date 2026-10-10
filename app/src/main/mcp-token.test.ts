import { describe, expect, it } from 'vitest'
import { chatToken, chatTokenValid } from './mcp-token'

describe('proof of which conversation is calling', () => {
  it('holds for the ids it was made for, and for no others', () => {
    const t = chatToken('ws1', 'chatA')
    expect(chatTokenValid(t, 'ws1', 'chatA')).toBe(true)
    // Another conversation's id written into the address: the token does not fit.
    expect(chatTokenValid(t, 'ws1', 'chatB')).toBe(false)
    expect(chatTokenValid(t, 'ws2', 'chatA')).toBe(false)
    expect(chatTokenValid(t, 'ws1')).toBe(false)
  })
  it('is not satisfied by nothing, a guess, or ids that only join up the same', () => {
    expect(chatTokenValid(null, 'ws1', 'chatA')).toBe(false)
    expect(chatTokenValid('', 'ws1', 'chatA')).toBe(false)
    expect(chatTokenValid('a'.repeat(32), 'ws1', 'chatA')).toBe(false)
    expect(chatTokenValid(chatToken('ws', '1chat'), 'ws1', 'chat')).toBe(false)
  })
  it('cannot be made without the key', () => {
    const other = Buffer.alloc(32, 7)
    expect(chatTokenValid(chatToken('ws1', 'chatA', other), 'ws1', 'chatA')).toBe(false)
  })
})
