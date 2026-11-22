import { describe, it, expect } from 'vitest'
import { parsePromptLink, promptLink, MAX_PROMPT } from './prompt-link'

describe('prompt links', () => {
  it('round-trips a prompt and its project', () => {
    const link = promptLink('Fix the header on phones\nand check it at 320pt', 'landing-page')
    expect(link.startsWith('superagent://prompt?')).toBe(true)
    expect(parsePromptLink(link)).toEqual({
      text: 'Fix the header on phones\nand check it at 320pt',
      project: 'landing-page'
    })
  })

  it('takes a repository as the project, and works without one', () => {
    expect(parsePromptLink('superagent://prompt?text=hi&repo=pungme/superagent-desktop')).toEqual({
      text: 'hi',
      project: 'pungme/superagent-desktop'
    })
    expect(parsePromptLink('superagent:prompt?text=hi')).toEqual({ text: 'hi' })
  })

  it('refuses what is not a prompt, and cleans and caps what is', () => {
    expect(parsePromptLink('superagent://prompt?text=%20%20')).toBeNull()
    expect(parsePromptLink('superagent://settings?text=hi')).toBeNull()
    expect(parsePromptLink('https://prompt?text=hi')).toBeNull()
    expect(parsePromptLink('not a url')).toBeNull()
    expect(parsePromptLink('superagent://prompt?text=a%E2%80%AEb%00c')?.text).toBe('abc')
    const long = parsePromptLink(promptLink('x'.repeat(MAX_PROMPT + 50)))
    expect(long?.text.length).toBe(MAX_PROMPT)
  })
})
