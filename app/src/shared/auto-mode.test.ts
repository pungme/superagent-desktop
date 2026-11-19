import { describe, expect, it } from 'vitest'
import {
  AUTO_DONE,
  AUTO_MAX_ROUNDS,
  AUTO_PROMPT,
  autoNext,
  endsWithQuestion,
  saidDone,
  type AutoState
} from './auto-mode'

const base: AutoState = {
  on: true,
  rounds: 0,
  lastReply: 'I fixed the header and the footer. Next I will check the mobile menu.',
  askedQuestion: false,
  needsYou: false,
  stopped: false,
  failed: false,
  queued: 0,
  typing: false,
  ready: true
}
const why = (over: Partial<AutoState>): string | true => {
  const d = autoNext({ ...base, ...over })
  return d.send ? true : d.why
}

describe('autoNext', () => {
  it('asks again after a normal turn', () => {
    expect(why({})).toBe(true)
  })
  it('does nothing when off', () => {
    expect(why({ on: false })).toBe('off')
  })
  it('stops when the agent says it is done, however it dresses it', () => {
    expect(why({ lastReply: AUTO_DONE })).toBe('done')
    expect(why({ lastReply: `**${AUTO_DONE}**.` })).toBe('done')
    expect(saidDone('Everything is AUTO_DONE for now')).toBe(false)
  })
  it('never talks over the person', () => {
    expect(why({ stopped: true })).toBe('stopped')
    expect(why({ typing: true })).toBe('typing')
    expect(why({ queued: 1 })).toBe('queued')
    expect(why({ needsYou: true })).toBe('needs-you')
    expect(why({ failed: true })).toBe('failed')
  })
  it('leaves a question for the person to answer', () => {
    expect(why({ lastReply: 'Should I open a pull request?' })).toBe('question')
    expect(why({ lastReply: 'Done. Want me to continue?\n' })).toBe('question')
    expect(why({ askedQuestion: true })).toBe('question')
    expect(endsWithQuestion('Is it `x`?')).toBe(true)
    expect(endsWithQuestion('What is next? I will check the menu.')).toBe(false)
  })
  it('waits for the person after too many rounds in a row', () => {
    expect(why({ rounds: AUTO_MAX_ROUNDS - 1 })).toBe(true)
    expect(why({ rounds: AUTO_MAX_ROUNDS })).toBe('limit')
  })
  it('waits for a busy agent and an empty reply', () => {
    expect(why({ ready: false })).toBe('busy')
    expect(why({ lastReply: '  ' })).toBe('empty')
  })
  it('asks for a decision rather than guessing, and names the sentinel', () => {
    expect(AUTO_PROMPT).toContain('ask me and stop')
    expect(AUTO_PROMPT).toContain(AUTO_DONE)
  })
})
