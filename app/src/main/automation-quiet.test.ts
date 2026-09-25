import { describe, it, expect, vi, beforeEach } from 'vitest'

// A fake pane: enough of a WebContents for navigate and screenshot.
const pane = {
  debugger: {
    attach: vi.fn(),
    on: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async (method: string) =>
      method === 'Page.captureScreenshot' ? { data: 'png' } : {}
    )
  },
  once: vi.fn(),
  executeJavaScript: vi.fn(async () => undefined),
  loadURL: vi.fn(async () => undefined),
  getURL: () => 'https://example.com/'
}
const sent: string[] = []
vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }))
vi.mock('./browser', () => ({
  getPaneWebContents: () => pane,
  paneLog: vi.fn(),
  withoutStealingFocus: <T>(fn: () => T) => fn(),
  markAgentLoad: vi.fn()
}))
vi.mock('./util', () => ({
  broadcastToWindows: (channel: string) => sent.push(channel),
  pushBounded: vi.fn(),
  normalizeUrl: (u: string) => u
}))
vi.mock('./external-browser', () => ({
  externalBrowserForPane: () => null,
  externalPage: vi.fn()
}))

import { screenshot, navigate } from './automation'

beforeEach(() => {
  sent.length = 0
})

describe('the phone watching the browser', () => {
  it('pulls a frame without telling the Mac the agent is browsing', async () => {
    await screenshot('ws::chat', { quiet: true })
    expect(sent).not.toContain('browser:activity')
  })

  it('opens a page without popping the browser open on the Mac', async () => {
    await navigate('ws::chat', 'https://example.com', { quiet: true })
    expect(sent).not.toContain('browser:request-open')
    expect(sent).not.toContain('browser:activity')
  })

  it('still shows the agent’s own browsing on the Mac', async () => {
    await screenshot('ws::chat')
    expect(sent).toContain('browser:activity')
    sent.length = 0
    await navigate('ws::chat', 'https://example.com')
    expect(sent).toContain('browser:request-open')
  })
})
