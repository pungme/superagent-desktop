import { describe, expect, it } from 'vitest'
import { rankChats, searchWords } from './find-chat'

const chat = (
  id: string,
  title: string,
  projectName: string,
  updatedAt: number,
  saidWords: string[] = []
): {
  id: string
  title: string
  projectId: string
  projectName: string
  updatedAt: number
  saidWords: string[]
} => ({ id, title, projectId: projectName, projectName, updatedAt, saidWords })

const chats = [
  chat('a', 'E2E testing for checkout', 'wepush', 10),
  chat('b', 'Fix the header', 'wepush', 50),
  chat('c', 'E2E tests are flaky', 'superagent', 40),
  chat('d', 'Pricing page copy', 'wepush-portal', 30, ['e2e', 'testing']),
  chat('e', 'New chat', 'shot caller', 20)
]

describe('the words that tell one chat from another', () => {
  it('drops what a request is wrapped in', () => {
    expect(searchWords('hey go to this project about e2e testing wepush')).toEqual([
      'e2e',
      'testing',
      'wepush'
    ])
    expect(searchWords('open the chat')).toEqual([])
  })
})

describe('which conversation someone means', () => {
  it('finds the chat by its topic and its project together', () => {
    expect(rankChats(chats, 'go to this project about e2e testing wepush')[0].id).toBe('a')
  })
  it('keeps to the project that was named, even when another has a better title', () => {
    const ids = rankChats(chats, 'the superagent chat about e2e').map((c) => c.id)
    expect(ids).toEqual(['c'])
  })
  it('counts what was said in a chat, below what it is called', () => {
    const ids = rankChats(chats, 'e2e testing').map((c) => c.id)
    expect(ids[0]).toBe('a')
    expect(ids).toContain('d')
    expect(ids).not.toContain('b')
  })
  it('with only a project named, offers its chats, most recent first', () => {
    expect(rankChats(chats, 'shot caller').map((c) => c.id)).toEqual(['e'])
    expect(rankChats(chats, 'wepush').map((c) => c.id)).toEqual(['b', 'd', 'a'])
  })
  it('finds nothing for words no chat has, or for no words at all', () => {
    expect(rankChats(chats, 'kubernetes migration')).toEqual([])
    expect(rankChats(chats, 'open the chat please')).toEqual([])
  })
})
