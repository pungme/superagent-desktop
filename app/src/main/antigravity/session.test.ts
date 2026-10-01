import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The Antigravity session, against a stand-in for `agy`.
 *
 * What the session adds on top of the translator is process handling — the
 * session outliving its process across an interrupt or an error, falling back
 * from a conversation that is gone, telling a missing sign-in from one — and
 * none of that can be seen in a pure function. The stand-in below speaks agy's
 * documented stream-json and misbehaves on request; the real binary is covered
 * by session.live.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), 'agy-session-'))
const fakeAgy = join(root, 'agy')
const argvLog = join(root, 'argv.log')

writeFileSync(
  fakeAgy,
  `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
if (args[0] === 'models') {
  console.log('gemini-3.8-flash-high     Gemini 3.8 Flash (High)')
  process.exit(0)
}
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(args) + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const fail = (error, code) => {
  out({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error } })
  process.exitCode = code
}
const resume = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : ''
if (process.env.FAKE_AGY_SIGNED_OUT) {
  process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\\n")
  fail('authentication failed or timed out', 1)
} else if (resume && resume === process.env.FAKE_AGY_LOST) {
  process.stderr.write('error: conversation ' + resume + ' was not found\\n')
  fail('conversation not found', 1)
} else {
  // The real CLI only warns about a conversation it cannot find, and carries on.
  const forgot = resume && resume === process.env.FAKE_AGY_FORGOT
  if (forgot) process.stderr.write('warning: conversation "' + resume + '" not found\\n')
  const conv = forgot ? 'conv-new' : resume || 'conv-new'
  out({ event: 'init', conversation_id: conv, init: { cwd: process.cwd(), tools: [] } })
  let index = 0
  let busy = Promise.resolve()
  const step = (f) => out({ event: 'step_update', step_update: { conversation_id: conv, ...f } })
  const turn = (text) =>
    new Promise((done) => {
      step({ step_index: index++, state: 'DONE', step_type: 'user_input' })
      const at = index++
      if (text.includes('BOOM')) {
        fail('boom', 3)
        return process.exit()
      }
      if (text.includes('RUNTOOL')) {
        // A command, run without consulting any hook — the stand-in has none.
        const tool = { step_index: at, step_type: 'tool', tool_name: 'run_command' }
        const info = { name: 'run_command', parameters: { CommandLine: 'touch x' } }
        step({ ...tool, state: 'ACTIVE', tool_info: info })
        step({ ...tool, state: 'DONE', tool_info: { ...info, output: '' } })
        index++
      }
      step({ step_index: at + (text.includes('RUNTOOL') ? 1 : 0), state: 'ACTIVE', step_type: 'agent_response', text_delta: 'echo:' })
      if (text.includes('SLOW')) return // never answers: the test interrupts it
      setTimeout(() => {
        step({ step_index: at + (text.includes('RUNTOOL') ? 1 : 0), state: 'DONE', step_type: 'agent_response', text_delta: text })
        out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'echo:' + text } })
        done()
      }, 40)
    })
  process.on('SIGINT', () => {
    out({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'interrupted' } })
    process.exit(130)
  })
  let buffer = ''
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      const text = JSON.parse(line).message.content[0].text
      busy = busy.then(() => turn(text))
    }
  })
  process.stdin.on('end', () => busy.then(() => process.exit(0)))
}
`
)
chmodSync(fakeAgy, 0o755)

vi.mock('electron', () => ({ app: { getPath: () => root, getVersion: () => '0.0.0-test' } }))
vi.mock('../claude-cli', () => ({ findAgy: () => fakeAgy }))
const lifecycle = vi.fn()
vi.mock('../hooks', () => ({
  getHookUrl: () => 'http://127.0.0.1:6000/hook/secret',
  reportAgentLifecycle: (...a: unknown[]) => lifecycle(...a)
}))
vi.mock('../mcp', () => ({
  getMcpUrl: () => 'http://127.0.0.1:5000/mcp',
  workspaceMcpUrl: (ws: string, chat?: string) => `http://127.0.0.1:5000/mcp?ws=${ws}&chat=${chat}`
}))
vi.mock('../prompts', () => ({ buildAppendedPrompt: () => 'BRIEFING' }))
vi.mock('../external-browser', () => ({
  browserFor: () => 'builtin',
  browserScope: () => 'scope',
  browserName: () => 'Superagent'
}))
vi.mock('../accounts', () => ({ limitFromEvent: () => null }))

const { startAntigravitySession, buildAgyArgs, withBriefing, agyStartupReason } =
  await import('./session')
const { noteHookCall } = await import('./approvals')
import type { AgentBackend, AgentStartOptions } from '../agent-backend'

interface Run {
  events: Record<string, unknown>[]
  backend: AgentBackend
  exited: { code: number; reason?: string } | null
  resumeLost: number
}

function start(opts: AgentStartOptions, env: Record<string, string> = {}): Run {
  const run: Run = { events: [], backend: null as never, exited: null, resumeLost: 0 }
  startAntigravitySession(
    { cwd: root, workspaceId: 'w1', chatId: 'c1', ...opts },
    { env: { FAKE_AGY_LOG: argvLog, ...env } },
    {
      ready: (backend) => (run.backend = backend),
      event: (event) => run.events.push(event),
      stderr: () => undefined,
      exit: (code, reason) => (run.exited = { code, reason }),
      resumeLost: () => run.resumeLost++,
      limit: () => undefined
    }
  )
  return run
}

async function until(what: string, check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

const results = (run: Run): Record<string, unknown>[] =>
  run.events.filter((e) => e.type === 'result')
const inits = (run: Run): Record<string, unknown>[] =>
  run.events.filter((e) => e.type === 'system' && e.subtype === 'init')
/** Every finished assistant text, in order. */
const texts = (run: Run): string[] =>
  run.events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message as { content: { type: string; text?: string }[] }).content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
/** The command lines the stand-in was started with, oldest first. */
const launches = (): string[][] =>
  existsSync(argvLog)
    ? readFileSync(argvLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

beforeEach(() => {
  writeFileSync(argvLog, '')
  lifecycle.mockClear()
})

describe('an Antigravity chat', () => {
  it('announces itself with the conversation id and the account’s models', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    expect(inits(run)[0]).toMatchObject({
      session_id: 'conv-new',
      models: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash', hint: 'High' }]
    })
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('answers a message, and briefs the agent once at the start of the conversation', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    run.backend.send('hello', [], [])
    await until('first answer', () => results(run).length === 1)
    run.backend.send('again', [], [])
    await until('second answer', () => results(run).length === 2)

    const [first, second] = texts(run)
    expect(first).toContain('<system_instructions>\nBRIEFING')
    expect(first).toContain('hello')
    expect(second).toBe('echo:again')
    expect(results(run).every((r) => r.subtype === 'success')).toBe(true)
    // One process served both turns.
    expect(launches()).toHaveLength(1)
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('hands the process its own folder with the tool server and the approval hook', async () => {
    const run = start({ permissionMode: 'ask' })
    await until('init', () => inits(run).length > 0)
    const args = launches()[0]
    const dirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []))
    expect(dirs[0]).toBe(root)
    const sidecar = dirs.find((d) => existsSync(join(d, '.agents', 'mcp_config.json')))
    expect(sidecar).toBeTruthy()
    const mcp = JSON.parse(readFileSync(join(sidecar!, '.agents', 'mcp_config.json'), 'utf8'))
    expect(mcp.mcpServers['cove-browser'].serverUrl).toContain('ws=w1&chat=c1')
    const hooks = readFileSync(join(sidecar!, '.agents', 'hooks.json'), 'utf8')
    // The chat's id rides along: the window files an approval under it.
    expect(hooks).toContain('AgyPreToolUse?mode=ask&chat=c1')
    // With the hook on disk the CLI is told to approve everything: the hook is the gate.
    expect(args).toContain('--dangerously-skip-permissions')

    run.backend.kill()
    await until('exit', () => !!run.exited)
    // The folder holds this launch's secrets; it goes when the session does.
    expect(existsSync(sidecar!)).toBe(false)
  })

  it('keeps the session when a turn is interrupted, and resumes the conversation', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    run.backend.send('SLOW', [], [])
    await until('streaming', () => run.events.some((e) => e.type === 'stream_event'))
    run.backend.interrupt()
    await until('the turn to end', () => results(run).length === 1)
    // Interrupted, not failed — and the session is still there to talk to.
    expect(results(run)[0]).toMatchObject({ is_error: false, result: 'interrupted' })
    await new Promise((r) => setTimeout(r, 150))
    expect(run.exited).toBeNull()
    expect(run.backend.writable).toBe(true)

    run.backend.send('after', [], [])
    await until('the next answer', () => results(run).length === 2)
    expect(texts(run).pop()).toBe('echo:after')
    const second = launches()[1]
    expect(second[second.indexOf('--conversation') + 1]).toBe('conv-new')
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('delivers a message sent while the interrupt was still landing', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    run.backend.send('SLOW', [], [])
    await until('streaming', () => run.events.some((e) => e.type === 'stream_event'))
    run.backend.interrupt()
    run.backend.send('right away', [], [])
    await until('both turns to end', () => results(run).length === 2)
    expect(texts(run).pop()).toBe('echo:right away')
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('survives a turn that ends in an error, though agy exits after one', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    run.backend.send('BOOM', [], [])
    await until('the error', () => results(run).length === 1)
    expect(results(run)[0]).toMatchObject({ is_error: true, result: 'boom' })
    await new Promise((r) => setTimeout(r, 150))
    expect(run.exited).toBeNull()

    run.backend.send('still here?', [], [])
    await until('the next answer', () => results(run).length === 2)
    expect(texts(run).pop()).toBe('echo:still here?')
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('reports the end once when a message was queued behind the running turn', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    run.backend.send('one', [], [])
    run.backend.send('two', [], [])
    await until('both answers', () => texts(run).length === 2)
    await until('the result', () => results(run).length > 0)
    await new Promise((r) => setTimeout(r, 100))
    // agy answers each line as a turn of its own; the chat hears "done" once.
    expect(results(run)).toHaveLength(1)
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('falls back to a fresh conversation when the recorded one is gone', async () => {
    const run = start({ resumeSessionId: 'gone' }, { FAKE_AGY_LOST: 'gone' })
    await until('init', () => inits(run).length > 0)
    expect(run.resumeLost).toBe(1)
    expect(inits(run)[0].session_id).toBe('conv-new')
    expect(run.exited).toBeNull()
    // The failed attempt's own error never reached the chat.
    expect(results(run)).toHaveLength(0)

    // The fresh conversation has not been briefed, so the next message carries it.
    run.backend.send('hello', [], [])
    await until('an answer', () => results(run).length === 1)
    expect(texts(run)[0]).toContain('BRIEFING')
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('notices when agy quietly replaces a conversation it could not find', async () => {
    // What agy 1.2.14 really does with an unknown id: a warning on stderr, then
    // a brand-new conversation. Nothing fails, so the id is the only tell.
    const run = start({ resumeSessionId: 'forgotten' }, { FAKE_AGY_FORGOT: 'forgotten' })
    await until('init', () => inits(run).length > 0)
    expect(inits(run)[0].session_id).toBe('conv-new')
    expect(run.resumeLost).toBe(1)
    expect(launches()).toHaveLength(1)
    // It remembers nothing, so it is briefed again like any new conversation.
    run.backend.send('hello', [], [])
    await until('an answer', () => results(run).length === 1)
    expect(texts(run)[0]).toContain('BRIEFING')
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('resumes a conversation without briefing it again', async () => {
    const run = start({ resumeSessionId: 'conv-old' })
    await until('init', () => inits(run).length > 0)
    expect(inits(run)[0].session_id).toBe('conv-old')
    run.backend.send('hello', [], [])
    await until('an answer', () => results(run).length === 1)
    expect(texts(run)[0]).toBe('echo:hello')
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('says so when Antigravity is not signed in, rather than starting over', async () => {
    const run = start({ resumeSessionId: 'conv-old' }, { FAKE_AGY_SIGNED_OUT: '1' })
    await until('exit', () => !!run.exited)
    expect(run.exited?.code).toBe(1)
    expect(run.exited?.reason).toMatch(/not signed in/i)
    // A fresh conversation would have hit the same wall, and lost the old one.
    expect(run.resumeLost).toBe(0)
    expect(inits(run)).toHaveLength(0)
  })

  it('stops a chat whose gated tool ran without the hook being asked', async () => {
    // In Ask the CLI is told to approve everything and the hook is the gate. A
    // command that ran with no record of the hook means the gate is not there.
    const run = start({ permissionMode: 'ask', chatId: 'c-ungated' })
    await until('init', () => inits(run).length > 0)
    run.backend.send('RUNTOOL', [], [])
    await until('exit', () => !!run.exited)
    expect(run.exited?.reason).toMatch(/without asking Superagent's approval hook/)
    expect(run.backend.writable).toBe(false)
    // The turn was closed off, not left spinning.
    expect(results(run).pop()).toMatchObject({ is_error: true })
  })

  it('lets a gated tool through when the hook was asked about that step', async () => {
    const run = start({ permissionMode: 'ask', chatId: 'c-gated' })
    await until('init', () => inits(run).length > 0)
    // What the hook endpoint records when agy asks it about step 1.
    noteHookCall('c-gated', 1)
    run.backend.send('RUNTOOL', [], [])
    await until('an answer', () => results(run).length === 1)
    expect(results(run)[0]).toMatchObject({ subtype: 'success' })
    expect(run.exited).toBeNull()
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('does not second-guess a tool on full access, where nothing is gated', async () => {
    const run = start({ chatId: 'c-full' })
    await until('init', () => inits(run).length > 0)
    run.backend.send('RUNTOOL', [], [])
    await until('an answer', () => results(run).length === 1)
    expect(results(run)[0]).toMatchObject({ subtype: 'success' })
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('reports the working and done beats the status badge is driven by', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    run.backend.send('hello', [], [])
    await until('an answer', () => results(run).length === 1)
    const beats = lifecycle.mock.calls.map((c) => c[0])
    expect(beats).toEqual(['UserPromptSubmit', 'Stop'])
    run.backend.kill()
    await until('exit', () => !!run.exited)
  })

  it('ends for good on a hard interrupt', async () => {
    const run = start({})
    await until('init', () => inits(run).length > 0)
    run.backend.send('SLOW', [], [])
    await until('streaming', () => run.events.some((e) => e.type === 'stream_event'))
    expect(await run.backend.hardInterrupt()).toBe(true)
    await until('exit', () => !!run.exited)
    expect(run.backend.writable).toBe(false)
    expect(run.backend.send('too late', [], [])).toBe(false)
  })
})

/** The value that follows a flag, or undefined when the flag isn't there. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('buildAgyArgs', () => {
  it('always streams both ways and points the tools at the project', () => {
    const args = buildAgyArgs({ cwd: '/work' })
    expect(valueAfter(args, '--input-format')).toBe('stream-json')
    expect(valueAfter(args, '--output-format')).toBe('stream-json')
    expect(valueAfter(args, '--add-dir')).toBe('/work')
  })

  it('defaults to full access — headless agy refuses whatever would have prompted', () => {
    expect(buildAgyArgs({})).toContain('--dangerously-skip-permissions')
    expect(buildAgyArgs({ permissionMode: 'bypassPermissions' })).toContain(
      '--dangerously-skip-permissions'
    )
  })

  it('makes the hook the gate in the narrower modes, and only where it is installed', () => {
    // A hook's "allow" cannot lift headless agy's own refusals; only its "deny"
    // is obeyed. So with the hook in place the CLI approves everything and the
    // hook says no — and without it, the CLI is left refusing for itself.
    for (const permissionMode of ['ask', 'acceptEdits', 'plan'] as const) {
      expect(buildAgyArgs({ permissionMode }, { hooked: true })).toContain(
        '--dangerously-skip-permissions'
      )
      expect(buildAgyArgs({ permissionMode })).not.toContain('--dangerously-skip-permissions')
    }
    expect(valueAfter(buildAgyArgs({ permissionMode: 'acceptEdits' }), '--mode')).toBe(
      'accept-edits'
    )
    expect(valueAfter(buildAgyArgs({ permissionMode: 'plan' }), '--mode')).toBe('plan')
    // `default` is implicit; `--mode` accepts nothing else.
    expect(buildAgyArgs({ permissionMode: 'ask' })).not.toContain('--mode')
  })

  it('pins a model of its own and drops one that belongs to another agent', () => {
    expect(valueAfter(buildAgyArgs({ model: 'gemini-3.8-flash-high' }), '--model')).toBe(
      'gemini-3.8-flash-high'
    )
    // `opus` is Claude Code's alias: agy would refuse to start on it.
    expect(buildAgyArgs({ model: 'opus' })).not.toContain('--model')
    expect(buildAgyArgs({ model: 'gpt-5-codex' })).not.toContain('--model')
  })

  it('never passes --effort, which agy rejects beside a model slug', () => {
    expect(buildAgyArgs({ model: 'gemini-3.8-flash-high' })).not.toContain('--effort')
  })

  it('resumes by conversation id', () => {
    expect(valueAfter(buildAgyArgs({}, { resume: 'conv-1' }), '--conversation')).toBe('conv-1')
    expect(buildAgyArgs({})).not.toContain('--conversation')
  })

  it('adds the session folder and the pasted-image folder as readable directories', () => {
    const args = buildAgyArgs({ cwd: '/work' }, { sidecar: '/side', attachments: '/pasted' })
    const dirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []))
    expect(dirs).toEqual(['/work', '/side', '/pasted'])
  })
})

describe('the briefing', () => {
  it('leads the first message', () => {
    expect(withBriefing('hello', 'B')).toBe(
      '<system_instructions>\nB\n</system_instructions>\n\nhello'
    )
  })

  it('follows a slash command, which has to stay first to be expanded', () => {
    const text = withBriefing('/check-my-site now', 'B')
    expect(text.startsWith('/check-my-site now')).toBe(true)
    expect(text).toContain('<system_instructions>')
  })
})

describe('a failed start', () => {
  it('is put in words a person can act on', () => {
    expect(agyStartupReason('spawn agy ENOENT')).toMatch(/not installed/)
    expect(agyStartupReason("authentication required. Run 'agy' to log in, then retry.")).toMatch(
      /not signed in/
    )
    expect(agyStartupReason('invalid model selection')).toBe('invalid model selection')
    expect(agyStartupReason('')).toBe('Antigravity failed to start.')
  })
})
