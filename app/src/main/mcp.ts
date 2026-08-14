import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as auto from './automation'
import { simTarget, isMirroring, keepSimulatorHidden, sendSimInput } from './simulator'
import { withoutStealingFocus } from './browser'
import { nativeImage } from 'electron'
import { readFileSync, unlinkSync } from 'fs'
import { execFile } from 'child_process'
import { tmpdir } from 'os'

/**
 * SuperAgent's browser-automation MCP server.
 * HTTP transport on 127.0.0.1 with a per-launch secret in the path.
 * Each SuperAgent-launched claude session gets a config whose URL carries ?ws=<id>,
 * so tool calls are scoped to that session's own workspace browser pane.
 */

import { app } from 'electron'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { createRoutineForWorkspace, listRoutines, deleteRoutine } from './routines'
import {
  DESKTOP_WORKSPACE_ID,
  getWorkspacePath,
  addProjectWorkspace,
  listCards,
  addCard,
  updateCard,
  moveCard,
  removeCard
} from './store'
import { activeDesktopTab, describeDesktop, desktopState } from './desktop'
import { gitBranch } from './files'
import { readJsonBody, workspaceIdFromPane, broadcastToWindows } from './util'
import { isAbsolute, resolve } from 'path'
import { homedir } from 'os'

let port = 0
let secret = ''

/**
 * Show a file in the app without pulling the app in front of whatever the user
 * is doing.
 *
 * The browser tools all run inside withoutStealingFocus; this one did not,
 * because it does its work in the renderer — main broadcasts, the renderer
 * navigates the pane, and the load happens well outside any guard main is
 * holding. For a PDF or an image that means Chromium's viewer initialising and
 * asking for focus, which on macOS raises the whole window. Nothing in the
 * automation path could prevent it, since the automation path is not involved.
 *
 * The guard is held across the round trip rather than the broadcast: the grab
 * comes from the load, not from the send.
 */
function openFileInApp(workspaceId: string, path: string): Promise<void> {
  return withoutStealingFocus(async () => {
    broadcastToWindows('app:open-file', { workspaceId, path })
    // Long enough for the renderer to mount the pane and the viewer to start —
    // the guard adds its own short tail on release.
    await new Promise((r) => setTimeout(r, 1500))
  })
}

function buildServer(paneId: string, chatId: string | null): McpServer {
  const PANE_ID = paneId
  const CHAT_ID = chatId
  const server = new McpServer({ name: 'cove-browser', version: '0.1.0' })
  /**
   * The desktop chat is not a project — it is the computer's own agent, and the
   * things it drives are the desktop's, not a workspace's.
   */
  const isDesktop = PANE_ID === DESKTOP_WORKSPACE_ID

  /**
   * Which browser the browser_* tools drive.
   *
   * In a project it is that workspace's pane. On the desktop the browser is an
   * application with tabs, so the tools follow the tab in front — the one the
   * user is actually looking at — exactly as they follow the visible pane
   * everywhere else.
   */
  const browserPane = (): string => (isDesktop ? (activeDesktopTab() ?? PANE_ID) : PANE_ID)

  // --- iOS Simulator (phase 1: simctl, public APIs only) -------------------
  const simctl = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('xcrun', ['simctl', ...args], { timeout: 60_000 }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout)
      )
    })

  server.registerTool(
    'sim_list_devices',
    {
      description:
        'List iOS Simulator devices (name, UDID, state). Use before booting or targeting a device. The device the user is WATCHING in the pane is marked — build, install and launch onto that one unless told otherwise.',
      inputSchema: {}
    },
    async () => {
      const out = await simctl(['list', 'devices', 'available', '--json'])
      const data = JSON.parse(out) as {
        devices: Record<string, { name: string; udid: string; state: string }[]>
      }
      const lines: string[] = []
      for (const [runtime, devs] of Object.entries(data.devices)) {
        for (const d of devs) {
          const watched = d.udid === simTarget() ? '  <-- SHOWN IN THE PANE' : ''
          lines.push(`${d.name} — ${d.state} — ${d.udid} (${runtime.split('.').pop()})${watched}`)
        }
      }
      // More than one booted device is exactly when `simctl ... booted` picks
      // the wrong one, which put an app on a simulator the user could not see.
      if (simTarget() !== 'booted') {
        lines.push(
          '',
          `The pane is showing ${simTarget()}. If you run simctl yourself, pass that UDID — NOT the word "booted", which resolves to an arbitrary one when several are running.`
        )
      }
      return { content: [{ type: 'text', text: lines.join('\n') || 'No simulators available.' }] }
    }
  )

  server.registerTool(
    'sim_boot',
    {
      description:
        "Boot an iOS Simulator by UDID (from sim_list_devices) and show it in SuperAgent's own simulator pane, where the user is watching. Do NOT open Apple's Simulator app for this — the pane is the point.",
      inputSchema: { udid: z.string() }
    },
    async ({ udid }) => {
      await simctl(['boot', udid]).catch((e) => {
        if (!String(e).includes('current state: Booted')) throw e
      })
      // Deliberately NOT `open -a Simulator`: that put a second, separate
      // window on screen showing a different device from the one in the pane,
      // which is where the user is actually looking.
      // Reveal the pane the way browser_navigate reveals the browser: the user
      // asked for a simulator, so show them one instead of leaving a button.
      broadcastToWindows('app:open-simulator', {
        workspaceId: workspaceIdFromPane(PANE_ID),
        udid
      })
      // A build with a simulator destination opens Apple's window by itself.
      if (isMirroring(udid)) keepSimulatorHidden()
      return { content: [{ type: 'text', text: `Booted ${udid}.` }] }
    }
  )

  server.registerTool(
    'sim_screenshot',
    {
      description:
        'Screenshot the iOS Simulator the user is watching and return the PNG path. If the pane is already mirroring that device live, the still is not opened — the user can see it already.',
      inputSchema: {}
    },
    async () => {
      const file = `${tmpdir()}/sim-${Date.now()}.png`
      await simctl(['io', simTarget(), 'screenshot', file])
      const ws = workspaceIdFromPane(PANE_ID)
      // Reveal the pane, the same as reading/driving does — a screenshot means
      // the agent is looking at the device, so the user should be too.
      const tgt = await inputTarget()
      // If the pane is already mirroring this device (or we just revealed one)
      // the user is looking at it live; opening the still as a file would take
      // over the working surface and leave two views of the same phone.
      const live = 'udid' in tgt || isMirroring(simTarget())
      if (!live) await openFileInApp(ws, file)
      return {
        content: [
          {
            type: 'text',
            text: live
              ? `Simulator screenshot saved to ${file}. The pane is already showing this device live, so it was not opened as a file.`
              : `Simulator screenshot saved to ${file} and opened in SuperAgent.`
          }
        ]
      }
    }
  )

  server.registerTool(
    'sim_open_url',
    {
      description:
        'Open a URL (deep link or web) on the iOS Simulator the user is watching in the pane.',
      inputSchema: { url: z.string() }
    },
    async ({ url }) => {
      await inputTarget() // reveal the pane; opening a URL is something to watch
      await simctl(['openurl', simTarget(), url])
      return { content: [{ type: 'text', text: `Opened ${url} in the simulator.` }] }
    }
  )

  server.registerTool(
    'sim_install_and_launch',
    {
      description:
        'Install a .app bundle and launch it by bundle id on the simulator the user is watching in the pane. Prefer this over running `simctl install/launch` yourself — a bare `booted` picks an arbitrary device when several are running, and the app then opens where nobody can see it.',
      inputSchema: { appPath: z.string(), bundleId: z.string() }
    },
    async ({ appPath, bundleId }) => {
      await simctl(['install', simTarget(), appPath])
      const out = await simctl(['launch', simTarget(), bundleId])
      broadcastToWindows('app:open-simulator', {
        workspaceId: workspaceIdFromPane(PANE_ID),
        udid: simTarget()
      })
      if (isMirroring(simTarget())) keepSimulatorHidden()
      return { content: [{ type: 'text', text: out.trim() || `Launched ${bundleId}.` }] }
    }
  )

  // --- iOS Simulator: driving the device (phase 2: real gestures) ----------
  //
  // The device the pane is showing, tapped and typed the way the browser tools
  // drive a page. Coordinates are in the PIXELS of what sim_screen returns:
  // take a screen, look at it, act on what you saw. baguette scales pixels to
  // the real device by the size the screen reports, so the numbers you read off
  // the image are the numbers you pass.
  //
  // The device's pixel size is fixed, so it is remembered once — a tap does not
  // need its own screenshot to know the scale.
  const screenSize = new Map<string, { w: number; h: number }>()

  // simTarget() is 'booted' when the pane is not mirroring a specific device.
  // simctl accepts that word for a screenshot; baguette needs a real UDID. So
  // input resolves it — to the one booted device, or an error if the choice is
  // ambiguous rather than driving the wrong phone.
  // Any time the agent reads or drives the device, make sure its pane is on
  // screen. The pane used to reveal only from sim_boot / sim_install_and_launch,
  // so a device booted another way — raw `xcrun simctl`, or left running from a
  // previous session — got tapped and screenshotted while the user's pane stayed
  // shut ("why isn't it opening the simulator?"). Passing the real udid also
  // lets the pane claim it for this workspace, so its mount logic has something
  // to show instead of falling through to onNothingToShow.
  const revealSim = (udid: string): void => {
    broadcastToWindows('app:open-simulator', {
      workspaceId: workspaceIdFromPane(PANE_ID),
      udid
    })
  }

  const inputTarget = async (): Promise<{ udid: string } | { error: string }> => {
    const t = simTarget()
    if (t && t !== 'booted') {
      revealSim(t)
      return { udid: t }
    }
    const out = await simctl(['list', 'devices', 'booted', '--json'])
    const data = JSON.parse(out) as { devices: Record<string, { udid: string; state: string }[]> }
    const booted = Object.values(data.devices)
      .flat()
      .filter((d) => d.state === 'Booted')
    if (booted.length === 1) {
      revealSim(booted[0].udid)
      return { udid: booted[0].udid }
    }
    if (booted.length === 0)
      return { error: 'No simulator is booted. Boot one with sim_boot first.' }
    return {
      error:
        'Several simulators are booted — open the one you mean in the pane (sim_boot) so it is the target.'
    }
  }

  const grabScreen = async (): Promise<{ buf: Buffer; w: number; h: number }> => {
    const file = `${tmpdir()}/sim-${Date.now()}.png`
    await simctl(['io', simTarget(), 'screenshot', file])
    try {
      const buf = readFileSync(file)
      const size = nativeImage.createFromPath(file).getSize()
      screenSize.set(simTarget(), { w: size.width, h: size.height })
      return { buf, w: size.width, h: size.height }
    } finally {
      // A throwaway — the bytes are returned inline. Without this, every screen
      // read (each sim_tap/swipe via sizeFor, and sim_wait_stable's poll loop)
      // left a multi-hundred-KB PNG in /tmp for the life of the run.
      try {
        unlinkSync(file)
      } catch {
        /* already gone / never written */
      }
    }
  }

  const sizeFor = async (): Promise<{ w: number; h: number }> => {
    const known = screenSize.get(simTarget())
    if (known) return known
    const { w, h } = await grabScreen()
    return { w, h }
  }

  server.registerTool(
    'sim_screen',
    {
      description:
        'See the iOS Simulator: returns the current screen as an image, and its pixel size. This is how you read the device — there is no DOM, so look at the picture. Tap and swipe coordinates are in these pixels: the top-left is 0,0 and the numbers you read off this image are the numbers you pass to sim_tap/sim_swipe.',
      inputSchema: {}
    },
    async () => {
      // Reveal the pane if it is not already up (inputTarget carries the reveal
      // when exactly one device is booted); reading the screen is reason enough
      // to show the user what the agent is looking at.
      await inputTarget()
      const { buf, w, h } = await grabScreen()
      return {
        content: [
          {
            type: 'text',
            text: `iOS Simulator screen — ${w}x${h} pixels. Tap/swipe in these coordinates.`
          },
          { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }
        ]
      }
    }
  )

  server.registerTool(
    'sim_tap',
    {
      description:
        'Tap the simulator at a point, in the pixel coordinates of sim_screen. Give a duration (seconds) for a long press — how you get context menus, app wobble, or a held control.',
      inputSchema: {
        x: z.number().describe('X in screen pixels (from sim_screen)'),
        y: z.number().describe('Y in screen pixels'),
        duration: z.number().optional().describe('Seconds to hold, for a long press')
      }
    },
    async ({ x, y, duration }) => {
      const tgt = await inputTarget()
      if ('error' in tgt) return { content: [{ type: 'text', text: tgt.error }] }
      const { w, h } = await sizeFor()
      const res = await sendSimInput(tgt.udid, {
        type: 'tap',
        x,
        y,
        width: w,
        height: h,
        ...(duration ? { duration } : {})
      })
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `Tapped ${Math.round(x)},${Math.round(y)}${duration ? ` (held ${duration}s)` : ''}. Call sim_screen to see the result.`
              : `Tap failed: ${res.error}`
          }
        ]
      }
    }
  )

  server.registerTool(
    'sim_swipe',
    {
      description:
        'Swipe or drag on the simulator, from one point to another in sim_screen pixels. Use it to scroll (swipe up/down), page (left/right), or drag something — a longer duration is a slow drag, a short one is a flick.',
      inputSchema: {
        x: z.number(),
        y: z.number(),
        toX: z.number(),
        toY: z.number(),
        duration: z.number().optional().describe('Seconds; short = flick, longer = slow drag')
      }
    },
    async ({ x, y, toX, toY, duration }) => {
      const tgt = await inputTarget()
      if ('error' in tgt) return { content: [{ type: 'text', text: tgt.error }] }
      const { w, h } = await sizeFor()
      const res = await sendSimInput(tgt.udid, {
        type: 'swipe',
        x,
        y,
        toX,
        toY,
        width: w,
        height: h,
        ...(duration ? { duration } : {})
      })
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `Swiped ${Math.round(x)},${Math.round(y)} → ${Math.round(toX)},${Math.round(toY)}. Call sim_screen to see the result.`
              : `Swipe failed: ${res.error}`
          }
        ]
      }
    }
  )

  server.registerTool(
    'sim_type',
    {
      description:
        'Type text into the simulator. Tap the field first so it has focus, exactly as you would on the device.',
      inputSchema: { text: z.string() }
    },
    async ({ text }) => {
      const tgt = await inputTarget()
      if ('error' in tgt) return { content: [{ type: 'text', text: tgt.error }] }
      const res = await sendSimInput(tgt.udid, { type: 'text', text })
      return {
        content: [{ type: 'text', text: res.ok ? `Typed "${text}".` : `Type failed: ${res.error}` }]
      }
    }
  )

  server.registerTool(
    'sim_press',
    {
      description:
        'Press a hardware button on the simulator: home, lock, or the side button. Home returns to the springboard; lock sleeps/wakes the screen.',
      inputSchema: { button: z.enum(['home', 'lock', 'side']) }
    },
    async ({ button }) => {
      const tgt = await inputTarget()
      if ('error' in tgt) return { content: [{ type: 'text', text: tgt.error }] }
      const res = await sendSimInput(tgt.udid, { type: 'press', button })
      return {
        content: [
          { type: 'text', text: res.ok ? `Pressed ${button}.` : `Press failed: ${res.error}` }
        ]
      }
    }
  )

  server.registerTool(
    'sim_wait_stable',
    {
      description:
        'Wait until the simulator screen stops changing — a load or an animation has settled — then return. Use it after a tap that starts something, so the next step is not a race. There is no text-matching wait here (the screen is pixels, not a DOM); when it returns, take a sim_screen and read what is there.',
      inputSchema: {
        timeoutMs: z.number().optional().describe('Give up after this long (default 8000)')
      }
    },
    async ({ timeoutMs }) => {
      await inputTarget() // reveal the pane once, not on every poll below
      const deadline = Date.now() + (timeoutMs ?? 8000)
      // "Settled" = two consecutive shots almost identical. Compared on a cheap
      // downscale so a single moving pixel does not read as motion.
      const thumb = (buf: Buffer): Buffer =>
        nativeImage.createFromBuffer(buf).resize({ width: 32 }).toBitmap()
      const diff = (a: Buffer, b: Buffer): number => {
        if (a.length !== b.length || !a.length) return 1
        let d = 0
        for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 12) d++
        return d / (a.length / 4)
      }
      let prev = thumb((await grabScreen()).buf)
      let stableFor = 0
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 350))
        const now = thumb((await grabScreen()).buf)
        if (diff(prev, now) < 0.02) {
          stableFor += 1
          // Two quiet checks in a row: a slow animation gets a moment to prove
          // it is actually done rather than mid-frame.
          if (stableFor >= 2) return { content: [{ type: 'text', text: 'Screen settled.' }] }
        } else {
          stableFor = 0
        }
        prev = now
      }
      return { content: [{ type: 'text', text: 'Still changing when the wait timed out.' }] }
    }
  )

  server.registerTool(
    'browser_navigate',
    {
      description:
        "Open a URL in SuperAgent's browser pane (visible to the user). Bare hosts get https://, localhost gets http://.",
      inputSchema: { url: z.string() }
    },
    async ({ url }) => ({
      content: [{ type: 'text', text: `Now at ${await auto.navigate(browserPane(), url)}` }]
    })
  )

  server.registerTool(
    'open_file',
    {
      description:
        'Show a file to the user inside SuperAgent — text/markdown/code open in the in-app viewer, PDFs and images preview in the pane. ALWAYS prefer this over the shell `open`/`xdg-open` command for any file the user should see; it keeps them in the app instead of a separate OS window.',
      inputSchema: { path: z.string().describe('Absolute or workspace-relative path to the file') }
    },
    async ({ path }) => {
      const ws = workspaceIdFromPane(PANE_ID)
      let abs = path.startsWith('~') ? join(homedir(), path.slice(1)) : path
      if (!isAbsolute(abs)) {
        const root = getWorkspacePath(ws)
        abs = root ? resolve(root, abs) : resolve(abs)
      }
      await openFileInApp(ws, abs)
      return { content: [{ type: 'text', text: `Opened ${abs} in SuperAgent.` }] }
    }
  )

  server.registerTool(
    'clone_repo',
    {
      description:
        "Clone a git repository and add it to SuperAgent as a project, so it appears in the sidebar and the user can chat with it immediately. Use this when the user asks to clone / pull / open a repo (e.g. a GitHub URL). Prefer this over a bare `git clone` in the shell — that leaves files on disk that never become a project. Private repos need the user's git credentials to already be set up; if the clone fails for auth, say so.",
      inputSchema: {
        url: z
          .string()
          .describe('The repository URL (https or ssh), e.g. https://github.com/owner/repo'),
        name: z
          .string()
          .optional()
          .describe('Project name to show in the sidebar; defaults to the repo name')
      }
    },
    async ({ url, name }) => {
      // A predictable home for cloned projects, created on first use.
      const base = join(homedir(), 'SuperAgent Projects')
      mkdirSync(base, { recursive: true })
      // Folder name from the repo, de-duped so a second clone doesn't collide.
      const repo = (basename(url).replace(/\.git$/i, '') || 'repo').replace(/[^\w.-]/g, '-')
      let dir = join(base, repo)
      for (let i = 2; existsSync(dir); i++) dir = join(base, `${repo}-${i}`)
      const clone = await new Promise<{ ok: boolean; out: string }>((res) =>
        execFile(
          'git',
          ['clone', '--progress', url, dir],
          { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => res({ ok: !err, out: (stdout || '') + (stderr || '') })
        )
      )
      if (!clone.ok) {
        const auth = /authentication|permission denied|could not read|403|fatal: repository/i.test(
          clone.out
        )
        return {
          content: [
            {
              type: 'text',
              text: auth
                ? `Clone failed — this looks like an auth/access problem (private repo or no git credentials): ${clone.out.trim().slice(-300)}`
                : `Clone failed: ${clone.out.trim().slice(-300)}`
            }
          ]
        }
      }
      const wsId = addProjectWorkspace(name?.trim() || repo, dir)
      // Refresh the sidebar and jump to the new project so it's ready to use.
      broadcastToWindows('projects:changed', { activate: wsId })
      return {
        content: [
          {
            type: 'text',
            text: `Cloned into ${dir} and added it as a project. It's open in the sidebar now.`
          }
        ]
      }
    }
  )

  server.registerTool(
    'browser_read_page',
    {
      description:
        'Read the current page: url, title, visible text, and a numbered list of interactive elements. Use the numbers with browser_click. Prefer this over screenshots — it is cheaper and clickable.',
      inputSchema: {}
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(await auto.readPage(browserPane())) }]
    })
  )

  server.registerTool(
    'browser_click',
    {
      description:
        'Click an element: pass index (from browser_read_page) or text (visible label — more reliable if the page changed since the last read).',
      inputSchema: { index: z.number().optional(), text: z.string().optional() }
    },
    async ({ index, text }) => ({
      content: [{ type: 'text', text: await auto.click(browserPane(), { index, text }) }]
    })
  )

  server.registerTool(
    'browser_type',
    {
      description: 'Type text into the focused element (click an input first).',
      inputSchema: { text: z.string() }
    },
    async ({ text }) => ({
      content: [{ type: 'text', text: await auto.typeText(browserPane(), text) }]
    })
  )

  server.registerTool(
    'browser_press_key',
    {
      description: 'Press a key: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown.',
      inputSchema: { key: z.string() }
    },
    async ({ key }) => ({
      content: [{ type: 'text', text: await auto.pressKey(browserPane(), key) }]
    })
  )

  server.registerTool(
    'browser_screenshot',
    {
      description:
        'Screenshot the browser pane. Use for visual checks; use browser_read_page for structure and clicking.',
      inputSchema: {}
    },
    async () => ({
      content: [
        { type: 'image', data: await auto.screenshot(browserPane()), mimeType: 'image/png' }
      ]
    })
  )

  server.registerTool(
    'browser_console',
    {
      description: 'Recent console messages from the page, errors first.',
      inputSchema: {}
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(auto.consoleLogs(browserPane())) }]
    })
  )

  server.registerTool(
    'browser_wait_for',
    {
      description: 'Wait until the given text appears on the page (max 15s).',
      inputSchema: { text: z.string(), timeoutMs: z.number().optional() }
    },
    async ({ text, timeoutMs }) => ({
      content: [{ type: 'text', text: await auto.waitFor(browserPane(), text, timeoutMs ?? 10000) }]
    })
  )

  server.registerTool(
    'browser_evaluate',
    {
      description:
        'Evaluate a JavaScript expression in the page and return the JSON result. Example: "document.title" or "document.querySelectorAll(\'.item\').length".',
      inputSchema: { expression: z.string() }
    },
    async ({ expression }) => ({
      content: [{ type: 'text', text: await auto.evaluate(browserPane(), expression) }]
    })
  )

  server.registerTool(
    'browser_network',
    {
      description:
        'Recent network requests, failed and error-status ones first. Good for finding broken API calls.',
      inputSchema: {}
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(auto.network(browserPane())) }] })
  )

  server.registerTool(
    'create_routine',
    {
      description:
        'Schedule a recurring task for this project (e.g. "check the homepage loads"). Store the user\'s own wording as the prompt, minus the recurrence phrase. Minimum interval is 60 minutes — if the user asks for less, tell them you are using 60 and continue. Routines only run while SuperAgent is open.',
      inputSchema: {
        prompt: z.string().describe("The task to run each time, in the user's own words"),
        intervalMinutes: z.number().describe('How often to run, in minutes (min 60)')
      }
    },
    async ({ prompt, intervalMinutes }) => {
      // Strip the "::routine" suffix so routine-launched sessions map to the real workspace.
      const res = createRoutineForWorkspace(workspaceIdFromPane(PANE_ID), prompt, intervalMinutes)
      return { content: [{ type: 'text', text: res.message }] }
    }
  )

  /**
   * Who did this. A card is far more useful if it can take you back to the
   * conversation that raised it, and to the branch the work happened on — the
   * chat comes from the MCP URL this agent was configured with, the branch is
   * read at the moment the card is touched.
   */
  const stamp = (ws: string): { chatId: string | null; branch: string | null } => {
    const dir = getWorkspacePath(ws)
    return { chatId: CHAT_ID, branch: dir ? gitBranch(dir) : null }
  }

  server.registerTool(
    'board_list',
    {
      description:
        "List this project's work: every item with its id, stage and title. Read this before adding one so you don't duplicate something already there, and to get ids for board_move and board_update. The stages are todo, doing, testing and done.",
      inputSchema: {}
    },
    async () => {
      const cards = listCards(workspaceIdFromPane(PANE_ID)).map((c) => ({
        id: c.id,
        status: c.status,
        title: c.title,
        body: c.body || undefined,
        branch: c.branch || undefined,
        tags: c.tags.length ? c.tags : undefined
      }))
      return {
        content: [
          {
            type: 'text',
            text: cards.length
              ? JSON.stringify(cards, null, 2)
              : 'The board is empty. Add cards with board_add.'
          }
        ]
      }
    }
  )

  server.registerTool(
    'board_add',
    {
      description:
        "Add a card to this project's board. Use it when work is identified but not done yet — something the user asked for and you deferred, a follow-up your change made necessary, a bug you noticed in passing. Do not add a card for work you are finishing right now in this turn.",
      inputSchema: {
        title: z.string().describe('One line, imperative — what needs doing'),
        body: z.string().optional().describe('Detail worth keeping: why, or where to start'),
        status: z
          .string()
          .optional()
          .describe(
            'todo (default), doing, testing or done. Near-misses like "in progress", "QA" or "completed" are understood.'
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Free-form labels for the item — e.g. "bug", "P1", "ios", "backend". Whatever grouping helps; make them up as needed.'
          )
      }
    },
    async ({ title, body, status, tags }) => {
      const ws = workspaceIdFromPane(PANE_ID)
      // A blank card is a blank box on the board with no way to tell what it
      // was for — better to say so than to write one.
      if (!title.trim()) {
        return { content: [{ type: 'text', text: 'A card needs a title.' }] }
      }
      const card = addCard(ws, title, { body, status, tags, ...stamp(ws) })
      broadcastToWindows('board:changed', { workspaceId: ws })
      return {
        content: [{ type: 'text', text: `Added "${card.title}" to ${card.status} (${card.id}).` }]
      }
    }
  )

  server.registerTool(
    'board_move',
    {
      description:
        'Move a card to another column (get ids from board_list). Move a card to doing when you start it and done when you finish, so the board reflects what actually happened rather than what was planned.',
      inputSchema: {
        id: z.string().describe('The card id, as returned by board_list'),
        status: z
          .string()
          .describe(
            'todo, doing, testing or done. Near-misses like "in progress", "QA" or "completed" are understood.'
          )
      }
    },
    async ({ id, status }) => {
      const ws = workspaceIdFromPane(PANE_ID)
      // Scope safety: an agent in one project must not be able to move another
      // project's cards, so only ids on this board are addressable.
      if (!listCards(ws).some((c) => c.id === id)) {
        return { content: [{ type: 'text', text: `No card with id ${id} on this board.` }] }
      }
      const card = moveCard(id, status, null)
      // Whoever moved it last is who you'd want to ask about it.
      updateCard(id, stamp(ws))
      broadcastToWindows('board:changed', { workspaceId: ws })
      return { content: [{ type: 'text', text: `Moved "${card?.title}" to ${card?.status}.` }] }
    }
  )

  server.registerTool(
    'board_update',
    {
      description:
        "Rewrite an item's title or detail, or delete it (get ids from board_list). Use this to keep the list clear: sharpen a vague title into a specific one, and put a short specification in the body — what done means, where to start, which files. Delete an item that turned out to be unnecessary or a duplicate; otherwise prefer board_move to done, which keeps the record of what was finished.",
      inputSchema: {
        id: z.string().describe('The card id, as returned by board_list'),
        title: z.string().optional(),
        body: z.string().optional(),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Replace the item\'s labels with these — e.g. ["bug","P1"]. Pass [] to clear them. Free-form; invent whatever grouping helps.'
          ),
        remove: z.boolean().optional().describe('Delete the card instead of editing it')
      }
    },
    async ({ id, title, body, tags, remove }) => {
      const ws = workspaceIdFromPane(PANE_ID)
      if (!listCards(ws).some((c) => c.id === id)) {
        return { content: [{ type: 'text', text: `No card with id ${id} on this board.` }] }
      }
      if (remove) {
        removeCard(id)
        broadcastToWindows('board:changed', { workspaceId: ws })
        return { content: [{ type: 'text', text: `Deleted card ${id}.` }] }
      }
      if (title !== undefined && !title.trim()) {
        return { content: [{ type: 'text', text: 'A card needs a title.' }] }
      }
      const card = updateCard(id, { title, body, tags })
      broadcastToWindows('board:changed', { workspaceId: ws })
      return { content: [{ type: 'text', text: `Updated "${card?.title}".` }] }
    }
  )

  server.registerTool(
    'list_routines',
    {
      description:
        "List this project's scheduled routines (id, prompt, how often it runs, whether it's enabled). Call this before create_routine to avoid making a duplicate, and to get the id to pass to delete_routine.",
      inputSchema: {}
    },
    async () => {
      const rs = listRoutines(workspaceIdFromPane(PANE_ID)).map((r) => ({
        id: r.id,
        prompt: r.prompt,
        everyMinutes: Math.round(r.intervalMs / 60000),
        enabled: r.enabled === 1,
        lastRun: r.lastRunStatus ?? 'never'
      }))
      return {
        content: [
          {
            type: 'text',
            text: rs.length ? JSON.stringify(rs, null, 2) : 'No routines for this project yet.'
          }
        ]
      }
    }
  )

  server.registerTool(
    'delete_routine',
    {
      description:
        "Delete one of this project's routines by id (get ids from list_routines). Use this to remove a routine the user no longer wants, or to replace an old routine before creating a new one.",
      inputSchema: {
        id: z.string().describe('The routine id, as returned by list_routines')
      }
    },
    async ({ id }) => {
      // Scope safety: only delete a routine that belongs to THIS workspace, so an
      // agent in one project can never remove another project's routines.
      const owned = listRoutines(workspaceIdFromPane(PANE_ID)).some((r) => r.id === id)
      if (!owned) {
        return { content: [{ type: 'text', text: `No routine with id ${id} in this project.` }] }
      }
      deleteRoutine(id)
      broadcastToWindows('routines:changed')
      return { content: [{ type: 'text', text: `Deleted routine ${id}.` }] }
    }
  )

  // --- The Computer -------------------------------------------------------
  // Only for the desktop's own chat: these drive the desktop itself, which a
  // project's agent has no business rearranging.
  if (isDesktop) {
    const APP = z.enum(['chat', 'browser', 'dashboard', 'skills', 'routines'])
    const command = (kind: string, payload: Record<string, unknown> = {}): void =>
      broadcastToWindows('desktop:command', { kind, ...payload })

    server.registerTool(
      'computer_state',
      {
        description:
          'What is on the desktop right now: every open window with its position and size, which one is in front, the browser tabs and which is showing, and the files sitting on the desktop. Read this before arranging anything, and whenever the user refers to "this window", "the browser" or "that file" — it is what they can see.',
        inputSchema: {}
      },
      async () => ({ content: [{ type: 'text', text: describeDesktop() }] })
    )

    server.registerTool(
      'computer_open_app',
      {
        description:
          "Open an application on the desktop, or bring it forward if it is already open. Chat is this conversation, Browser is a tabbed web browser, Dashboard is the user's usage and activity, Skills and Routines belong to whichever project is selected.",
        inputSchema: { app: APP }
      },
      async ({ app }) => {
        command('open', { app })
        return { content: [{ type: 'text', text: `Opened ${app}.` }] }
      }
    )

    server.registerTool(
      'computer_close_app',
      {
        description:
          'Close an application window on the desktop. Do not close chat — that is this conversation, and closing it ends the session you are talking through.',
        inputSchema: { app: APP }
      },
      async ({ app }) => {
        // Closing the chat window kills the session running this very tool
        // call, so the answer never arrives and the user is left looking at a
        // desktop wondering what happened.
        if (app === 'chat') {
          return {
            content: [
              {
                type: 'text',
                text: 'Not closing Chat — this conversation runs in that window. Ask the user to close it themselves if that is really what they want.'
              }
            ]
          }
        }
        command('close', { app })
        return { content: [{ type: 'text', text: `Closed ${app}.` }] }
      }
    )

    server.registerTool(
      'computer_arrange',
      {
        description:
          "Move or resize a window. Use a position for the ordinary cases — left and right tile it against one half of the desktop, full fills it, center puts it in the middle at a comfortable size, minimise puts it away — or give an explicit x, y, width and height in desktop pixels (computer_state reports the desktop's size). The window is brought to the front either way.",
        inputSchema: {
          app: APP,
          position: z
            .enum(['left', 'right', 'top', 'bottom', 'full', 'center', 'minimize'])
            .optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional()
        }
      },
      async ({ app, position, x, y, width, height }) => {
        const open = desktopState().windows.some((w) => w.app === app)
        if (!open) {
          return {
            content: [{ type: 'text', text: `${app} is not open — call computer_open_app first.` }]
          }
        }
        if (
          !position &&
          x === undefined &&
          y === undefined &&
          width === undefined &&
          height === undefined
        ) {
          return {
            content: [{ type: 'text', text: 'Give a position, or a rectangle to move it to.' }]
          }
        }
        command('arrange', { app, position, x, y, width, height })
        return {
          content: [{ type: 'text', text: `Moved ${app}${position ? ` to the ${position}` : ''}.` }]
        }
      }
    )

    server.registerTool(
      'computer_desktop_file',
      {
        description:
          'Put a file on the desktop, or take one off it. Files on the desktop are linked into your working directory under ./files/, so putting one there is how you hand the user something they can double-click — and how anything they dropped became readable to you.',
        inputSchema: {
          path: z.string().describe('Absolute path to the file'),
          remove: z.boolean().optional().describe('Take it off the desktop instead of adding it')
        }
      },
      async ({ path, remove }) => {
        const abs = path.startsWith('~') ? join(homedir(), path.slice(1)) : resolve(path)
        // An icon for a file that is not there is a dead icon: it links to
        // nothing, opens nothing, and the user has to work out why themselves.
        if (!remove && !existsSync(abs)) {
          return { content: [{ type: 'text', text: `There is no file at ${abs}.` }] }
        }
        command(remove ? 'remove-file' : 'add-file', { path: abs })
        return {
          content: [
            {
              type: 'text',
              text: remove ? `Took ${abs} off the desktop.` : `Put ${abs} on the desktop.`
            }
          ]
        }
      }
    )

    server.registerTool(
      'computer_browser_open',
      {
        description:
          'Open a URL in the desktop Browser — in the tab in front, or in a new one. This opens the Browser app if it is closed. Afterwards the browser_* tools (browser_read_page, browser_click, browser_type, …) act on the tab that is showing.',
        inputSchema: {
          url: z.string(),
          newTab: z
            .boolean()
            .optional()
            .describe('Open it in a new tab rather than the current one')
        }
      },
      async ({ url, newTab }) => {
        command('browser', { url, newTab: newTab ?? false })
        // The tab has to exist before it can be navigated, and both happen in
        // the renderer — wait for it rather than reporting a page that is not
        // loading yet.
        await new Promise((r) => setTimeout(r, 700))
        return { content: [{ type: 'text', text: `Opening ${url} in the desktop browser.` }] }
      }
    )
  }

  return server
}

export function startMcpServer(): Promise<{ url: string }> {
  secret = randomBytes(16).toString('hex')
  const path = `/mcp/${secret}`

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith(path)) {
      res.writeHead(404).end()
      return
    }
    try {
      // Scope tools to the workspace named in ?ws=<id> (always present — see writeWorkspaceMcpConfig).
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const paneId = params.get('ws')
      // Present when the session belongs to a chat; absent for routines, which
      // have no conversation to point a card back at.
      const chatId = params.get('chat')
      if (!paneId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing ws param' }))
        return
      }
      // Stateless mode: fresh server+transport per request, no session tracking.
      const server = buildServer(paneId, chatId)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close()
        server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, await readJsonBody(req))
    } catch (err) {
      console.error('[mcp] request failed:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    }
  })

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      const url = `http://127.0.0.1:${port}${path}`
      console.log(`[mcp] cove-browser listening at ${url}`)
      resolve({ url })
    })
  })
}

export function getMcpUrl(): string {
  return port ? `http://127.0.0.1:${port}/mcp/${secret}` : ''
}

/**
 * Write a per-workspace MCP config file and return its path.
 * The URL carries ?ws=<id> so tool calls hit this workspace's browser pane.
 */
export function writeWorkspaceMcpConfig(workspaceId: string, chatId?: string): string {
  // ?chat=<id> is what lets a board card name the conversation that raised it,
  // so the config is per-chat when there is one.
  const url =
    `${getMcpUrl()}?ws=${encodeURIComponent(workspaceId)}` +
    (chatId ? `&chat=${encodeURIComponent(chatId)}` : '')
  const configPath = join(
    app.getPath('userData'),
    chatId ? `mcp-${workspaceId}-${chatId}.json` : `mcp-${workspaceId}.json`
  )
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { 'cove-browser': { type: 'http', url } } })
  )
  return configPath
}
