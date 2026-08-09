import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as auto from './automation'
import { simTarget, isMirroring, keepSimulatorHidden } from './simulator'
import { execFile } from 'child_process'
import { tmpdir } from 'os'

/**
 * SuperAgent's browser-automation MCP server.
 * HTTP transport on 127.0.0.1 with a per-launch secret in the path.
 * Each SuperAgent-launched claude session gets a config whose URL carries ?ws=<id>,
 * so tool calls are scoped to that session's own workspace browser pane.
 */

import { app } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { createRoutineForWorkspace, listRoutines, deleteRoutine } from './routines'
import { getWorkspacePath, listCards, addCard, updateCard, moveCard, removeCard } from './store'
import { gitBranch } from './files'
import { readJsonBody, workspaceIdFromPane, broadcastToWindows } from './util'
import { isAbsolute, resolve } from 'path'
import { homedir } from 'os'

let port = 0
let secret = ''

function buildServer(paneId: string, chatId: string | null): McpServer {
  const PANE_ID = paneId
  const CHAT_ID = chatId
  const server = new McpServer({ name: 'cove-browser', version: '0.1.0' })

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
      const data = JSON.parse(out) as { devices: Record<string, { name: string; udid: string; state: string }[]> }
      const lines: string[] = []
      for (const [runtime, devs] of Object.entries(data.devices)) {
        for (const d of devs) {
          const watched = d.udid === simTarget() ? '  <-- SHOWN IN THE PANE' : ''
          lines.push(
            `${d.name} — ${d.state} — ${d.udid} (${runtime.split('.').pop()})${watched}`
          )
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
        "Screenshot the iOS Simulator the user is watching and return the PNG path. If the pane is already mirroring that device live, the still is not opened — the user can see it already.",
      inputSchema: {}
    },
    async () => {
      const file = `${tmpdir()}/sim-${Date.now()}.png`
      await simctl(['io', simTarget(), 'screenshot', file])
      const ws = workspaceIdFromPane(PANE_ID)
      // If the pane is already mirroring this device the user is looking at it
      // live; opening the still as a file would take over the working surface
      // and leave two views of the same phone side by side.
      const live = isMirroring(simTarget())
      if (!live) broadcastToWindows('app:open-file', { workspaceId: ws, path: file })
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
      await simctl(['openurl', simTarget(), url])
      return { content: [{ type: 'text', text: `Opened ${url} in the simulator.` }] }
    }
  )

  server.registerTool(
    'sim_install_and_launch',
    {
      description:
        "Install a .app bundle and launch it by bundle id on the simulator the user is watching in the pane. Prefer this over running `simctl install/launch` yourself — a bare `booted` picks an arbitrary device when several are running, and the app then opens where nobody can see it.",
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

  server.registerTool(
    'browser_navigate',
    {
      description:
        "Open a URL in SuperAgent's browser pane (visible to the user). Bare hosts get https://, localhost gets http://.",
      inputSchema: { url: z.string() }
    },
    async ({ url }) => ({
      content: [{ type: 'text', text: `Now at ${await auto.navigate(PANE_ID, url)}` }]
    })
  )

  server.registerTool(
    'open_file',
    {
      description:
        "Show a file to the user inside SuperAgent — text/markdown/code open in the in-app viewer, PDFs and images preview in the pane. ALWAYS prefer this over the shell `open`/`xdg-open` command for any file the user should see; it keeps them in the app instead of a separate OS window.",
      inputSchema: { path: z.string().describe('Absolute or workspace-relative path to the file') }
    },
    async ({ path }) => {
      const ws = workspaceIdFromPane(PANE_ID)
      let abs = path.startsWith('~') ? join(homedir(), path.slice(1)) : path
      if (!isAbsolute(abs)) {
        const root = getWorkspacePath(ws)
        abs = root ? resolve(root, abs) : resolve(abs)
      }
      broadcastToWindows('app:open-file', { workspaceId: ws, path: abs })
      return { content: [{ type: 'text', text: `Opened ${abs} in SuperAgent.` }] }
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
      content: [{ type: 'text', text: JSON.stringify(await auto.readPage(PANE_ID)) }]
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
      content: [{ type: 'text', text: await auto.click(PANE_ID, { index, text }) }]
    })
  )

  server.registerTool(
    'browser_type',
    {
      description: 'Type text into the focused element (click an input first).',
      inputSchema: { text: z.string() }
    },
    async ({ text }) => ({ content: [{ type: 'text', text: await auto.typeText(PANE_ID, text) }] })
  )

  server.registerTool(
    'browser_press_key',
    {
      description: 'Press a key: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown.',
      inputSchema: { key: z.string() }
    },
    async ({ key }) => ({ content: [{ type: 'text', text: await auto.pressKey(PANE_ID, key) }] })
  )

  server.registerTool(
    'browser_screenshot',
    {
      description:
        'Screenshot the browser pane. Use for visual checks; use browser_read_page for structure and clicking.',
      inputSchema: {}
    },
    async () => ({
      content: [{ type: 'image', data: await auto.screenshot(PANE_ID), mimeType: 'image/png' }]
    })
  )

  server.registerTool(
    'browser_console',
    {
      description: 'Recent console messages from the page, errors first.',
      inputSchema: {}
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(auto.consoleLogs(PANE_ID)) }]
    })
  )

  server.registerTool(
    'browser_wait_for',
    {
      description: 'Wait until the given text appears on the page (max 15s).',
      inputSchema: { text: z.string(), timeoutMs: z.number().optional() }
    },
    async ({ text, timeoutMs }) => ({
      content: [{ type: 'text', text: await auto.waitFor(PANE_ID, text, timeoutMs ?? 10000) }]
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
      content: [{ type: 'text', text: await auto.evaluate(PANE_ID, expression) }]
    })
  )

  server.registerTool(
    'browser_network',
    {
      description:
        'Recent network requests, failed and error-status ones first. Good for finding broken API calls.',
      inputSchema: {}
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(auto.network(PANE_ID)) }] })
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
        branch: c.branch || undefined
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
          )
      }
    },
    async ({ title, body, status }) => {
      const ws = workspaceIdFromPane(PANE_ID)
      // A blank card is a blank box on the board with no way to tell what it
      // was for — better to say so than to write one.
      if (!title.trim()) {
        return { content: [{ type: 'text', text: 'A card needs a title.' }] }
      }
      const card = addCard(ws, title, { body, status, ...stamp(ws) })
      broadcastToWindows('board:changed', { workspaceId: ws })
      return { content: [{ type: 'text', text: `Added "${card.title}" to ${card.status} (${card.id}).` }] }
    }
  )

  server.registerTool(
    'board_move',
    {
      description:
        "Move a card to another column (get ids from board_list). Move a card to doing when you start it and done when you finish, so the board reflects what actually happened rather than what was planned.",
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
        remove: z.boolean().optional().describe('Delete the card instead of editing it')
      }
    },
    async ({ id, title, body, remove }) => {
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
      const card = updateCard(id, { title, body })
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
        'Delete one of this project\'s routines by id (get ids from list_routines). Use this to remove a routine the user no longer wants, or to replace an old routine before creating a new one.',
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
