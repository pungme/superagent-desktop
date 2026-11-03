import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ BaseWindow: class {}, WebContentsView: class {} }))

import { barRequest } from './auth-window'

describe('what the address bar asks for', () => {
  it('goes where it is typed, https when no scheme is given', () => {
    expect(
      barRequest('superagent-bar://go?u=' + encodeURIComponent('claude.ai/settings') + '&n=1')
    ).toEqual({
      go: 'https://claude.ai/settings'
    })
    expect(
      barRequest('superagent-bar://go?u=' + encodeURIComponent('http://127.0.0.1:9/x'))
    ).toEqual({
      go: 'http://127.0.0.1:9/x'
    })
  })
  it('only to the web', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', ''])
      expect(barRequest('superagent-bar://go?u=' + encodeURIComponent(u))).toBeNull()
  })
  it('closes and goes back, and ignores any other title', () => {
    expect(barRequest('superagent-bar://close?n=2')).toEqual({ close: true })
    expect(barRequest('superagent-bar://back?n=3')).toEqual({ back: true })
    expect(barRequest('bar')).toBeNull()
    expect(barRequest('https://claude.ai')).toBeNull()
  })
})
