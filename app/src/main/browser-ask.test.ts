import { beforeEach, describe, expect, it } from 'vitest'
import {
  ASK_TIMEOUT_MS,
  STAY_MS,
  askOnce,
  decideBrowserUse,
  forgetStay,
  lastUserMessage,
  noteUserMessage,
  rememberStay,
  resetBrowserAsk,
  stayText,
  stayUntil,
  stayedText,
  switchedText,
  userAskedForTheirBrowser,
  whyLine
} from './browser-ask'
import { SIGN_IN_REFUSED_MESSAGE } from './google-signin'

beforeEach(() => resetBrowserAsk())

describe("whether browser_use('yours') asks first", () => {
  const base = { current: 'builtin', lastUserText: undefined, stayUntil: undefined, now: 1_000 }

  it('asks when nothing chose the user’s browser', () => {
    expect(decideBrowserUse(base)).toBe('ask')
    expect(decideBrowserUse({ ...base, lastUserText: 'check the order page' })).toBe('ask')
  })

  it('does not ask when the conversation is on their browser already (the pill, or a yes)', () => {
    expect(decideBrowserUse({ ...base, current: 'brave' })).toBe('already')
    // Even with a "Stay here" still running: the pill is the user's own choice.
    expect(decideBrowserUse({ ...base, current: 'chrome', stayUntil: 5_000 })).toBe('already')
  })

  it('does not ask when the user’s own last message asked for their browser', () => {
    expect(decideBrowserUse({ ...base, lastUserText: 'do it in Brave please' })).toBe('asked')
    // Asking outright beats an earlier "Stay here".
    expect(decideBrowserUse({ ...base, lastUserText: 'use my browser', stayUntil: 5_000 })).toBe(
      'asked'
    )
  })

  it('remembers "Stay here" for a while, then asks again', () => {
    expect(decideBrowserUse({ ...base, stayUntil: 1_000 + STAY_MS })).toBe('stayed')
    expect(decideBrowserUse({ ...base, stayUntil: 1_000 + STAY_MS, now: 1_000 + STAY_MS })).toBe(
      'ask'
    )
  })

  it('remembers per conversation, and forgets on a yes', () => {
    rememberStay('ws::a', 1_000)
    expect(stayUntil('ws::a')).toBe(1_000 + STAY_MS)
    expect(stayUntil('ws::b')).toBeUndefined()
    forgetStay('ws::a')
    expect(stayUntil('ws::a')).toBeUndefined()
  })

  it('keeps the last thing the user said in each chat', () => {
    noteUserMessage('c1', 'use Brave')
    noteUserMessage('c2', 'hello')
    noteUserMessage('c1', 'thanks')
    noteUserMessage(undefined, 'nobody')
    expect(lastUserMessage('c1')).toBe('thanks')
    expect(lastUserMessage('c2')).toBe('hello')
    expect(lastUserMessage(null)).toBeUndefined()
  })

  it('times out to "Stay here" well before the agent would give up', () => {
    expect(ASK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    expect(ASK_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60_000)
  })
})

describe('the user asking for their browser', () => {
  it.each([
    'use Brave',
    'open it in Chrome',
    'can you do this in my browser?',
    'log in with my real browser',
    'try Microsoft Edge',
    'open it in edge',
    'use my own browser for this'
  ])('counts "%s"', (t) => expect(userAskedForTheirBrowser(t)).toBe(true))

  it.each([
    'check the order page',
    'handle the edge case where the cart is empty',
    'it breaks in edge cases',
    "don't use Brave",
    'not in my browser please',
    'stay in Superagent, without Chrome',
    'do it here instead of my browser',
    'use your browser'
  ])('does not count "%s"', (t) => expect(userAskedForTheirBrowser(t)).toBe(false))
})

describe('one card per conversation', () => {
  it('a second call while the first waits gets the same answer', async () => {
    let answer: (v: boolean) => void = () => undefined
    let asked = 0
    const ask = (): Promise<boolean> => {
      asked++
      return new Promise((r) => (answer = r))
    }
    const a = askOnce('ws::c', ask)
    const b = askOnce('ws::c', ask)
    answer(true)
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(asked).toBe(1)
    // Settled: the next call asks again.
    const c = askOnce('ws::c', ask)
    answer(false)
    expect(await c).toBe(false)
    expect(asked).toBe(2)
  })
})

describe('the words', () => {
  it("finishes the card's sentence with the agent's reason, one line, one full stop", () => {
    expect(whyLine(undefined)).toBe('this site needs your own logins.')
    expect(whyLine('   ')).toBe('this site needs your own logins.')
    expect(whyLine('Google won’t sign you in here.')).toBe('Google won’t sign you in here.')
    expect(whyLine('the shop\nneeds   your account!!')).toBe('the shop needs your account.')
    const long = whyLine('word '.repeat(60))
    expect(long.length).toBeLessThanOrEqual(121)
    expect(long.endsWith('…')).toBe(true)
  })

  it('a yes says it switched and opens on the next navigate', () => {
    const t = switchedText('Brave')
    expect(t).toContain('now drive Brave')
    expect(t).toContain('opens on your next browser_navigate')
  })

  it('a no says stay, sign in with browser_ask_user, and do not ask again for a while', () => {
    const t = stayText('Brave')
    expect(t).toContain('stay in Superagent')
    expect(t).toContain('browser_ask_user')
    expect(t).toContain(`for the next ${STAY_MS / 60_000} minutes`)
    expect(t).toContain('unless the user asks for their browser')
  })

  it('a remembered no says it was not asked again, and when it may ask', () => {
    const t = stayedText('Chrome', 12 * 60_000)
    expect(t).toMatch(/^Not asked again/)
    expect(t).toContain('about 12 minutes')
    expect(t).toContain('browser_ask_user')
  })

  it('Google’s refusal no longer tells the agent to switch on its own', () => {
    expect(SIGN_IN_REFUSED_MESSAGE).toContain("browser_use('yours')")
    expect(SIGN_IN_REFUSED_MESSAGE).toContain('asks the user first')
    expect(SIGN_IN_REFUSED_MESSAGE).not.toMatch(/without asking/i)
  })
})
