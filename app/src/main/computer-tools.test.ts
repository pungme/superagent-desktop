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
  noted: [] as string[],
  clipboard: 'copied earlier',
  known: {
    TextEdit: { id: 'com.apple.TextEdit', name: 'TextEdit' },
    '1Password': { id: 'com.1password.1password', name: '1Password' }
  } as Record<string, { id: string; name: string }>,
  risk: null as string | null,
  ui: { app: 'TextEdit', window: 'Untitled', lines: ['button "Save" at 100,40'] },
  toAsk: [] as { id: string; name: string }[],
  approvedApps: [] as string[],
  steps: false,
  under: '',
  wrote: null as string | null
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
  appNamed: async (name: string) => state.known[name] ?? null,
  offLimitsFor: (a: { id: string }) =>
    a.id.startsWith('com.1password')
      ? '1Password is in the way, and computer use does not operate in it.'
      : null,
  appApproved: (_o: string, id: string) => state.approvedApps.includes(id),
  readClipboard: () => state.clipboard,
  writeClipboard: (t: string) => {
    state.clipboard = t
    state.wrote = t
  },
  clipboardIsOwn: () => state.wrote !== null && state.wrote === state.clipboard,
  waitForControl: async (_o: string, text: string, gone: boolean) => ({
    happened: state.ui.lines.some((l) => l.includes(text)) !== gone,
    waited: 1.5,
    ui: state.ui
  }),
  pressControl: async (_o: string, index: number, name: string) => {
    state.acted.push({ type: 'press', index, name })
  },
  fillControl: async (_o: string, index: number, name: string, text: string) => {
    state.acted.push({ type: 'fill', index, name, text })
  },
  pickMenu: async (_o: string, path: string) => {
    state.acted.push({ type: 'menu', path })
  },
  riskAt: async () => state.risk,
  stepByStep: () => state.steps,
  controlAt: async () => ({ role: 'AXButton', label: state.under }),
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
      hidden: [],
      displays: [
        { index: 0, width: 1440, height: 900, current: true },
        { index: 1, width: 2560, height: 1440, current: false }
      ]
    }
  }
}))
vi.mock('./computer-log', () => ({
  noteComputer: (e: { what: string; kind?: string }) => {
    state.noted.push(`${e.kind}: ${e.what}`)
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
    noted: [],
    clipboard: 'copied earlier',
    risk: null,
    ui: { app: 'TextEdit', window: 'Untitled', lines: ['button "Save" at 100,40'] },
    toAsk: [],
    approvedApps: [],
    steps: false,
    under: '',
    wrote: null
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

  it('wait for a control to appear or to go, and say which happened', async () => {
    state.consent = true
    await withClient(async (c) => {
      expect(text(await call(c, 'computer_wait_for', { text: 'Save' }))).toContain(
        'After 1.5 s, "Save" was there.'
      )
      expect(text(await call(c, 'computer_wait_for', { text: 'Loading', gone: true }))).toContain(
        '"Loading" was gone'
      )
      expect(text(await call(c, 'computer_wait_for', { text: 'Export finished' }))).toContain(
        'Still not there after 1.5 s: "Export finished".'
      )
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

  it('step by step: say each step first, take it only on a yes, and leave looking alone', async () => {
    state.consent = true
    state.steps = true
    state.under = 'Save'
    await withClient(async (c) => {
      expect((await call(c, 'computer_click', { x: 5, y: 5 })).isError).toBeFalsy()
      await call(c, 'computer_type', { text: 'Dear all,\nsecond line' })
      await call(c, 'computer_key', { keys: 'cmd+s' })
      await call(c, 'computer_press', { index: 3, name: 'Export' })
      await call(c, 'computer_fill', { index: 4, name: 'Title', text: 'Notes' })
      expect(state.asked).toEqual([
        'Next step: Click "Save".',
        'Next step: Type "Dear all, ⏎ second line" (2 lines).',
        'Next step: Press cmd+s.',
        'Next step: Press "Export".',
        'Next step: Put this in "Title": "Notes".'
      ])
      expect(state.acted).toHaveLength(5)
      // Looking, scrolling and moving the pointer are not asked about.
      await call(c, 'computer_screenshot', {})
      await call(c, 'computer_scroll', { x: 5, y: 5, dx: 0, dy: -3 })
      await call(c, 'computer_move', { x: 9, y: 9 })
      expect(state.asked).toHaveLength(5)
      // A no stops that step, and says to stop rather than find another way.
      state.answer = false
      const no = await call(c, 'computer_click', { x: 5, y: 5 })
      expect(no.isError).toBe(true)
      expect(text(no)).toContain('did not allow that step')
      const noName = await call(c, 'computer_press', { index: 3, name: 'Export' })
      expect(text(noName)).toContain('did not allow that step')
      expect(state.acted).toHaveLength(7)
    })
  })

  it('step by step: a risky step is asked about once, in its own words', async () => {
    state.consent = true
    state.steps = true
    state.risk = 'Click "Empty Trash": it deletes for good, with no way back.'
    await withClient(async (c) => {
      await call(c, 'computer_click', { x: 5, y: 5 })
      expect(state.asked).toEqual(['Click "Empty Trash": it deletes for good, with no way back.'])
    })
  })

  it('press, fill and pick a menu item by name, asking first where the name says to', async () => {
    state.consent = true
    state.toAsk = [{ id: 'com.apple.TextEdit', name: 'TextEdit' }]
    await withClient(async (c) => {
      const pressed = await call(c, 'computer_press', { index: 3, name: 'Save' })
      expect(pressed.isError).toBeFalsy()
      // The app, the first time; not again for the next thing in it.
      expect(state.asked).toEqual([expect.stringContaining('Work in TextEdit')])
      await call(c, 'computer_fill', { index: 4, name: 'Title', text: 'Notes' })
      await call(c, 'computer_menu', { path: 'Edit > Select All' })
      expect(state.asked).toHaveLength(1)
      expect(state.acted).toEqual([
        { type: 'press', index: 3, name: 'Save' },
        { type: 'fill', index: 4, name: 'Title', text: 'Notes' },
        { type: 'menu', path: 'Edit > Select All' }
      ])

      // A name that ends or destroys something is asked about every time.
      await call(c, 'computer_menu', { path: 'TextEdit > Quit TextEdit' })
      expect(state.asked[1]).toContain('Pick TextEdit > Quit TextEdit: it quits an app')
      // However the path is dressed: a ">" on the end used to hide the item.
      const before = state.asked.length
      await call(c, 'computer_menu', { path: 'TextEdit > Quit TextEdit >' })
      expect(state.asked[before]).toContain('Pick TextEdit > Quit TextEdit: it quits an app')
      expect(state.acted.at(-1)).toEqual({ type: 'menu', path: 'TextEdit > Quit TextEdit' })
      expect((await call(c, 'computer_menu', { path: 'Quit >' })).isError).toBe(true)
      state.answer = false
      const no = await call(c, 'computer_press', { index: 9, name: 'Empty Trash…' })
      expect(no.isError).toBe(true)
      expect(state.asked.at(-1)).toContain('Press "Empty Trash…": it deletes for good')
      expect(state.acted).toHaveLength(5)
    })
  })

  it('are refused, unasked, to an agent whose own shell runs unseen', async () => {
    const { setShellGapProbe } = await import('./computer-tools')
    setShellGapProbe(() => 'Computer use is not available to Codex in Full mode.')
    try {
      await withClient(async (c) => {
        const no = await call(c, 'computer_click', { x: 5, y: 5 })
        expect(no.isError).toBe(true)
        expect(text(no)).toContain('Codex in Full mode')
        expect((await call(c, 'computer_screenshot', {})).isError).toBe(true)
        expect(state.asked).toEqual([])
        expect(state.acted).toEqual([])
      })
    } finally {
      setShellGapProbe(() => null)
    }
  })

  it('open an app only after asking about it, and never one that is out of bounds', async () => {
    state.consent = true
    await withClient(async (c) => {
      const locked = await call(c, 'computer_open_mac_app', { name: '1Password' })
      expect(locked.isError).toBe(true)
      expect(text(locked)).toContain('1Password')
      expect(state.asked).toEqual([])

      state.answer = false
      const no = await call(c, 'computer_open_mac_app', { name: 'TextEdit' })
      expect(no.isError).toBe(true)
      expect(state.asked[0]).toContain('Work in TextEdit')
      expect(text(no)).toContain('did not allow working in TextEdit')

      // Something that cannot be identified is not opened to find out what it is.
      const before = state.asked.length
      const unknown = await call(c, 'computer_open_mac_app', { name: '/tmp/Something.app' })
      expect(unknown.isError).toBe(true)
      expect(text(unknown)).toContain('no app called')
      expect(state.asked).toHaveLength(before)

      // Step by step, an app already allowed is still asked about before it
      // is brought forward. (Answered no: nothing here opens a real app.)
      state.steps = true
      state.approvedApps = ['com.apple.TextEdit']
      const step = await call(c, 'computer_open_mac_app', { name: 'TextEdit' })
      expect(state.asked.at(-1)).toBe('Next step: Open TextEdit.')
      expect(text(step)).toContain('did not allow that step')
    })
  })

  it('paste what the user copied only with a yes; what it put there itself, freely', async () => {
    state.consent = true
    await withClient(async (c) => {
      // The user's own clipboard: ⌘V is a way to read it, so it is asked.
      await call(c, 'computer_key', { keys: 'cmd+v' })
      expect(state.asked).toEqual([expect.stringContaining('Paste what is on your clipboard')])
      state.answer = false
      const no = await call(c, 'computer_key', { keys: 'Cmd+Shift+V' })
      expect(no.isError).toBe(true)
      expect(text(no)).toContain('did not allow pasting')
      const menu = await call(c, 'computer_menu', { path: 'Edit > Paste and Match Style' })
      expect(menu.isError).toBe(true)
      expect(state.asked).toHaveLength(3)
      expect(state.acted).toHaveLength(1)

      // What this conversation wrote is its own to paste.
      state.answer = true
      await call(c, 'computer_clipboard_write', { text: 'a paragraph of mine' })
      await call(c, 'computer_key', { keys: 'cmd+v' })
      expect(state.asked).toHaveLength(3)
      // Until the user copies something else.
      state.clipboard = 'a password, say'
      await call(c, 'computer_key', { keys: 'cmd+v' })
      expect(state.asked).toHaveLength(4)
      // Other shortcuts with a v in them, or without ⌘, are not pastes.
      await call(c, 'computer_key', { keys: 'v' })
      await call(c, 'computer_key', { keys: 'ctrl+v' })
      expect(state.asked).toHaveLength(4)
    })
  })

  it('read the clipboard only with a yes each time, and write it without one', async () => {
    state.consent = true
    await withClient(async (c) => {
      const read = await call(c, 'computer_clipboard_read')
      expect(state.asked[0]).toContain('Read what is on your clipboard')
      expect(text(read)).toContain('copied earlier')
      await call(c, 'computer_clipboard_read')
      expect(state.asked).toHaveLength(2)

      await call(c, 'computer_clipboard_write', { text: 'a long paragraph' })
      expect(state.clipboard).toBe('a long paragraph')
      expect(state.asked).toHaveLength(2)

      state.answer = false
      const no = await call(c, 'computer_clipboard_read')
      expect(no.isError).toBe(true)
      expect(text(no)).not.toContain('a long paragraph')
    })
  })

  it('keep a record of each look and each action, without what was typed', async () => {
    state.consent = true
    await withClient(async (c) => {
      await call(c, 'computer_screenshot')
      await call(c, 'computer_click', { x: 5, y: 6 })
      await call(c, 'computer_type', { text: 'my secret words' })
      await call(c, 'computer_press', { index: 2, name: 'Save' })
      expect(state.noted[0]).toBe('looked: Looked at the screen')
      expect(state.noted).toContain('did: Typed 15 characters')
      expect(state.noted).toContain('did: Pressed "Save"')
      expect(state.noted.join(' ')).not.toContain('my secret words')
      expect(state.noted.some((n) => n.startsWith('did: ') && /5, 6|click/i.test(n))).toBe(true)
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
