import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as auto from './automation'
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
import { getWorkspacePath } from './store'
import { readJsonBody, workspaceIdFromPane, broadcastToWindows } from './util'
import { isAbsolute, resolve } from 'path'
import { homedir } from 'os'

let port = 0
let secret = ''

function buildServer(paneId: string): McpServer {
  const PANE_ID = paneId
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
        'List iOS Simulator devices (name, UDID, state). Use before booting or targeting a device.',
      inputSchema: {}
    },
    async () => {
      const out = await simctl(['list', 'devices', 'available', '--json'])
      const data = JSON.parse(out) as { devices: Record<string, { name: string; udid: string; state: string }[]> }
      const lines: string[] = []
      for (const [runtime, devs] of Object.entries(data.devices)) {
        for (const d of devs) lines.push(`${d.name} — ${d.state} — ${d.udid} (${runtime.split('.').pop()})`)
      }
      return { content: [{ type: 'text', text: lines.join('\n') || 'No simulators available.' }] }
    }
  )

  server.registerTool(
    'sim_boot',
    {
      description:
        'Boot an iOS Simulator by UDID (from sim_list_devices) and open the Simulator app so the user can see it.',
      inputSchema: { udid: z.string() }
    },
    async ({ udid }) => {
      await simctl(['boot', udid]).catch((e) => {
        if (!String(e).includes('current state: Booted')) throw e
      })
      execFile('open', ['-a', 'Simulator', '--background'], () => {})
      return { content: [{ type: 'text', text: `Booted ${udid}.` }] }
    }
  )

  server.registerTool(
    'sim_screenshot',
    {
      description:
        "Screenshot the booted iOS Simulator and show it to the user in SuperAgent's viewer. Returns the PNG path.",
      inputSchema: {}
    },
    async () => {
      const file = `${tmpdir()}/sim-${Date.now()}.png`
      await simctl(['io', 'booted', 'screenshot', file])
      const ws = workspaceIdFromPane(PANE_ID)
      broadcastToWindows('app:open-file', { workspaceId: ws, path: file })
      return { content: [{ type: 'text', text: `Simulator screenshot saved to ${file} and opened in SuperAgent.` }] }
    }
  )

  server.registerTool(
    'sim_open_url',
    {
      description: 'Open a URL in the booted iOS Simulator (deep links and web URLs).',
      inputSchema: { url: z.string() }
    },
    async ({ url }) => {
      await simctl(['openurl', 'booted', url])
      return { content: [{ type: 'text', text: `Opened ${url} in the simulator.` }] }
    }
  )

  server.registerTool(
    'sim_install_and_launch',
    {
      description:
        'Install a .app bundle onto the booted simulator and launch it by bundle id.',
      inputSchema: { appPath: z.string(), bundleId: z.string() }
    },
    async ({ appPath, bundleId }) => {
      await simctl(['install', 'booted', appPath])
      const out = await simctl(['launch', 'booted', bundleId])
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
      const paneId = new URL(req.url, 'http://127.0.0.1').searchParams.get('ws')
      if (!paneId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing ws param' }))
        return
      }
      // Stateless mode: fresh server+transport per request, no session tracking.
      const server = buildServer(paneId)
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
export function writeWorkspaceMcpConfig(workspaceId: string): string {
  const url = `${getMcpUrl()}?ws=${encodeURIComponent(workspaceId)}`
  const configPath = join(app.getPath('userData'), `mcp-${workspaceId}.json`)
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { 'cove-browser': { type: 'http', url } } })
  )
  return configPath
}
