import { describe, it, expect } from 'vitest'
import { isGoogleSignIn, isGoogleSignInRejected, signInRetryUrl } from './google-signin'

const REJECTED =
  'https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fads.google.com%2Fnav%2Fselectaccount&flowName=GlifWebSignIn'

describe("Google's sign-in refusal", () => {
  it('is recognised by its address, and nothing else is', () => {
    expect(isGoogleSignInRejected(REJECTED)).toBe(true)
    expect(isGoogleSignInRejected('https://accounts.google.com/signin/rejected')).toBe(true)
    expect(isGoogleSignInRejected('https://accounts.google.com/v3/signin/identifier')).toBe(false)
    expect(isGoogleSignInRejected('https://evil.test/v3/signin/rejected')).toBe(false)
    expect(isGoogleSignInRejected('not a url')).toBe(false)
  })

  it('retries the sign-in, going on to where it was headed', () => {
    expect(signInRetryUrl(REJECTED)).toBe(
      'https://accounts.google.com/ServiceLogin?continue=' +
        encodeURIComponent('https://ads.google.com/nav/selectaccount')
    )
    // Never on to a non-https address.
    expect(
      signInRetryUrl('https://accounts.google.com/v3/signin/rejected?continue=javascript:alert(1)')
    ).toBe('https://accounts.google.com/')
  })

  it('counts every page on accounts.google.com as still signing in', () => {
    expect(isGoogleSignIn('https://accounts.google.com/v3/signin/challenge/pwd')).toBe(true)
    expect(isGoogleSignIn('https://ads.google.com/aw/overview')).toBe(false)
  })
})
