import { describe as suite, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: () => undefined },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }
}))

import { describe } from './ctx-menu'

suite('ctx-menu description', () => {
  it('keeps labels, drops handlers, and numbers the clickable items', () => {
    const handlers = new Map()
    const a = vi.fn()
    const out = describe(
      [
        { label: 'Reveal in Finder', click: a },
        { type: 'separator' },
        { label: 'Delete chat', click: vi.fn() },
        { label: 'Move to', enabled: false, submenu: [{ label: 'Work', click: vi.fn() }] }
      ],
      handlers
    )
    expect(out.map((i) => i.label)).toEqual([
      'Reveal in Finder',
      undefined,
      'Delete chat',
      'Move to'
    ])
    expect(out[0].id).toBe(1)
    expect(handlers.get(1)).toBe(a)
    expect(out[2].danger).toBe(true)
    expect(out[3].enabled).toBe(false)
    expect(out[3].submenu?.[0].id).toBe(3)
    expect(JSON.stringify(out)).not.toContain('click')
  })
  it('collapses doubled and trailing separators', () => {
    const out = describe(
      [
        { type: 'separator' },
        { label: 'A' },
        { type: 'separator' },
        { type: 'separator' },
        { label: 'B' },
        { type: 'separator' }
      ],
      new Map()
    )
    expect(out.map((i) => i.type ?? i.label)).toEqual(['A', 'separator', 'B'])
  })
})
