import { describe, expect, it } from 'vitest'
import { popupDecision, popupSize } from './popup-login'

const req = (
  url: string,
  disposition: string,
  features = ''
): Parameters<typeof popupDecision>[0] => ({
  url,
  disposition,
  features
})

describe('popupDecision', () => {
  it('pops up what a page opens with a size: that is a sign-in popup', () => {
    expect(
      popupDecision(req('https://shop.example/auth', 'new-window', 'width=500,height=600'))
    ).toBe('popup')
    expect(popupDecision(req('https://accounts.google.com/o/oauth2/auth?x=1', 'new-window'))).toBe(
      'popup'
    )
  })
  it('pops up a plain window.open to a sign-in page of a known provider', () => {
    expect(
      popupDecision(req('https://accounts.google.com/o/oauth2/v2/auth', 'foreground-tab'))
    ).toBe('popup')
    expect(
      popupDecision(req('https://github.com/login/oauth/authorize?a=1', 'foreground-tab'))
    ).toBe('popup')
    expect(popupDecision(req('https://appleid.apple.com/auth/authorize', 'foreground-tab'))).toBe(
      'popup'
    )
  })
  it('lets about:blank open when it is a sized popup (Firebase, Auth0), and denies it otherwise', () => {
    expect(popupDecision(req('about:blank', 'new-window', 'width=480,height=520'))).toBe('popup')
    expect(popupDecision(req('', 'foreground-tab'))).toBe('deny')
  })
  it('keeps ordinary links in the pane', () => {
    expect(popupDecision(req('https://example.com/docs', 'foreground-tab'))).toBe('pane')
    expect(popupDecision(req('https://github.com/pungme/superagent', 'foreground-tab'))).toBe(
      'pane'
    )
    expect(popupDecision(req('https://example.com/x', 'background-tab', 'width=1'))).toBe('pane')
  })
  it('never opens anything that is not a web page', () => {
    expect(popupDecision(req('javascript:alert(1)', 'new-window'))).toBe('deny')
    expect(popupDecision(req('file:///etc/passwd', 'new-window'))).toBe('deny')
    expect(popupDecision(req('not a url', 'new-window'))).toBe('deny')
  })
})

describe('popupSize', () => {
  it('uses what was asked, within reason', () => {
    expect(popupSize('width=420,height=560,left=10')).toEqual({ width: 420, height: 560 })
    expect(popupSize('width=5000,height=10')).toEqual({ width: 900, height: 400 })
  })
  it('falls back to a usual sign-in size', () => {
    expect(popupSize()).toEqual({ width: 500, height: 640 })
    expect(popupSize('noopener')).toEqual({ width: 500, height: 640 })
  })
})
