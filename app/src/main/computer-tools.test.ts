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
  shots: 0
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
    shots: 0
  })
})

describe("the agent's tools for using the Mac", () => {
  it('do not exist while computer use is turned off', async () => {
    state.enabled = false
    await withClient(async (c) => {
      expect(c.getServerCapabilities()?.tools).toBeUndefined()
    })
  })

  it('are there when it is on', async () => {
    await withClient(async (c) => {
      expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
        'computer_click',
        'computer_drag',
        'computer_key',
        'computer_move',
        'computer_open_app',
        'computer_screenshot',
        'computer_scroll',
        'computer_type'
      ])
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
