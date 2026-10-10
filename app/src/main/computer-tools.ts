import { execFile } from 'child_process'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  approveApp,
  appsToAsk,
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
  'computer_open_mac_app'
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
      // A shortcut that quits, logs out or deletes is asked about every time.
      const risk = action.type === 'key' ? riskyShortcut(action.keys) : null
      if (risk) {
        const yes = await requestApproval(
          ctx.workspaceId,
          ctx.sessionId,
          'mcp__cove-browser__computer_use',
          `Press ${action.type === 'key' ? action.keys : ''}: it ${risk}.`,
          'permission'
        )
        if (!yes)
          return failed(
            'The user did not allow that shortcut. Do not press it another way; ask what they would like instead.'
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
