import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import os from 'os'
import { getHookUrl } from '../hooks'
import { getMcpUrl } from '../mcp'
import { buildAppendedPrompt } from '../prompts'
import { findClaude } from '../claude-cli'
import type { AgentBackend, AgentStartOptions, SessionContext, SessionHost } from '../agent-backend'

/**
 * The Claude Code backend.
 *
 * "Easy mode" — drives the real `claude` binary in streaming-JSON mode so we can
 * render a clean chat UI instead of the terminal TUI. Same binary, same
 * subscription; we just parse the event stream and forward it to the renderer.
 *
 * Multi-turn: claude runs with --input-format stream-json, staying alive and
 * reading one JSON user message per line from stdin.
 *
 * Everything Claude-specific lives here. Nothing in this file is imported by the
 * Codex backend and nothing from it is imported here — the two are peers, and a
 * change to one cannot reach the other.
 */

/**
 * The exact command line a Claude Code chat session runs on.
 *
 * Pulled out as a pure function because it is the only place the agent's reach
 * is decided — the permission mode and the tools it may never call — so it is
 * worth testing rather than reading. The equivalent decision for Codex is
 * `codexThreadOptions` in codex/session.ts: same concepts, a different dialect.
 */
export function buildAgentArgs(
  opts: AgentStartOptions,
  ctx: { resume?: string | null; mcpConfig?: string } = {}
): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Under -p there is no interactive prompt, so anything needing approval is
    // auto-denied — Edit/Write silently fail while reads succeed. The default
    // gives the agent the same reach it has in a terminal session where the
    // user approves prompts themselves. --disallowedTools below still applies.
    '--permission-mode',
    // "ask" is Superagent's name for Claude Code's default mode: every tool
    // that would prompt in a terminal asks the app via the PermissionRequest
    // hook instead, and the app asks the user (Mac or phone).
    opts.permissionMode === 'ask' ? 'default' : (opts.permissionMode ?? 'bypassPermissions')
  ]
  // Pin the model only when the user picked one. "Default" ('') means "whatever
  // your account uses" — passing no --model lets the CLI resolve the account
  // default (which is often the best model you have, e.g. Opus 5), so don't
  // second-guess it with a forced downgrade. To force off a rate-limited model
  // on a resumed session, pick a concrete model — that DOES send --model and
  // overrides.
  if (opts.model) args.push('--model', opts.model)
  // Ask mode: headless claude can't show a prompt, so it asks our MCP server,
  // which asks the user (Mac modal or phone). See mcp.ts permission_prompt.
  if (opts.permissionMode === 'ask')
    args.push('--permission-prompt-tool', 'mcp__cove-browser__permission_prompt')
  if (ctx.resume) args.unshift('--resume', ctx.resume)
  if (ctx.mcpConfig) args.push('--mcp-config', ctx.mcpConfig)
  args.push(
    '--append-system-prompt',
    buildAppendedPrompt({
      browserProject: opts.browserProject,
      workspaceId: opts.workspaceId,
      provider: 'claude'
    })
  )
  // Hard stops: cloud/loop schedulers can't reach Superagent's browser (scheduling
  // must use create_routine). The Task* tools are Claude's task-tracking surface
  // that the Tasks panel now reads, so they're allowed. Unknown names are no-ops.
  // Variadic, so this must stay last — it would otherwise swallow whatever
  // follows as tool names.
  args.push('--disallowedTools', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup')
  return args
}

/**
 * The Claude Code backend: a long-lived `claude` reading stream-json on stdin.
 */
function claudeBackend(proc: ChildProcessWithoutNullStreams): AgentBackend {
  const write = (payload: Record<string, unknown>): boolean => {
    if (!proc.stdin.writable) return false
    proc.stdin.write(JSON.stringify(payload) + '\n')
    return true
  }
  const gone = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (proc.exitCode !== null || proc.signalCode !== null) return true
      await new Promise((r) => setTimeout(r, 60))
    }
    return false
  }
  return {
    get writable() {
      return proc.stdin.writable
    },
    send(text, images) {
      const content = [
        ...images.map((im) => ({
          type: 'image',
          source: { type: 'base64', media_type: im.mediaType, data: im.data }
        })),
        ...(text ? [{ type: 'text', text }] : [])
      ]
      return write({ type: 'user', message: { role: 'user', content } })
    },
    interrupt() {
      write({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'interrupt' }
      })
    },
    /**
     * The stdin control_request above is the polite route, but the CLI only reads
     * stdin between steps — inside a long Bash call (a 15-minute deploy) nothing
     * is read at all, which is why a mid-turn message could sit unseen for a
     * quarter of an hour. A signal doesn't need the CLI to be listening.
     * Escalates: control request → SIGINT → kill.
     */
    async hardInterrupt() {
      this.interrupt()
      if (await gone(700)) return true
      proc.kill('SIGINT')
      if (await gone(1200)) return true
      proc.kill('SIGKILL')
      return true
    },
    kill() {
      proc.kill()
    }
  }
}

/**
 * Start a Claude Code session. Owns its own resume-then-fall-back-to-fresh
 * retry: the host is only told a session was lost, never how it was retried.
 */
export function startClaudeSession(
  opts: AgentStartOptions,
  ctx: SessionContext,
  host: SessionHost
): void {
  // A valid resume emits a `system/init` event; a missing session makes claude
  // exit having only emitted SessionStart *hook* events (which fire before the
  // session is validated). So we track the init event specifically — not any
  // stdout — to tell a successful start from a failed resume, and only fall back
  // to a fresh session when a resume never reached init.
  let sawInit = false

  const spawnProc = (resume: string | null): void => {
    const args = buildAgentArgs(opts, { resume, mcpConfig: ctx.mcpConfigPath })

    const proc = spawn(findClaude(), args, {
      cwd: opts.cwd || os.homedir(),
      env: {
        ...process.env,
        COVE_HOOK_URL: getHookUrl(),
        COVE_MCP_URL: getMcpUrl(),
        ...(opts.workspaceId ? { COVE_WORKSPACE_ID: opts.workspaceId } : {})
      },
      // Login shell resolves the user's PATH (nvm/homebrew/~/.local/bin).
      shell: false
    }) as ChildProcessWithoutNullStreams

    host.ready(claudeBackend(proc))

    // Writing to a claude that has already closed stdin throws EPIPE; without a
    // listener that becomes an unhandled 'error' and crashes the main process.
    proc.stdin.on('error', () => {})

    let buffer = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (event?.type === 'system' && event?.subtype === 'init') sawInit = true
          host.event(event)
        } catch {
          // partial or non-JSON line; ignore
        }
      }
    })

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      host.stderr(chunk.toString('utf8'))
    })

    // spawn failures (e.g. ENOENT when the binary can't be found) emit 'error',
    // not 'exit'; without this handler that's an unhandled error on the child.
    proc.on('error', (err) => {
      console.error('[claude] spawn error:', err.message)
      if (resume && !sawInit) {
        host.resumeLost()
        spawnProc(null)
        return
      }
      host.exit(1)
    })

    proc.on('exit', (code) => {
      if (code && code !== 0 && stderr) console.error('[claude] exited', code, stderr.slice(0, 300))
      if (resume && !sawInit) {
        // The resume target was unavailable (claude exited before emitting
        // anything) — retry once with a fresh session.
        host.resumeLost()
        spawnProc(null)
        return
      }
      host.exit(code ?? 0, meaningfulStderr(stderr))
    })
  }

  spawnProc(opts.resumeSessionId ?? null)
}

/**
 * The one line worth showing a person out of a blob of CLI stderr. Claude's own
 * diagnostics ("Your organization has disabled Claude subscription access…",
 * "Invalid API key…") are plain sentences; everything around them is node
 * warnings, debug logging and stack frames. Strip ANSI, drop the noise, and take
 * the last human-looking line.
 */
export function meaningfulStderr(raw: string): string | undefined {
  const noise =
    /^\s*(at\s|node:|\(node:|Debugger|Warning:|\[dotenv|npm warn|npm notice|\{|\}|".*":)/i
  const lines = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 300 && !noise.test(l))
  return lines.length ? lines[lines.length - 1] : undefined
}

/**
 * Name a conversation via a throwaway one-shot `claude -p`. Tools are off —
 * this is pure text in, text out — and a failure is silent.
 */
export function suggestTitleWithClaude(cwd: string, excerpt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      findClaude(),
      [
        '-p',
        '--output-format',
        'text',
        '--max-turns',
        '1',
        // Variadic, so it must come last — it would otherwise swallow whatever
        // follows as tool names. The prompt goes in on stdin for the same reason.
        '--disallowedTools',
        ...['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task']
      ],
      { cwd: cwd || os.homedir(), env: process.env, shell: false }
    )
    proc.stdin.on('error', () => {})
    proc.stdin.end(
      'Summarize what this conversation is about as a title of at most 6 words. ' +
        'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
        excerpt
    )
    let out = ''
    const done = (value: string | null): void => {
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        // already gone
      }
      resolve(value)
    }
    // Never let naming outlive the user's interest in it.
    const timer = setTimeout(() => done(null), 20_000)
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    proc.on('error', () => done(null))
    proc.on('close', (code) => {
      // A non-zero exit means the CLI printed diagnostics, not a title.
      if (code !== 0) return done(null)
      const title = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop()
        ?.replace(/^["']|["']$/g, '')
      // The CLI reports its own failures on stdout ("Error: Reached max turns"),
      // and one of those once became a chat's actual title. Anything that reads
      // as an error keeps the placeholder instead.
      if (title && /^(error|⚠|warning)\b|max turns|rate limit/i.test(title)) return done(null)
      done(title && title.length <= 80 ? title : null)
    })
  })
}
