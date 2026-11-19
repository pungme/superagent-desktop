import { describe, expect, it } from 'vitest'
import { antigravityWho, codexWho } from './login-who'

const jwt = (claims: object): string =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

describe('codexWho', () => {
  it('names the ChatGPT account and its plan', () => {
    const auth = {
      tokens: {
        id_token: jwt({
          email: 'pung@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
        })
      }
    }
    expect(codexWho(JSON.stringify(auth))).toBe('pung@example.com · Plus plan')
  })
  it('says API key for a key login, and nothing for junk', () => {
    expect(codexWho(JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }))).toBe('API key')
    expect(codexWho('not json')).toBe('')
    expect(codexWho(JSON.stringify({ tokens: { id_token: 'nope' } }))).toBe('')
  })
})

describe('antigravityWho', () => {
  it('takes the last account the log signed in with', () => {
    const log = [
      'I1119 11:08:21 server_oauth.go:221] applyAuthResult: email=old@example.com, authMethod=consumer',
      'I1119 11:09:00 other line',
      'I1119 11:10:21 server_oauth.go:221] applyAuthResult: email=pung@example.com, authMethod=consumer, quotaProject='
    ].join('\n')
    expect(antigravityWho(log)).toBe('pung@example.com')
    expect(antigravityWho('nothing here')).toBe('')
  })
})
