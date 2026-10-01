import { describe, it, expect, vi, afterAll } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { deflateSync } from 'zlib'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

/**
 * The Antigravity backend against the real `agy` binary.
 *
 * Everything else about Antigravity is tested on documented and recorded
 * shapes, which cannot tell you that the protocol still works — only that our
 * reading of it is self-consistent. This drives an actual `agy`, spends real
 * quota and needs a signed-in CLI, so it only runs when asked for:
 *
 *   ANTIGRAVITY_LIVE=1 npx vitest run src/main/antigravity/session.live.test.ts
 *
 * Two of the things it checks are the ones the design leans on and nothing
 * else can prove: that agy loads `.agents/mcp_config.json` and
 * `.agents/hooks.json` from a folder it was only given as `--add-dir`, and that
 * it does what the hook says.
 */

const LIVE = process.env.ANTIGRAVITY_LIVE === '1'

const root = mkdtempSync(join(tmpdir(), 'agy-live-'))

/** What the stand-in hook server was asked, and what it should answer. */
const hookCalls: Record<string, unknown>[] = []
let denyCommands = false

/** A token only the stand-in tool server knows, so its answer cannot be guessed. */
const PONG = `pong-${Math.random().toString(36).slice(2, 10)}`

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

/**
 * One server playing both parts: Superagent's hook endpoint and its tool server.
 * The tool half is built the way mcp.ts builds the real one — the official SDK,
 * stateless, a fresh server per request — because how agy negotiates with *that*
 * is the thing under test (it opens with `server/discover`, which the SDK
 * refuses, and falls back to `initialize`).
 */
const server: Server = createServer(async (req, res) => {
  const body = await readBody(req)
  if (req.url?.includes('/AgyPreToolUse')) {
    hookCalls.push(body)
    // What the app's own endpoint does first: put the call on record, so the
    // session can see the hook was asked about this step.
    noteHookCall(
      new URL(req.url, 'http://127.0.0.1').searchParams.get('chat') ?? '',
      typeof body.stepIdx === 'number' ? body.stepIdx : null
    )
    const name = (body.toolCall as { name?: string } | undefined)?.name
    const deny = denyCommands && name === 'run_command'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        deny ? { decision: 'deny', reason: 'Denied by the live test.' } : { decision: 'allow' }
      )
    )
    return
  }
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end()
    return
  }
  const mcp = new McpServer({ name: 'cove-browser', version: '0.0.0-test' })
  mcp.tool(
    'superagent_ping',
    'Returns a token. Call it when asked to ping Superagent.',
    {},
    async () => ({ content: [{ type: 'text', text: PONG }] })
  )
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  await mcp.connect(transport)
  await transport.handleRequest(req, res, req.method === 'POST' ? body : undefined)
})

const base = await new Promise<string>((resolve) =>
  server.listen(0, '127.0.0.1', () =>
    resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  )
)
afterAll(() => server.close())

vi.mock('electron', () => ({ app: { getPath: () => root, getVersion: () => '0.0.0-test' } }))
vi.mock('../hooks', () => ({
  getHookUrl: () => `${base}/hook/test`,
  reportAgentLifecycle: () => undefined
}))
vi.mock('../mcp', () => ({
  getMcpUrl: () => `${base}/mcp`,
  workspaceMcpUrl: () => `${base}/mcp`
}))
vi.mock('../prompts', () => ({
  buildAppendedPrompt: () => 'You are running inside Superagent, under test. Be brief.'
}))
vi.mock('../external-browser', () => ({
  browserFor: () => 'builtin',
  browserScope: () => 'scope',
  browserName: () => 'Superagent'
}))
vi.mock('../accounts', () => ({ limitFromEvent: () => null }))

const { startAntigravitySession } = await import('./session')
const { noteHookCall } = await import('./approvals')
const { runAntigravityRoutine } = await import('./routine')

/** A solid-colour PNG, built by hand so the test needs no image library. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3).fill(Buffer.from([r, g, b]))
  ])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
import type { AgentBackend, AgentStartOptions } from '../agent-backend'

interface Run {
  events: Record<string, unknown>[]
  backend: AgentBackend
  exited: { code: number; reason?: string } | null
  resumeLost: boolean
}

function start(opts: AgentStartOptions): Run {
  const run: Run = { events: [], backend: null as never, exited: null, resumeLost: false }
  startAntigravitySession(
    { workspaceId: 'w-live', chatId: 'c-live', ...opts },
    {},
    {
      ready: (backend) => (run.backend = backend),
      event: (event) => run.events.push(event),
      stderr: () => undefined,
      exit: (code, reason) => (run.exited = { code, reason }),
      resumeLost: () => (run.resumeLost = true),
      limit: () => undefined
    }
  )
  return run
}

async function until(what: string, run: Run, check: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (run.exited) throw new Error(`agy exited waiting for ${what}: ${run.exited.reason}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const results = (run: Run): Record<string, unknown>[] =>
  run.events.filter((e) => e.type === 'result')
const init = (run: Run): Record<string, unknown> | undefined =>
  run.events.find((e) => e.type === 'system' && e.subtype === 'init' && e.session_id)
const blocks = (run: Run): Record<string, unknown>[] =>
  run.events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message as { content: Record<string, unknown>[] }).content)
const said = (run: Run): string =>
  blocks(run)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
const toolResults = (run: Run): Record<string, unknown>[] =>
  run.events
    .filter((e) => e.type === 'user')
    .flatMap((e) => (e.message as { content: Record<string, unknown>[] }).content)

async function turn(run: Run, text: string): Promise<void> {
  const before = results(run).length
  run.backend.send(text, [], [])
  await until(`an answer to "${text.slice(0, 40)}"`, run, () => results(run).length > before)
}

describe.skipIf(!LIVE)('Antigravity, live', () => {
  it('starts, answers, and remembers within one process', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    const run = start({ cwd })
    await until('init', run, () => !!init(run))
    expect(typeof init(run)?.session_id).toBe('string')

    await turn(run, 'Reply with exactly the word: apple. Nothing else.')
    expect(said(run).toLowerCase()).toContain('apple')
    expect(results(run)[0]).toMatchObject({ subtype: 'success', is_error: false })

    await turn(run, 'What word did I ask you to reply with? Answer with just that word.')
    expect(said(run).toLowerCase().match(/apple/g)?.length).toBeGreaterThanOrEqual(2)
    run.backend.kill()
  }, 300_000)

  it('runs a command and edits a file, as cards the app can draw', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    writeFileSync(join(cwd, 'hello.txt'), 'one\ntwo\nthree\n')
    const run = start({ cwd })
    await until('init', run, () => !!init(run))
    await turn(
      run,
      'Run the shell command `echo live_marker_42`. Then, in hello.txt in this folder, change ' +
        'the line "two" to "TWO". Then reply with the single word done.'
    )
    const uses = blocks(run).filter((b) => b.type === 'tool_use')
    const bash = uses.find((b) => b.name === 'Bash')
    expect((bash?.input as { command?: string })?.command).toContain('live_marker_42')
    expect(toolResults(run).some((r) => String(r.content).includes('live_marker_42'))).toBe(true)
    // The file changed in the project, not in Antigravity's scratch folder.
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toContain('TWO')
    const edit = uses.find((b) => b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'Write')
    expect(edit).toBeTruthy()
    expect(JSON.stringify(edit?.input)).toContain('TWO')
    run.backend.kill()
  }, 300_000)

  it('reaches Superagent’s tool server through the session folder', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    const run = start({ cwd })
    await until('init', run, () => !!init(run))
    await turn(
      run,
      'Call the superagent_ping tool on the cove-browser MCP server, then reply with exactly ' +
        'the text it returned.'
    )
    const use = blocks(run).find(
      (b) => b.type === 'tool_use' && b.name === 'mcp__cove-browser__superagent_ping'
    )
    expect(use).toBeTruthy()
    expect(said(run)).toContain(PONG)
    run.backend.kill()
  }, 300_000)

  it('asks the hook before a tool runs, and does what it says', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    hookCalls.length = 0
    denyCommands = true
    try {
      // Ask mode: no --dangerously-skip-permissions, the hook decides.
      const run = start({ cwd, permissionMode: 'ask' })
      await until('init', run, () => !!init(run))
      await turn(
        run,
        'Run the shell command `touch should_not_exist.txt`. If it is refused, do not try ' +
          'another way; just reply with the single word refused.'
      )
      const asked = hookCalls.find(
        (c) => (c.toolCall as { name?: string } | undefined)?.name === 'run_command'
      )
      expect(asked).toBeTruthy()
      expect(typeof asked?.conversationId).toBe('string')
      expect(existsSync(join(cwd, 'should_not_exist.txt'))).toBe(false)
      run.backend.kill()
    } finally {
      denyCommands = false
    }
  }, 300_000)

  it('runs a command in Ask mode once the hook allows it', async () => {
    // The other half of the gate: agy on its own refuses a command it cannot
    // prompt for, and a hook's "allow" does not change its mind. The session
    // has to be started so that an approved command really runs.
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    hookCalls.length = 0
    const run = start({ cwd, permissionMode: 'ask', chatId: 'c-live-allow' })
    await until('init', run, () => !!init(run))
    await turn(
      run,
      'Run the shell command `touch approved.txt`, then reply with the single word done.'
    )
    expect(
      hookCalls.some((c) => (c.toolCall as { name?: string } | undefined)?.name === 'run_command')
    ).toBe(true)
    expect(existsSync(join(cwd, 'approved.txt'))).toBe(true)
    expect(run.exited).toBeNull()
    run.backend.kill()
  }, 300_000)

  it('sees an image pasted into a message, which reaches it as a file', async () => {
    // Stream input is text only, so agent.ts saves a pasted image and the
    // message names the path. The folder has to be one agy may read.
    const dir = join(tmpdir(), 'superagent-pasted')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `live-${Date.now()}.png`)
    writeFileSync(file, solidPng(96, 96, [0, 0, 255]))
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    const run = start({ cwd })
    await until('init', run, () => !!init(run))
    await turn(
      run,
      'What single colour fills this image? Answer with one word.\n\n' +
        `[The user attached an image, saved to disk. Read this path now to see it:\n${file}]`
    )
    expect(said(run).toLowerCase()).toContain('blue')
    run.backend.kill()
  }, 300_000)

  it('runs a routine unattended, with its steps and Superagent’s tools', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    const seen: number[] = []
    const outcome = await runAntigravityRoutine({
      prompt:
        'Call the superagent_ping tool on the cove-browser MCP server, then run the shell ' +
        'command `touch routine_ran.txt`, then reply with exactly the text the tool returned.',
      systemPrompt: 'You are running unattended. Do the task and finish with a one-line summary.',
      cwd,
      paneId: 'live-routine',
      mcpConfigPath: '',
      mcpUrl: `${base}/mcp`,
      maxTurns: 20,
      timeoutMs: 240_000,
      onSteps: (steps) => seen.push(steps.length)
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toContain(PONG)
    expect(existsSync(join(cwd, 'routine_ran.txt'))).toBe(true)
    expect(outcome.steps.some((s) => s.kind === 'tool' && s.name === 'superagent_ping')).toBe(true)
    expect(outcome.tokens).toBeGreaterThan(0)
    // Steps arrived while it ran, not all at once at the end.
    expect(seen.length).toBeGreaterThan(1)
  }, 300_000)

  it('keeps the conversation across an interrupt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    const run = start({ cwd })
    await until('init', run, () => !!init(run))
    await turn(run, 'Remember this number: 7341. Reply with the single word ok.')

    run.backend.send('Count slowly from 1 to 400, one number per line.', [], [])
    await until(
      'streaming',
      run,
      () => run.events.filter((e) => e.type === 'stream_event').length > 6
    )
    run.backend.interrupt()
    await until('the interrupted turn to end', run, () => results(run).length === 2)
    expect(results(run)[1].is_error).toBe(false)
    expect(run.exited).toBeNull()

    await turn(run, 'What number did I ask you to remember? Reply with just the number.')
    expect(said(run)).toContain('7341')
    run.backend.kill()
  }, 300_000)

  it('resumes a conversation in a new session by its id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    const first = start({ cwd })
    await until('init', first, () => !!init(first))
    await turn(first, 'Remember this word: pineapple. Reply with the single word ok.')
    const id = init(first)?.session_id as string
    first.backend.kill()
    await new Promise((r) => setTimeout(r, 1500))

    const second = start({ cwd, resumeSessionId: id })
    await until('init', second, () => !!init(second))
    expect(second.resumeLost).toBe(false)
    expect(init(second)?.session_id).toBe(id)
    await turn(second, 'What word did I ask you to remember? Reply with just the word.')
    expect(said(second).toLowerCase()).toContain('pineapple')
    second.backend.kill()
  }, 300_000)

  it('falls back to a fresh conversation when the recorded one is gone', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-cwd-'))
    const run = start({ cwd, resumeSessionId: '00000000-0000-4000-8000-000000000000' })
    await until('init', run, () => !!init(run), 60_000)
    expect(run.resumeLost).toBe(true)
    run.backend.kill()
  }, 120_000)
})
