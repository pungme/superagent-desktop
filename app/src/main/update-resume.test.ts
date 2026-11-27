import { describe, it, expect, vi, beforeEach } from 'vitest'

const kv = new Map<string, string>()
vi.mock('./store', () => ({
  kvGet: (k: string) => kv.get(k),
  kvSet: (k: string, v: string) => void kv.set(k, v),
  kvDel: (k: string) => void kv.delete(k)
}))

import {
  recordInterrupted,
  takeInterrupted,
  resumeInterrupted,
  setBusyChatsProbe,
  RESUME_TEXT
} from './update-resume'

describe('resuming chats after an update', () => {
  beforeEach(() => {
    kv.clear()
    setBusyChatsProbe(() => ['a', 'b'])
  })
  it('writes down the working chats and hands them back once', () => {
    recordInterrupted(1000)
    expect(takeInterrupted(2000)).toEqual(['a', 'b'])
    expect(takeInterrupted(2000)).toEqual([])
  })
  it('writes nothing when no chat was working', () => {
    setBusyChatsProbe(() => [])
    recordInterrupted()
    expect(takeInterrupted()).toEqual([])
  })
  it('does not wake chats after a long gap', () => {
    recordInterrupted(0)
    expect(takeInterrupted(31 * 60_000)).toEqual([])
  })
  it('sends the carry-on message to chats that still exist', async () => {
    recordInterrupted()
    const send = vi.fn().mockResolvedValue(undefined)
    const done = await resumeInterrupted(send, (id) => id === 'a')
    expect(done).toEqual(['a'])
    expect(send).toHaveBeenCalledWith('a', RESUME_TEXT)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('survives a chat that cannot be sent to', async () => {
    recordInterrupted()
    const send = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined)
    expect(await resumeInterrupted(send, () => true)).toEqual(['b'])
  })
})
