import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const state = vi.hoisted(() => ({
  enabled: true,
  missing: null as string | null,
  consent: false,
  answer: true,
  asked: [] as string[],
  acted: [] as unknown[],
  shots: 0,
  hooks: true,
  risk: null as string | null,
  ui: { app: 'TextEdit', window: 'Untitled', lines: ['button "Save" at 100,40'] },
  toAsk: [] as { id: string; name: string }[],
  approvedApps: [] as string[]
}))
vi.mock('./computer-use', () => ({
  computerUseEnabled: () => state.enabled,
  notReady: () => state.missing,
  hasConsent: () => state.consent,
  grantConsent: () => {
    state.consent = true
  },
  act: async (_owner: string, action: unknown) => {
    state.acted.push(action)
  },
  settle: async () => undefined,
  touchConsent: () => undefined,
  readUi: async () => state.ui,
  riskAt: async () => state.risk,
  takeZoom: async () => ({ jpeg: Buffer.from('zoomed'), width: 800, height: 400 }),
  appsShowing: async () => ({ front: 'TextEdit', apps: ['TextEdit', 'Safari'] }),
  appsToAsk: async () => state.toAsk.filter((a) => !state.approvedApps.includes(a.id)),
  approveApp: (_owner: string, id: string) => {
    state.approvedApps.push(id)
  },
  takeScreenshot: async () => {
    state.shots++
    return {
      shot: { width: 1440, height: 900, area: { x: 0, y: 0, width: 1440, height: 900 } },
      jpeg: Buffer.from('jpeg-bytes'),
      displays: [
        { index: 0, width: 1440, height: 900, current: true },
        { index: 1, width: 2560, height: 1440, current: false }
      ]
    }
  }
}))
vi.mock('./hooks', () => ({
  hooksIntact: () => state.hooks,
  requestApproval: vi.fn(async (_ws: string, _s: string, _tool: string, preview: string) => {
    state.asked.push(preview)
    return state.answer
  })
}))

const { registerComputerTools } = await import('./computer-tools')

type ToolResult = { isError?: boolean; content: { type: string; text?: string; data?: string }[] }

async function withClient(check: (c: Client) => Promise<void>): Promise<void> {
  const server = new McpServer({ name: 'computer-test', version: '1' })
  registerComputerTools(server, { workspaceId: 'w1', sessionId: 'c1' })
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  try {
    await check(client)
  } finally {
    await client.close()
    await server.close()
  }
}
const call = (c: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  c.callTool({ name, arguments: args }) as Promise<ToolResult>
const text = (r: ToolResult): string => r.content.map((p) => p.text ?? '').join(' ')

beforeEach(() => {
  Object.assign(state, {
    enabled: true,
    missing: null,
    consent: false,
    answer: true,
    asked: [],
    acted: [],
    shots: 0,
    hooks: true,
    risk: null,
    ui: { app: 'TextEdit', window: 'Untitled', lines: ['button "Save" at 100,40'] },
    toAsk: [],
    approvedApps: []
  })
})

describe("the agent's tools for using the Mac", () => {
  it('do not exist while computer use is turned off', async () => {
    state.enabled = false
    await withClient(async (c) => {
      expect(c.getServerCapabilities()?.tools).toBeUndefined()
    })
  })

  it('share no name with the tools the Computer chat already has', async () => {
    // Both sets are registered on one server in the Computer chat, and a name
    // used twice stops it starting: that chat would have no tools at all.
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const mcp = readFileSync(join(__dirname, 'mcp.ts'), 'utf8')
    const theirs = [...mcp.matchAll(/registerTool\(\s*'(computer_\w+)'/g)].map((m) => m[1])
    expect(theirs.length).toBeGreaterThan(3)
    const { COMPUTER_TOOL_NAMES } = await import('./computer-tools')
    expect(COMPUTER_TOOL_NAMES.filter((n) => theirs.includes(n))).toEqual([])
    await withClient(async (c) => {
      expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(
        [...COMPUTER_TOOL_NAMES].sort()
      )
    })
  })

  it('are there when it is on', async () => {
    const { COMPUTER_TOOL_NAMES } = await import('./computer-tools')
    await withClient(async (c) => {
      const names = (await c.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual([...COMPUTER_TOOL_NAMES].sort())
      // The ones that look, and the ones that act.
      for (const n of [
        'computer_screenshot',
        'computer_read_ui',
        'computer_zoom',
        'computer_click'
      ])
        expect(names).toContain(n)
    })
  })

  it('ask the user before the first look, once, and then act', async () => {
    await withClient(async (c) => {
      const seen = await call(c, 'computer_screenshot')
      expect(seen.isError).toBeFalsy()
      expect(state.asked).toHaveLength(1)
      // What they are agreeing to, and how to stop it.
      expect(state.asked[0]).toContain('see the screen')
      expect(state.asked[0]).toContain('⌥Esc')
      // The picture, its size, and the other display it could look at.
      expect(seen.content.find((p) => p.type === 'image')?.data).toBe(
        Buffer.from('jpeg-bytes').toString('base64')
      )
      expect(text(seen)).toContain('1440×900')
      expect(text(seen)).toContain('#1 (2560×1440)')

      const clicked = await call(c, 'computer_click', { x: 100, y: 200, count: 2 })
      expect(clicked.isError).toBeFalsy()
      expect(state.acted).toEqual([{ type: 'click', x: 100, y: 200, button: undefined, count: 2 }])
      // Not asked a second time, and shown the screen afterwards.
      expect(state.asked).toHaveLength(1)
      expect(clicked.content.some((p) => p.type === 'image')).toBe(true)
    })
  })

  it('ask about each app the first time it would be touched, with what is at stake', async () => {
    state.consent = true
    state.toAsk = [{ id: 'com.apple.Terminal', name: 'Terminal' }]
    await withClient(async (c) => {
      const typed = await call(c, 'computer_type', { text: 'ls' })
      expect(typed.isError).toBeFalsy()
      expect(state.asked).toHaveLength(1)
      expect(state.asked[0]).toContain('Work in Terminal')
      expect(state.asked[0]).toContain('runs as a command')
      // Said yes once: not asked again for the same app.
      await call(c, 'computer_key', { keys: 'return' })
      expect(state.asked).toHaveLength(1)
      expect(state.acted).toHaveLength(2)
    })
  })

  it('leave an app alone when the user says no to it, and say so', async () => {
    state.consent = true
    state.answer = false
    state.toAsk = [{ id: 'com.apple.finder', name: 'Finder' }]
    await withClient(async (c) => {
      const r = await call(c, 'computer_click', { x: 5, y: 5 })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('did not allow working in Finder')
      expect(state.acted).toEqual([])
    })
  })

  it('ask every time before a shortcut that quits, logs out or deletes', async () => {
    state.consent = true
    await withClient(async (c) => {
      await call(c, 'computer_key', { keys: 'cmd+c' })
      expect(state.asked).toEqual([])
      const quit = await call(c, 'computer_key', { keys: 'cmd+q' })
      expect(quit.isError).toBeFalsy()
      expect(state.asked[0]).toContain('Press cmd+q: it quits the app in front')
      // Asked again the next time: one yes is for one press.
      await call(c, 'computer_key', { keys: 'cmd+q' })
      expect(state.asked).toHaveLength(2)

      state.answer = false
      const out = await call(c, 'computer_key', { keys: 'cmd+shift+q' })
      expect(out.isError).toBe(true)
      expect(text(out)).toContain('did not allow that shortcut')
      expect(state.acted).toHaveLength(3)
    })
  })

  it('do nothing while the safety hooks are gone, however much was allowed before', async () => {
    state.consent = true
    state.hooks = false
    await withClient(async (c) => {
      for (const [name, args] of [
        ['computer_screenshot', {}],
        ['computer_click', { x: 1, y: 1 }],
        ['computer_type', { text: 'x' }]
      ] as const) {
        const r = await call(c, name, args)
        expect(r.isError, name).toBe(true)
        expect(text(r)).toContain('safety hooks are missing')
      }
      expect(state.acted).toEqual([])
      expect(state.shots).toBe(0)
      expect(state.asked).toEqual([])
    })
  })

  it('read the controls by name, give a closer look, wait, and say which apps are showing', async () => {
    state.consent = true
    await withClient(async (c) => {
      const ui = await call(c, 'computer_read_ui')
      expect(text(ui)).toContain('TextEdit — Untitled')
      expect(text(ui)).toContain('button "Save" at 100,40')
      state.ui = { app: 'Figma', window: '', lines: [] }
      expect(text(await call(c, 'computer_read_ui'))).toContain('does not describe its controls')

      const zoom = await call(c, 'computer_zoom', { x: 10, y: 20, width: 200, height: 100 })
      expect(zoom.content.find((p) => p.type === 'image')?.data).toBe(
        Buffer.from('zoomed').toString('base64')
      )
      expect(text(zoom)).toContain('still those of the full screenshot')

      const waited = await call(c, 'computer_wait', { seconds: 2 })
      expect(text(waited)).toContain('Waited 2 s.')
      expect(waited.content.some((p) => p.type === 'image')).toBe(true)

      expect(text(await call(c, 'computer_windows'))).toBe(
        'In front: TextEdit.\nOn screen: TextEdit, Safari.'
      )
      // None of them is an action on the Mac.
      expect(state.acted).toEqual([])
    })
  })

  it('ask every time before a click on something named Log Out or Empty Trash', async () => {
    state.consent = true
    state.risk = 'Click "Empty Trash": it deletes for good, with no way back.'
    await withClient(async (c) => {
      const yes = await call(c, 'computer_click', { x: 5, y: 5 })
      expect(yes.isError).toBeFalsy()
      expect(state.asked).toEqual(['Click "Empty Trash": it deletes for good, with no way back.'])
      state.answer = false
      const no = await call(c, 'computer_click', { x: 5, y: 5 })
      expect(no.isError).toBe(true)
      expect(text(no)).toContain('did not allow that click')
      expect(state.acted).toHaveLength(1)
    })
  })

  it('do nothing at all when the user says no', async () => {
    state.answer = false
    await withClient(async (c) => {
      for (const [name, args] of [
        ['computer_screenshot', {}],
        ['computer_click', { x: 1, y: 1 }],
        ['computer_type', { text: 'hello' }],
        ['computer_key', { keys: 'cmd+q' }]
      ] as const) {
        const r = await call(c, name, args)
        expect(r.isError, name).toBe(true)
        expect(text(r)).toContain('did not allow')
      }
      expect(state.acted).toEqual([])
      expect(state.shots).toBe(0)
    })
  })

  it('say what is missing instead of asking, when a permission has not been given', async () => {
    state.missing = 'Superagent does not have Accessibility (to move the pointer and type).'
    await withClient(async (c) => {
      const r = await call(c, 'computer_click', { x: 1, y: 1 })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('Accessibility')
      expect(state.asked).toEqual([])
      expect(state.acted).toEqual([])
    })
  })

  it('refuse a shortcut that is not one, without touching the keyboard', async () => {
    state.consent = true
    await withClient(async (c) => {
      const bad = await call(c, 'computer_key', { keys: 'cmd+shift' })
      expect(bad.isError).toBe(true)
      expect(state.acted).toEqual([])
      const ok = await call(c, 'computer_key', { keys: ' cmd+c ' })
      expect(ok.isError).toBeFalsy()
      expect(state.acted).toEqual([{ type: 'key', keys: 'cmd+c' }])
    })
  })
})
