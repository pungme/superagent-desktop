import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The Codex backend against the real `codex` binary.
 *
 * Everything else about Codex is tested on recorded shapes, which cannot tell
 * you that the protocol still works — only that our reading of it is
 * self-consistent. This drives an actual `codex app-server`, spends real tokens
 * and needs a signed-in CLI, so it only runs when asked for:
 *
 *   CODEX_LIVE=1 npx vitest run src/main/codex/session.live.test.ts
 */

const LIVE = process.env.CODEX_LIVE === '1'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' }
}))
// The session's approval path is the app's; here every request is granted, so a
// prompt can never hang the run.
vi.mock('../hooks', () => ({
  requestApproval: async () => true,
  reportAgentLifecycle: () => undefined
}))
// No app means no tool server to point Codex at.
vi.mock('../mcp', () => ({ workspaceMcpUrl: () => '' }))
vi.mock('../prompts', () => ({
  buildAppendedPrompt: () => 'You are running inside Superagent, under test. Be brief.'
}))

const { startCodexSession } = await import('./session')
import type { AgentBackend } from '../agent-backend'

interface Run {
  events: Record<string, unknown>[]
  backend: AgentBackend
  exited: { code: number; reason?: string } | null
  resumeLost: boolean
}

/** Start a session and resolve once it has emitted its init event. */
function start(opts: Record<string, unknown>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const run: Run = { events: [], backend: null as never, exited: null, resumeLost: false }
    const timer = setTimeout(() => reject(new Error('no init within 60s')), 60_000)
    startCodexSession(
      opts as never,
      {},
      {
        ready: (backend) => {
          run.backend = backend
        },
        event: (event) => {
          run.events.push(event)
          if (event.type === 'system' && event.subtype === 'init') {
            clearTimeout(timer)
            resolve(run)
          }
        },
        stderr: () => {},
        exit: (code, reason) => {
          run.exited = { code, reason }
          clearTimeout(timer)
          reject(new Error(`session exited (${code}): ${reason ?? ''}`))
        },
        resumeLost: () => {
          run.resumeLost = true
        }
      }
    )
  })
}

/** Wait for the turn's `result` event. */
async function turnEnd(run: Run, ms = 180_000): Promise<Record<string, unknown>> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const done = run.events.find((e) => e.type === 'result')
    if (done) return done
    if (run.exited) throw new Error(`session died: ${run.exited.reason ?? run.exited.code}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('turn did not finish')
}

const textOf = (events: Record<string, unknown>[]): string =>
  events
    .filter((e) => e.type === 'assistant')
    .flatMap(
      (e) =>
        ((e.message as { content?: Record<string, unknown>[] })?.content ?? []) as Record<
          string,
          unknown
        >[]
    )
    .filter((c) => c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n')

/** The tool_use id a card was opened with, so results can be matched to it. */
const idOf = (
  events: Record<string, unknown>[],
  use: { name: string; input: Record<string, unknown> }
): string => {
  for (const e of events) {
    if (e.type !== 'assistant') continue
    for (const c of ((e.message as { content?: Record<string, unknown>[] })?.content ??
      []) as Record<string, unknown>[]) {
      if (c.type === 'tool_use' && c.name === use.name && c.input === use.input) return String(c.id)
    }
  }
  return ''
}

const toolUses = (
  events: Record<string, unknown>[]
): { name: string; input: Record<string, unknown> }[] =>
  events
    .filter((e) => e.type === 'assistant')
    .flatMap(
      (e) =>
        ((e.message as { content?: Record<string, unknown>[] })?.content ?? []) as Record<
          string,
          unknown
        >[]
    )
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({ name: String(c.name), input: (c.input ?? {}) as Record<string, unknown> }))

describe.runIf(LIVE)('codex session (live)', () => {
  it('streams a reply, runs a command and edits a file — all as stream-json', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'superagent-codex-'))
    writeFileSync(join(cwd, 'greeting.txt'), 'hello world\n')

    const run = await start({
      cwd,
      workspaceId: 'ws-test',
      chatId: 'chat-test',
      permissionMode: 'bypassPermissions'
    })

    const init = run.events[0]
    expect(init).toMatchObject({ type: 'system', subtype: 'init' })
    expect(String(init.session_id)).toMatch(/[0-9a-f-]{20,}/)
    // The picker is built from this, so an empty list would silently leave a
    // Codex chat with nothing but "Default".
    expect((init.models as unknown[])?.length).toBeGreaterThan(0)

    expect(
      run.backend.send(
        'Run `cat greeting.txt` with the shell, then change the word "world" to "codex" in ' +
          'that file. Then reply with exactly: DONE.',
        [],
        []
      )
    ).toBe(true)

    const result = await turnEnd(run)
    expect(result).toMatchObject({ is_error: false })

    // Text arrived as deltas, not just as one whole message at the end.
    const deltas = run.events.filter(
      (e) =>
        e.type === 'stream_event' &&
        (e.event as Record<string, unknown>)?.type === 'content_block_delta'
    )
    expect(deltas.length).toBeGreaterThan(0)
    expect(textOf(run.events)).toContain('DONE')

    // The command became a Bash card with the shell wrapper stripped.
    const uses = toolUses(run.events)
    const bash = uses.find((u) => u.name === 'Bash')
    expect(bash).toBeTruthy()
    expect(String(bash?.input.command)).toContain('greeting.txt')
    expect(String(bash?.input.command)).not.toContain('-lc')

    // The edit became a diff card the renderer can draw, and really happened.
    const edit = uses.find((u) => u.name === 'MultiEdit' || u.name === 'Write')
    expect(edit).toBeTruthy()
    expect(String(edit?.input.file_path)).toContain('greeting.txt')
    expect(readFileSync(join(cwd, 'greeting.txt'), 'utf8')).toContain('codex')

    // Every tool_use got a tool_result, or the chat leaves cards spinning.
    const resultIds = new Set(
      run.events
        .filter((e) => e.type === 'user')
        .flatMap(
          (e) =>
            ((e.message as { content?: Record<string, unknown>[] })?.content ?? []) as Record<
              string,
              unknown
            >[]
        )
        .map((c) => String(c.tool_use_id))
    )
    const unanswered = uses.filter((u) => !resultIds.has(idOf(run.events, u)))
    expect(unanswered).toEqual([])

    run.backend.kill()
    expect(existsSync(cwd)).toBe(true)
  }, 240_000)

  it('resumes a thread in a new process and still remembers', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'superagent-codex-'))
    const first = await start({ cwd, chatId: 'chat-resume', permissionMode: 'plan' })
    first.backend.send('Remember the number 4471. Reply with just: OK.', [], [])
    await turnEnd(first)
    const threadId = String(first.events[0].session_id)
    first.backend.kill()

    // A different process entirely — this is what happens after a restart.
    const second = await start({
      cwd,
      chatId: 'chat-resume',
      permissionMode: 'plan',
      resumeSessionId: threadId
    })
    expect(second.resumeLost).toBe(false)
    expect(String(second.events[0].session_id)).toBe(threadId)
    second.backend.send(
      'What number did I ask you to remember? Reply with just the number.',
      [],
      []
    )
    await turnEnd(second)
    expect(textOf(second.events)).toContain('4471')
    second.backend.kill()
  }, 240_000)

  it('falls back to a fresh thread and says so when the recorded one is gone', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'superagent-codex-'))
    const run = await start({
      cwd,
      chatId: 'chat-missing',
      permissionMode: 'plan',
      // A well-formed id that was never a thread.
      resumeSessionId: '01a05d20-0000-7000-8000-000000000000'
    })
    expect(run.resumeLost).toBe(true)
    expect(String(run.events[0].session_id)).not.toBe('01a05d20-0000-7000-8000-000000000000')
    run.backend.kill()
  }, 120_000)
})
