import { execFile } from 'child_process'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  approveApp,
  appsShowing,
  appsToAsk,
  fillControl,
  pickMenu,
  pressControl,
  readUi,
  riskAt,
  takeZoom,
  waitForControl,
  act,
  computerUseEnabled,
  grantConsent,
  hasConsent,
  notReady,
  settle,
  takeScreenshot,
  touchConsent,
  type ComputerAction
} from './computer-use'
import { hooksIntact, requestApproval } from './hooks'
import {
  appCaution,
  COMPUTER_STOP_HOTKEY,
  riskyControl,
  riskyShortcut,
  validKeyCombo
} from '../shared/computer-use'

export interface ComputerContext {
  workspaceId: string
  /** The chat's id, or the pane's when there is none: who the yes belongs to. */
  sessionId: string
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type Result = { content: Content[]; isError?: boolean }

const failed = (text: string): Result => ({ isError: true, content: [{ type: 'text', text }] })

export const CONSENT_PREVIEW =
  'Use this Mac: see the screen, move the pointer, click and type in your apps, for this task.\n' +
  `It asks again after ten minutes idle. ${COMPUTER_STOP_HOTKEY.replace('Alt', '⌥').replace('+Escape', 'Esc')} stops it at any time.`

/**
 * The agent's tools for using the Mac itself. Registered only while computer
 * use is turned on, and each one checks again when called: the permissions,
 * and that this conversation has been allowed to.
 */
/**
 * Every tool this registers. The Computer chat has tools of its own that begin
 * computer_ (they arrange Superagent's windows, in mcp.ts); a name used twice
 * stops the whole tool server from starting, so these are checked against them.
 */
export const COMPUTER_TOOL_NAMES = [
  'computer_screenshot',
  'computer_click',
  'computer_move',
  'computer_drag',
  'computer_scroll',
  'computer_type',
  'computer_key',
  'computer_open_mac_app',
  'computer_read_ui',
  'computer_zoom',
  'computer_wait',
  'computer_windows',
  'computer_press',
  'computer_fill',
  'computer_menu',
  'computer_wait_for'
] as const

export function registerComputerTools(server: McpServer, ctx: ComputerContext): void {
  if (!computerUseEnabled()) return
  const owner = ctx.sessionId

  /** Ready, and allowed by the user for this conversation; else what to say. */
  const gate = async (): Promise<string | null> => {
    const missing = notReady()
    if (missing) return missing
    // The guards on the agent's own shell live in the hooks. Gone, and they
    // cannot be put back: no hands on the Mac until they are.
    if (!hooksIntact())
      return "Superagent's safety hooks are missing from this Mac's Claude settings and could not be put back, so computer use is paused. Tell the user; restarting Superagent restores them."
    if (hasConsent(owner)) return null
    const yes = await requestApproval(
      ctx.workspaceId,
      ctx.sessionId,
      'mcp__cove-browser__computer_use',
      CONSENT_PREVIEW,
      'permission'
    )
    if (!yes)
      return 'The user did not allow using the Mac for this. Do not try again; ask what they would like instead, or do it another way.'
    grantConsent(owner)
    return null
  }

  /** The screen as it is now, with what the agent needs to know to point at it. */
  const look = async (note: string, display?: number): Promise<Result> => {
    const s = await takeScreenshot(owner, display)
    const others = s.displays.filter((d) => !d.current)
    return {
      content: [
        {
          type: 'text',
          text:
            `${note}${note ? ' ' : ''}Screen: ${s.shot.width}×${s.shot.height} pixels, top left 0,0. ` +
            'Coordinates you pass are in these pixels.' +
            (others.length
              ? ` Other displays: ${others.map((d) => `#${d.index} (${d.width}×${d.height})`).join(', ')}; pass display to computer_screenshot to look at one.`
              : '')
        },
        { type: 'image', data: s.jpeg.toString('base64'), mimeType: 'image/jpeg' }
      ]
    }
  }

  /** Do it, let the screen catch up, and show what it looks like now. */
  const doThen = async (action: ComputerAction, said: string): Promise<Result> => {
    const no = await gate()
    if (no) return failed(no)
    try {
      // A shortcut that quits, logs out or deletes is asked about every time,
      // and so is a click on a menu item or button named for the same things.
      const shortcut = action.type === 'key' ? riskyShortcut(action.keys) : null
      const risk = shortcut
        ? `Press ${action.type === 'key' ? action.keys : ''}: it ${shortcut}.`
        : await riskAt(owner, action)
      if (risk) {
        const yes = await requestApproval(
          ctx.workspaceId,
          ctx.sessionId,
          'mcp__cove-browser__computer_use',
          risk,
          'permission'
        )
        if (!yes)
          return failed(
            shortcut
              ? 'The user did not allow that shortcut. Do not press it another way; ask what they would like instead.'
              : 'The user did not allow that click. Do not reach it another way; ask what they would like instead.'
          )
      }
      // Each app, the first time this conversation would touch it.
      for (const app of await appsToAsk(owner, action)) {
        const caution = appCaution(app.id)
        const yes = await requestApproval(
          ctx.workspaceId,
          ctx.sessionId,
          'mcp__cove-browser__computer_use',
          `Work in ${app.name}: click and type in its windows, for this task.${caution ? `\n${caution}` : ''}`,
          'permission'
        )
        if (!yes)
          return failed(
            `The user did not allow working in ${app.name}. Do not try again there; ask what they would like instead, or do it another way.`
          )
        approveApp(owner, app.id)
      }
      await act(owner, action)
      await settle()
      return await look(said)
    } catch (e) {
      return failed((e as Error).message)
    }
  }

  const point = {
    x: z.number().describe('Pixels from the left of the screenshot.'),
    y: z.number().describe('Pixels from the top of the screenshot.')
  }

  server.registerTool(
    'computer_screenshot',
    {
      description:
        "See this Mac's screen: returns it as an image, and its size in pixels. This is how you look before you act and check after. Points you pass to the other computer_* tools are pixels on the LATEST screenshot. Shows the display the pointer is on unless another is asked for.",
      inputSchema: {
        display: z.number().int().min(0).optional().describe('Which display, by its number.')
      }
    },
    async ({ display }) => {
      const no = await gate()
      if (no) return failed(no)
      try {
        return await look('', display)
      } catch (e) {
        return failed((e as Error).message)
      }
    }
  )

  server.registerTool(
    'computer_click',
    {
      description:
        'Click at a point on the latest screenshot. button is left (default), right or middle; count 2 for a double click, 3 for a triple. Returns the screen afterwards.',
      inputSchema: {
        ...point,
        button: z.enum(['left', 'right', 'middle']).optional(),
        count: z.number().int().min(1).max(3).optional()
      }
    },
    ({ x, y, button, count }) =>
      doThen({ type: 'click', x, y, button, count }, `Clicked at ${x}, ${y}.`)
  )

  server.registerTool(
    'computer_read_ui',
    {
      description:
        'The controls of the window in front, by name: every button, field, checkbox, menu and link with what it is called, what it holds, and the point on the latest screenshot to click for it. Surer than reading small text off the picture; use it when a screenshot does not make clear what something is or where exactly it is. Works without a screenshot, and is often enough by itself to know where to click. A password field is listed but never read.',
      inputSchema: {}
    },
    async () => {
      const no = await gate()
      if (no) return failed(no)
      try {
        const ui = await readUi(owner)
        return {
          content: [
            {
              type: 'text',
              text: ui.lines.length
                ? `${ui.app}${ui.window ? ` — ${ui.window}` : ''}\n${ui.lines.join('\n')}`
                : `${ui.app || 'This app'} does not describe its controls. Go by the screenshot instead.`
            }
          ]
        }
      } catch (e) {
        return failed((e as Error).message)
      }
    }
  )

  /** Act on a control by name: the same questions as for a click, then the screen. */
  const byName = async (
    risky: string | null,
    what: string,
    doIt: () => Promise<void>,
    said: string
  ): Promise<Result> => {
    const no = await gate()
    if (no) return failed(no)
    try {
      // The app in front is the one being worked in: asked about the first time.
      for (const app of await appsToAsk(owner, { type: 'key', keys: 'return' })) {
        const caution = appCaution(app.id)
        const yes = await requestApproval(
          ctx.workspaceId,
          ctx.sessionId,
          'mcp__cove-browser__computer_use',
          `Work in ${app.name}: click and type in its windows, for this task.${caution ? `\n${caution}` : ''}`,
          'permission'
        )
        if (!yes)
          return failed(
            `The user did not allow working in ${app.name}. Do not try again there; ask what they would like instead, or do it another way.`
          )
        approveApp(owner, app.id)
      }
      if (risky) {
        const yes = await requestApproval(
          ctx.workspaceId,
          ctx.sessionId,
          'mcp__cove-browser__computer_use',
          `${what}: it ${risky}.`,
          'permission'
        )
        if (!yes)
          return failed(
            'The user did not allow that. Do not reach it another way; ask what they would like instead.'
          )
      }
      await doIt()
      await settle()
      // The screen afterwards when it can be seen; the action stands either way.
      return await look(said).catch(() => ({ content: [{ type: 'text', text: said }] }) as Result)
    } catch (e) {
      return failed((e as Error).message)
    }
  }

  const control = {
    index: z.number().int().min(0).describe('The number in brackets from computer_read_ui.'),
    name: z.string().max(300).describe('What computer_read_ui called it, exactly.')
  }

  server.registerTool(
    'computer_press',
    {
      description:
        'Press a button, checkbox, link or menu by its number and name from computer_read_ui, without moving the pointer. Surer than clicking at a point: prefer it whenever the control is in that list. Returns the screen afterwards.',
      inputSchema: control
    },
    ({ index, name }) =>
      byName(
        riskyControl('AXButton', name),
        `Press "${name}"`,
        () => pressControl(owner, index, name),
        `Pressed "${name}".`
      )
  )

  server.registerTool(
    'computer_fill',
    {
      description:
        'Put text in a text field by its number and name from computer_read_ui, replacing what is there, without clicking in it or typing key by key. Never works on a password field. Returns the screen afterwards.',
      inputSchema: { ...control, text: z.string().max(4000) }
    },
    ({ index, name, text }) =>
      byName(null, '', () => fillControl(owner, index, name, text), `Filled "${name}".`)
  )

  server.registerTool(
    'computer_menu',
    {
      description:
        'Pick a menu item of the app in front by its path, written with ">" between the levels and the item spelled as the menu shows it: "File > Export > PDF…", "Edit > Select All". No clicking through menus. Returns the screen afterwards.',
      inputSchema: { path: z.string().min(1).max(300) }
    },
    ({ path }) => {
      const last = path.split('>').pop()?.trim() ?? ''
      return byName(
        riskyControl('AXMenuItem', last),
        `Pick ${path}`,
        () => pickMenu(owner, path),
        `Picked ${path}.`
      )
    }
  )

  server.registerTool(
    'computer_zoom',
    {
      description:
        'A closer look at part of the screen: the region, in pixels of the latest screenshot, enlarged at full sharpness. For text too small to read. Points for the other tools are still those of the full screenshot, not of this picture.',
      inputSchema: {
        ...point,
        width: z.number().min(20).describe('Width of the region, in screenshot pixels.'),
        height: z.number().min(20).describe('Height of the region, in screenshot pixels.')
      }
    },
    async ({ x, y, width, height }) => {
      const no = await gate()
      if (no) return failed(no)
      try {
        const z = await takeZoom(owner, { x, y, width, height })
        return {
          content: [
            {
              type: 'text',
              text: `The region at ${Math.round(x)},${Math.round(y)}, ${Math.round(width)}×${Math.round(height)}, enlarged. Coordinates you pass are still those of the full screenshot.`
            },
            { type: 'image', data: z.jpeg.toString('base64'), mimeType: 'image/jpeg' }
          ]
        }
      } catch (e) {
        return failed((e as Error).message)
      }
    }
  )

  server.registerTool(
    'computer_wait',
    {
      description:
        'Wait for something on screen to finish (a page loading, an app opening, a progress bar), then return the screen. Up to 10 seconds a call.',
      inputSchema: { seconds: z.number().min(0.5).max(10) }
    },
    async ({ seconds }) => {
      const no = await gate()
      if (no) return failed(no)
      touchConsent(owner)
      await settle(Math.round(seconds * 1000))
      try {
        return await look(`Waited ${seconds} s.`)
      } catch (e) {
        return failed((e as Error).message)
      }
    }
  )

  server.registerTool(
    'computer_wait_for',
    {
      description:
        'Wait until a control with this text in its name appears in the window in front (a "Done" button, a result), or with gone: true until it disappears (a progress bar, "Loading…"). Better than waiting a fixed time. Up to 30 seconds a call; returns whether it happened and the controls as they are then.',
      inputSchema: {
        text: z.string().min(1).max(200),
        gone: z.boolean().optional(),
        seconds: z.number().min(1).max(30).optional()
      }
    },
    async ({ text, gone, seconds }) => {
      const no = await gate()
      if (no) return failed(no)
      try {
        const r = await waitForControl(owner, text, !!gone, seconds ?? 10)
        const what = gone ? `"${text}" was gone` : `"${text}" was there`
        return {
          content: [
            {
              type: 'text',
              text:
                (r.happened
                  ? `After ${r.waited} s, ${what}.`
                  : `Still ${gone ? 'there' : 'not there'} after ${r.waited} s: "${text}".`) +
                (r.ui.lines.length ? `\n${r.ui.lines.join('\n')}` : '')
            }
          ]
        }
      } catch (e) {
        return failed((e as Error).message)
      }
    }
  )

  server.registerTool(
    'computer_windows',
    {
      description:
        'Which apps have a window on screen, and which is in front. Cheaper than a screenshot when that is all you need to know.',
      inputSchema: {}
    },
    async () => {
      const no = await gate()
      if (no) return failed(no)
      try {
        const w = await appsShowing(owner)
        return {
          content: [
            {
              type: 'text',
              text: `In front: ${w.front || 'unknown'}.\nOn screen: ${w.apps.join(', ') || 'nothing'}.`
            }
          ]
        }
      } catch (e) {
        return failed((e as Error).message)
      }
    }
  )

  server.registerTool(
    'computer_move',
    {
      description:
        'Move the pointer to a point without clicking: to hover over something (a menu, a tooltip). Returns the screen afterwards.',
      inputSchema: point
    },
    ({ x, y }) => doThen({ type: 'move', x, y }, `Pointer at ${x}, ${y}.`)
  )

  server.registerTool(
    'computer_drag',
    {
      description:
        'Press at one point, drag to another and let go: moving a file, a slider, a window, a selection. Returns the screen afterwards.',
      inputSchema: {
        ...point,
        toX: z.number().describe('Where to let go: pixels from the left.'),
        toY: z.number().describe('Where to let go: pixels from the top.')
      }
    },
    ({ x, y, toX, toY }) =>
      doThen({ type: 'drag', x, y, toX, toY }, `Dragged from ${x}, ${y} to ${toX}, ${toY}.`)
  )

  server.registerTool(
    'computer_scroll',
    {
      description:
        'Scroll with the pointer over a point. dy is lines: negative scrolls down the page, positive up; dx likewise sideways. Returns the screen afterwards.',
      inputSchema: {
        ...point,
        dy: z.number().int().min(-50).max(50).default(-5),
        dx: z.number().int().min(-50).max(50).default(0)
      }
    },
    ({ x, y, dx, dy }) => doThen({ type: 'scroll', x, y, dx, dy }, `Scrolled at ${x}, ${y}.`)
  )

  server.registerTool(
    'computer_type',
    {
      description:
        'Type text at the cursor, as if on the keyboard: click the field first. A newline in the text presses Return. Never type a password, a card number or a one-time code: ask the user to enter those themselves. Returns the screen afterwards.',
      inputSchema: { text: z.string().min(1).max(4000) }
    },
    ({ text }) => doThen({ type: 'type', text }, `Typed ${text.length} characters.`)
  )

  server.registerTool(
    'computer_key',
    {
      description:
        'Press a key or a shortcut: "return", "escape", "tab", "cmd+c", "cmd+shift+4", "cmd+space", arrows as "up"/"down"/"left"/"right". Modifiers (cmd, shift, alt, ctrl, fn) joined to one key with +. Returns the screen afterwards.',
      inputSchema: { keys: z.string().min(1).max(40) }
    },
    ({ keys }) =>
      validKeyCombo(keys.trim())
        ? doThen({ type: 'key', keys: keys.trim() }, `Pressed ${keys.trim()}.`)
        : Promise.resolve(
            failed(
              `"${keys}" is not a key or shortcut: use modifiers (cmd, shift, alt, ctrl, fn) joined with + to ONE key, like "cmd+c" or "return".`
            )
          )
  )

  server.registerTool(
    'computer_open_mac_app',
    {
      description:
        'Open an app on this Mac by name ("Finder", "System Settings", "Figma"), or bring it to the front if it is open. Quicker and surer than clicking its Dock icon. Returns the screen afterwards.',
      inputSchema: { name: z.string().min(1).max(100) }
    },
    async ({ name }) => {
      const no = await gate()
      if (no) return failed(no)
      const opened = await new Promise<string>((resolve) =>
        execFile('/usr/bin/open', ['-a', name], { timeout: 15_000 }, (err, _o, stderr) =>
          resolve(err ? String(stderr || err.message).trim() : '')
        )
      )
      if (opened) return failed(`Could not open "${name}": ${opened.slice(0, 200)}`)
      touchConsent(owner)
      await settle(900)
      try {
        return await look(`Opened ${name}.`)
      } catch (e) {
        return failed((e as Error).message)
      }
    }
  )
}
