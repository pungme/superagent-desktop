import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  chats: new Map<string, Record<string, unknown>>(),
  items: new Map<string, unknown[]>(),
  pending: new Set<string>(),
  copied: [] as string[],
  seq: 0
}))

vi.mock('./store', () => ({
  DESKTOP_WORKSPACE_ID: '__desktop_chat__',
  getChat: (id: string) => h.chats.get(id),
  createChat: (workspaceId: string) => {
    const id = `new-${++h.seq}`
    h.chats.set(id, { id, workspaceId, title: null, provider: 'claude', pinned: 0, pinnedAt: null })
    return id
  },
  markPendingBranch: (id: string) => h.pending.add(id),
  setChatProvider: (id: string, p: string) => (h.chats.get(id)!.provider = p),
  getChatModel: (id: string) => (h.chats.get(id)?.model as string | null) ?? null,
  setChatModel: (id: string, m: string) => (h.chats.get(id)!.model = m),
  setChatTitle: (id: string, t: string) => (h.chats.get(id)!.title = t),
  loadChatItems: (id: string) => h.items.get(id) ?? [],
  appendChatItems: async (id: string, items: unknown[]) => {
    h.items.set(id, [...(h.items.get(id) ?? []), ...items])
  },
  setChatPinnedAfter: (id: string, after: string) => {
    const c = h.chats.get(id)!
    c.pinned = 1
    c.pinnedAt = ((h.chats.get(after)!.pinnedAt as number) ?? 0) - 1
  }
}))
vi.mock('./agent', () => ({ markContextCopied: (id: string) => h.copied.push(id) }))
vi.mock('./transcripts', () => ({ flushAllTranscripts: async () => [] }))

import { duplicateChat } from './chat-duplicate'

beforeEach(() => {
  h.chats.clear()
  h.items.clear()
  h.pending.clear()
  h.copied.length = 0
  h.seq = 0
})

const msg = (text: string): unknown => ({ kind: 'msg', msg: { id: text, role: 'user', text } })

describe('duplicateChat', () => {
  it('copies the transcript, agent and model, marks it as a copy, and cuts its own branch later', async () => {
    h.chats.set('a', {
      id: 'a',
      workspaceId: 'w1',
      title: 'Hero copy',
      provider: 'codex',
      model: 'gpt-5'
    })
    h.items.set('a', [msg('one'), msg('two')])
    const copy = await duplicateChat('a')
    expect(copy).toEqual({ workspaceId: 'w1', chatId: 'new-1' })
    const c = h.chats.get('new-1')!
    expect(c).toMatchObject({
      title: 'Hero copy (copy)',
      provider: 'codex',
      model: 'gpt-5',
      pinned: 0
    })
    expect(h.items.get('new-1')).toEqual([msg('one'), msg('two')])
    expect(h.items.get('a')).toHaveLength(2) // the original is untouched
    expect(h.copied).toEqual(['new-1'])
    expect(h.pending.has('new-1')).toBe(true)
  })

  it('is pinned, right below the original, when the original is', async () => {
    h.chats.set('a', {
      id: 'a',
      workspaceId: 'w1',
      title: null,
      provider: 'claude',
      pinned: 1,
      pinnedAt: 1000
    })
    await duplicateChat('a')
    expect(h.chats.get('new-1')).toMatchObject({ pinned: 1, pinnedAt: 999 })
  })

  it('an empty chat gives an empty chat, and a Chats conversation does not cut a branch', async () => {
    h.chats.set('d', { id: 'd', workspaceId: '__desktop_chat__', title: null, provider: 'claude' })
    await duplicateChat('d')
    expect(h.items.has('new-1')).toBe(false)
    expect(h.copied).toEqual([])
    expect(h.pending.size).toBe(0)
  })

  it('says nothing for a chat that is not there', async () => {
    expect(await duplicateChat('missing')).toBeNull()
  })
})
