import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  drafts: new Map<string, string>(),
  chats: new Set<string>(['c1', 'c2']),
  on: new Map<string, (...a: unknown[]) => unknown>(),
  windows: [] as { webContents: { sent: unknown[][]; send: (...a: unknown[]) => void } }[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.on.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => h.on.set(ch, fn)
  },
  BrowserWindow: { getAllWindows: () => h.windows }
}))
vi.mock('./store', () => ({
  chatDraft: (id: string) => h.drafts.get(id) ?? '',
  setChatDraft: (id: string, text: string) => {
    if (!text) return (h.drafts.delete(id), true)
    if (!h.chats.has(id)) return false
    h.drafts.set(id, text)
    return true
  }
}))

import { draftBus, draftOf, saveDraft, registerDrafts } from './drafts'

function fakeWindow(): (typeof h.windows)[number] {
  const sent: unknown[][] = []
  const webContents = { sent, send: (...a: unknown[]) => sent.push(a), isDestroyed: () => false }
  const win = { webContents }
  h.windows.push(win)
  return win
}

describe('drafts', () => {
  beforeEach(() => {
    h.drafts.clear()
    h.windows.length = 0
    draftBus.removeAllListeners()
    registerDrafts()
  })

  it('keeps what was typed and gives it back', () => {
    expect(draftOf('c1')).toBe('')
    expect(saveDraft('c1', 'half a sent', null)).toBe(true)
    expect(draftOf('c1')).toBe('half a sent')
    expect(draftOf('c2')).toBe('')
  })

  it('treats only-whitespace as an empty composer', () => {
    saveDraft('c1', 'something', null)
    expect(saveDraft('c1', '  \n ', null)).toBe(true)
    expect(draftOf('c1')).toBe('')
    expect(h.drafts.has('c1')).toBe(false)
  })

  it('says nothing when nothing changed, or the chat is gone', () => {
    const seen: string[] = []
    draftBus.on('changed', (d: { text: string }) => seen.push(d.text))
    saveDraft('c1', 'one', null)
    expect(saveDraft('c1', 'one', null)).toBe(false)
    expect(saveDraft('deleted-chat', 'words', null)).toBe(false)
    expect(seen).toEqual(['one'])
  })

  it('tells every window but the one that typed it', () => {
    const typing = fakeWindow()
    const other = fakeWindow()
    h.on.get('draft:set')!({ sender: typing.webContents }, 'c1', 'from this window')
    expect(typing.webContents.sent).toEqual([])
    expect(other.webContents.sent).toEqual([
      ['draft:changed', { chatId: 'c1', text: 'from this window' }]
    ])
    expect(h.on.get('draft:get')!({}, 'c1')).toBe('from this window')
  })

  it('tells every window when a phone wrote it', () => {
    const win = fakeWindow()
    saveDraft('c1', 'typed on the phone', { phone: true })
    expect(win.webContents.sent).toEqual([
      ['draft:changed', { chatId: 'c1', text: 'typed on the phone' }]
    ])
  })
})
