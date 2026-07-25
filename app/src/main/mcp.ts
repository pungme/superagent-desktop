import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as auto from './automation'

/**
 * Cove's browser-automation MCP server.
 * HTTP transport on 127.0.0.1 with a per-launch secret in the path.
 * Sessions launched by Cove get the URL via --mcp-config / env.
 *
 * v0: single "spike" pane. M4 scopes tool calls to the calling session's workspace.
 */

const PANE_ID = 'spike'
let port = 0
let secret = ''

function buildServer(): McpServer {
  const server = new McpServer({ name: 'cove-browser', version: '0.1.0' })

  server.registerTool(
    'browser_navigate',
    {
      description:
        "Open a URL in Cove's browser pane (visible to the user). Bare hosts get https://, localhost gets http://.",
      inputSchema: { url: z.string() }
    },
    async ({ url }) => ({
      content: [{ type: 'text', text: `Now at ${await auto.navigate(PANE_ID, url)}` }]
    })
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

  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
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
      // Stateless mode: fresh server+transport per request, no session tracking.
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close()
        server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, await readBody(req))
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
