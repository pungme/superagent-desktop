import { describe, expect, it } from 'vitest'
import { remoteUserMessage } from './remote-user'

describe('remoteUserMessage', () => {
  it('carries the recorded id and image count needed by the live thumbnail renderer', () => {
    expect(remoteUserMessage('S-share-1', 'check the padding', 2)).toEqual({
      id: 'S-share-1',
      text: 'check the padding',
      from: 'ios',
      imageCount: 2
    })
  })
})
