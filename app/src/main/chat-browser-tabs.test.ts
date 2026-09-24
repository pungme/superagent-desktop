import { describe, it, expect, vi, beforeEach } from 'vitest'

// The registry learns tabs through this IPC listener; capture it to drive it.
const handlers: Record<string, (...args: unknown[]) => void> = {}
vi.mock('electron', () => ({
  ipcMain: { on: (ch: string, fn: (...args: unknown[]) => void) => (handlers[ch] = fn) }
}))

import {
  registerChatBrowserTabsIpc,
  agentChatTab,
  setAgentChatTab,
  activeChatTab
} from './chat-browser-tabs'

const report = (base: string, tabs: { id: string; active: boolean }[]): void =>
  handlers['browser:tabs-report'](
    {},
    base,
    tabs.map((t) => ({ ...t, url: '', title: '' }))
  )

let n = 0
let base = ''
beforeEach(() => {
  registerChatBrowserTabsIpc()
  base = `ws::chat${n++}`
})

describe('agentChatTab', () => {
  it('keeps working in its own tab when the user opens a new one', () => {
    report(base, [{ id: base, active: true }])
    expect(agentChatTab(base)).toBe(base)
    // The user opens a tab of their own; it comes to the front.
    report(base, [
      { id: base, active: false },
      { id: `${base}::t1`, active: true }
    ])
    expect(activeChatTab(base)).toBe(`${base}::t1`)
    expect(agentChatTab(base)).toBe(base)
  })

  it('moves only when the agent switches or opens a tab itself', () => {
    report(base, [
      { id: base, active: true },
      { id: `${base}::t1`, active: false }
    ])
    expect(agentChatTab(base)).toBe(base)
    setAgentChatTab(base, `${base}::t1`)
    expect(agentChatTab(base)).toBe(`${base}::t1`)
  })

  it('falls back to the tab in front once its own tab is closed', () => {
    report(base, [
      { id: base, active: false },
      { id: `${base}::t1`, active: true }
    ])
    setAgentChatTab(base, `${base}::t2`) // a tab that does not exist (closed)
    expect(agentChatTab(base)).toBe(`${base}::t1`)
  })

  it('is the base pane before any tab has reported', () => {
    expect(agentChatTab(base)).toBe(base)
  })
})
