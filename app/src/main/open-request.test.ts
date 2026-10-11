import { describe, expect, it, vi } from 'vitest'

const sent: unknown[] = []
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }))
vi.mock('./util', () => ({
  broadcastToWindows: (_ch: string, p: unknown) => {
    sent.push(p)
  }
}))

const { askToOpen, takePendingOpen, OPEN_KEEP_MS } = await import('./open-request')

describe('a request to show a conversation', () => {
  it('is told to the windows there are, and kept once for one still starting', () => {
    askToOpen('w1', 'c1', 1000)
    expect(sent).toEqual([{ workspaceId: 'w1', chatId: 'c1' }])
    expect(takePendingOpen(1500)).toEqual({ workspaceId: 'w1', chatId: 'c1' })
    // Collected: a second window, or a reload, does not go there again.
    expect(takePendingOpen(1600)).toBeNull()
  })

  it('is not acted on long after it was made, and the latest one wins', () => {
    askToOpen('w1', 'c1', 1000)
    expect(takePendingOpen(1000 + OPEN_KEEP_MS)).toBeNull()
    askToOpen('w1', 'c1', 1000)
    askToOpen('w2', '', 2000)
    expect(takePendingOpen(2500)).toEqual({ workspaceId: 'w2', chatId: '' })
  })
})
