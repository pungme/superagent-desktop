import { browserFor, browserScope, browserName } from '../external-browser'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { mkdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { getHookUrl, reportAgentLifecycle } from '../hooks'
import { getMcpUrl, workspaceMcpUrl } from '../mcp'
import { buildAppendedPrompt } from '../prompts'
import { findAgy } from '../claude-cli'
import { clearTurn } from '../guardrail'
import { forgetHookCalls, hookSawStep, needsHook } from './approvals'
import { limitFromEvent } from '../accounts'
import { killProcessTree, DETACH_FOR_TREE_KILL } from '../kill-tree'
import { modelBelongsTo } from '../../shared/agent-provider'
import {
  AntigravityTranslator,
  encodeUserTurn,
  parseAgyLine,
  type StreamJsonEvent
} from './translate'
import { agyModels, agyRun, lastLine } from './exec'
import { claimSidecar, releaseSidecar, sidecarName, sweepSidecars, writeSidecar } from './sidecar'
import type { AgentBackend, AgentStartOptions, SessionContext, SessionHost } from '../agent-backend'

/**
 * The Antigravity backend.
 *
 * Google's `agy` has a headless mode shaped a lot like Claude Code's: started
 * with `--input-format stream-json --output-format stream-json` it stays alive,
 * reads one user message per line on stdin, and answers each as a stream of
 * NDJSON events ending in a `result`. A chat runs on one such process, and
 * everything it emits is translated into the event vocabulary the rest of the
 * app already speaks (see translate.ts).
 *
 * Where it differs from Claude Code is everything around the conversation, and
 * that is what this file is for:
 *
 *  - It takes no `--mcp-config`, no `--append-system-prompt` and no hook flags.
 *    Superagent's tools and its approval hook reach it through a private folder
 *    passed as `--add-dir` (sidecar.ts), and the briefing rides in front of the
 *    conversation's first message.
 *  - It has no interrupt message. A turn is stopped with SIGINT, which ends the
 *    process — so the session keeps the conversation id and starts a fresh
 *    process on it when the next message comes, and a stopped turn costs no
 *    context.
 *  - It exits after any turn that ends in an error. Same answer: the session
 *    outlives its process.
 *
 * Everything Antigravity-specific lives in this directory. It imports nothing
 * from `claude/` or `codex/`, and they import nothing from here.
 */

/** Where images pasted into a message are saved (agent.ts). Antigravity reads them from disk. */
function pastedImagesDir(): string {
  return join(os.tmpdir(), 'superagent-pasted')
}

function sidecarRoot(): string {
  return join(process.env.COVE_USER_DATA || app.getPath('userData'), 'antigravity')
}

/**
 * The exact command line an Antigravity chat session runs on.
 *
 * Pulled out as a pure function for the same reason `buildAgentArgs` is for
 * Claude Code: it is where the agent's reach is decided, so it is worth testing
 * rather than reading.
 */
export function buildAgyArgs(
  opts: AgentStartOptions,
  ctx: {
    resume?: string | null
    sidecar?: string
    attachments?: string
    /** The approval hook is installed, so Superagent is the gate (approvals.ts). */
    hooked?: boolean
  } = {}
): string[] {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // Load-bearing: without it every tool works in Antigravity's own scratch
    // folder, whatever directory the process was started in.
    '--add-dir',
    opts.cwd || os.homedir(),
    // The session's own folder is how this process — and no other — is handed
    // Superagent's tool server and approval hook.
    ...(ctx.sidecar ? ['--add-dir', ctx.sidecar] : []),
    // Stream input is text only, so a pasted image arrives as a path; the folder
    // it is saved in has to be somewhere the agent may read.
    ...(ctx.attachments ? ['--add-dir', ctx.attachments] : []),
    // 0 waits for the turn to finish. A chat is stopped by the user, not a clock.
    '--print-timeout',
    '0'
  ]
  // The reasoning tier is part of the model slug (gemini-3.8-flash-high), so
  // `--effort` is never passed: agy rejects the pair as a conflict.
  if (opts.model && modelBelongsTo(opts.model, 'antigravity')) args.push('--model', opts.model)
  // `default` is the implicit mode; `--mode` only accepts these two.
  if (opts.permissionMode === 'acceptEdits') args.push('--mode', 'accept-edits')
  if (opts.permissionMode === 'plan') args.push('--mode', 'plan')
  // Headless agy cannot prompt, so on its own it refuses anything that would
  // have asked — and a hook's "allow" does not lift that refusal, only a hook's
  // "deny" is obeyed. So wherever the hook is installed the CLI is told to
  // approve everything and the hook is the gate: it refuses what the mode
  // forbids and holds what the user has to answer (approvals.ts). Without the
  // hook, only full access gets the flag; a narrower mode is left to agy's own
  // refusals, which is safe if not useful.
  if ((opts.permissionMode ?? 'bypassPermissions') === 'bypassPermissions' || ctx.hooked)
    args.push('--dangerously-skip-permissions')
  if (ctx.resume) args.push('--conversation', ctx.resume)
  return args
}

const TOOLS_PROMPT =
  ' The Superagent tools named here (browser_*, board_*, sim_*, create_routine, open_file and ' +
  'the rest) are provided by the MCP server named `cove-browser`.'

const PLAN_MODE_PROMPT =
  ' You are in plan mode: nothing that edits files or runs commands will be allowed to run. ' +
  'Work out what you would do and present the plan for approval.'

/**
 * What Superagent tells the agent about the room it is working in, as the block
 * that travels in front of a conversation's first message. Antigravity has no
 * flag for a system prompt; a conversation that is resumed already carries this.
 */
export function agyBriefing(opts: AgentStartOptions): string {
  return (
    buildAppendedPrompt({
      browserProject: opts.browserProject,
      workspaceId: opts.workspaceId,
      browser: opts.workspaceId
        ? browserName(browserFor(browserScope(opts.workspaceId, opts.chatId)))
        : undefined,
      provider: 'antigravity'
    }) +
    TOOLS_PROMPT +
    (opts.permissionMode === 'plan' ? PLAN_MODE_PROMPT : '')
  )
}

/**
 * A message with the briefing attached. A message that opens with `/` is a
 * skill or command and has to stay at the very start for agy to expand it, so
 * there the briefing follows instead of leading.
 */
export function withBriefing(text: string, briefing: string): string {
  const block = `<system_instructions>\n${briefing}\n</system_instructions>`
  return text.trimStart().startsWith('/') ? `${text}\n\n${block}` : `${block}\n\n${text}`
}

/** Turn a startup failure into the one line a person can act on. */
export function agyStartupReason(detail: string): string {
  if (/ENOENT|not found|no such file/i.test(detail))
    return 'Antigravity is not installed. Install it, then try again.'
  if (isSignInFailure(detail))
    return 'Antigravity is not signed in. Run `agy` in a terminal to sign in, then try again.'
  return detail || 'Antigravity failed to start.'
}

function isSignInFailure(detail: string): boolean {
  return /authenticat|not logged in|log ?in to|sign ?in/i.test(detail)
}

/** A file's text for a diff card, or null when it is missing, huge or binary. */
function readForDiff(path: string): string | null {
  try {
    if (statSync(path).size > 1_000_000) return null
    const text = readFileSync(path, 'utf8')
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

/** A guess at the window, for the gauge: Antigravity does not report one. */
function contextWindowFor(model: string | undefined): number {
  return model && /^claude-/i.test(model) ? 200_000 : 1_000_000
}

/** How long a new process may sit silent before the chat is told it is ready anyway. */
const INIT_GRACE_MS = 4000
/** How long an init waits on the model list before going without it. */
const MODELS_GRACE_MS = 1500
/** How long an interrupted process may take to wind down before it is killed. */
const INTERRUPT_GRACE_MS = 5000

export function startAntigravitySession(
  opts: AgentStartOptions,
  ctx: SessionContext,
  host: SessionHost
): void {
  const cwd = opts.cwd || os.homedir()
  const translator = new AntigravityTranslator({ readFile: readForDiff })
  const sidecarDir = join(
    sidecarRoot(),
    sidecarName(`${opts.chatId || opts.workspaceId || 'chat'}-${randomUUID().slice(0, 8)}`)
  )
  claimSidecar(sidecarDir)
  sweepSidecars(sidecarRoot())

  let proc: ChildProcessWithoutNullStreams | null = null
  /** kill() or hardInterrupt(): the session is over, whatever the process does next. */
  let ended = false
  let conversationId = opts.resumeSessionId ?? ''
  /** Whether the conversation already carries the briefing. A resumed one does. */
  let briefed = !!opts.resumeSessionId
  /** Turns written and not yet answered, oldest first. */
  let unanswered: string[] = []
  /** A soft interrupt is in flight: the process is on its way out. */
  let interrupting = false
  /** Messages that arrived while the process was being interrupted. */
  let afterInterrupt: string[] = []
  /** The fall-back from a lost conversation to a fresh one happens at most once. */
  let triedFresh = false
  let exited = false

  /** What the hook endpoint files this session under: its chat, else its conversation. */
  const gateKey = (): string => opts.chatId || conversationId

  const lifecycle = (event: string): void =>
    reportAgentLifecycle(event, opts.workspaceId ?? '', { session_id: conversationId })

  const emit = (event: StreamJsonEvent): void => {
    const limit = limitFromEvent(event)
    if (limit) host.limit(limit)
    host.event(event)
  }

  const finish = (code: number, reason?: string): void => {
    if (exited) return
    exited = true
    releaseSidecar(sidecarDir)
    forgetHookCalls(gateKey())
    host.exit(code, reason)
  }

  /** Start a process on `resume`, or on a new conversation when there is none. */
  const spawnProc = (resume: string | null): void => {
    let sidecar: string | undefined
    try {
      mkdirSync(pastedImagesDir(), { recursive: true })
      sidecar = writeSidecar({
        dir: sidecarDir,
        // Rewritten on every spawn: both URLs carry this launch's port and secret.
        mcpUrl: opts.workspaceId ? workspaceMcpUrl(opts.workspaceId, opts.chatId) : undefined,
        hookUrl: getHookUrl() || undefined,
        workspaceId: opts.workspaceId,
        chatId: opts.chatId,
        mode: opts.permissionMode
      })
    } catch (err) {
      // No tools is a worse chat, not a dead one.
      console.error('[antigravity] could not write the session folder:', (err as Error).message)
    }

    // Asked alongside the process's own start-up, so it is usually in by init.
    const modelsReady = agyModels().catch(() => [])

    const hooked = !!sidecar && !!getHookUrl()
    const p = spawn(
      findAgy(),
      buildAgyArgs(opts, {
        resume,
        sidecar,
        attachments: pastedImagesDir(),
        // Only when the hook is really on disk: it is what makes the flag safe.
        hooked
      }),
      {
        cwd,
        env: {
          ...process.env,
          ...ctx.env,
          COVE_HOOK_URL: getHookUrl(),
          COVE_MCP_URL: getMcpUrl(),
          ...(opts.workspaceId ? { COVE_WORKSPACE_ID: opts.workspaceId } : {})
        },
        shell: false,
        // Its own process group, so a kill reaches what its commands started.
        detached: DETACH_FOR_TREE_KILL
      }
    ) as ChildProcessWithoutNullStreams
    proc = p

    /** Whether the chat has been told this process is up. */
    let announced = false
    /** Events held back until then, so nothing is shown ahead of the init it follows. */
    let held: StreamJsonEvent[] | null = []
    /** The real init, being dressed. Events behind it wait for it. */
    let pendingInit: Promise<void> | null = null
    /** What a process that never came up said was wrong. */
    let failure = ''
    let stderr = ''

    /** Send an init, then everything that was waiting behind it. */
    const announce = (init: StreamJsonEvent): void => {
      announced = true
      emit(init)
      const waiting = held ?? []
      held = null
      for (const event of waiting) emit(event)
    }

    /** The init the chat is given: Antigravity's own, plus what it does not report. */
    const dressInit = async (init: StreamJsonEvent): Promise<StreamJsonEvent> => {
      // The line-up was asked for when the process started; it is not worth
      // keeping a chat waiting on, so a slow answer just means no picker yet.
      const models = await Promise.race([
        modelsReady,
        new Promise<never[]>((r) => setTimeout(() => r([]), MODELS_GRACE_MS))
      ])
      return {
        type: 'system',
        subtype: 'init',
        cwd,
        ...init,
        ...(models.length ? { models } : {}),
        context_window: contextWindowFor((init.model as string | undefined) ?? opts.model)
      }
    }

    // Antigravity sends `init` once the conversation exists. Should a version
    // hold that until the first message, the chat would wait for an init that
    // is waiting for the chat — so a process still alive after the grace period
    // is announced as it is, and the real init fills in the id when it comes.
    const grace = setTimeout(() => {
      if (proc !== p || announced || pendingInit || ended) return
      void dressInit(conversationId ? { session_id: conversationId } : {}).then((init) => {
        if (proc === p && !announced && !pendingInit) announce(init)
      })
    }, INIT_GRACE_MS)

    const forward = (events: StreamJsonEvent[]): void => {
      if (held) held.push(...events)
      else for (const event of events) emit(event)
    }

    const onLine = (raw: string): void => {
      const line = parseAgyLine(raw)
      if (!line) return
      if (line.event === 'init') {
        clearTimeout(grace)
        const [init] = translator.handle(line)
        if (translator.conversationId) conversationId = translator.conversationId
        // agy only warns about a conversation it cannot find ("conversation …
        // not found") and starts a new one in its place. Nothing failed, so
        // nothing would say that the agent now remembers none of what is on
        // screen — the id it came up with is the only tell.
        if (resume && conversationId && conversationId !== resume && !triedFresh) {
          triedFresh = true
          briefed = false
          host.resumeLost()
        }
        // Whatever follows waits its turn behind the dressed init.
        if (!held) held = []
        pendingInit = dressInit(init).then(announce)
        return
      }
      if (line.event === 'result') {
        if (!announced && !pendingInit) {
          // A result with no init ahead of it is the process failing to start:
          // a rejected model, a missing sign-in, a conversation that is gone.
          const result = (line.result ?? {}) as Record<string, unknown>
          if (typeof result.error === 'string' && result.error) failure = result.error
          return
        }
        unanswered.shift()
        const events = translator.handle(line)
        // A message sent mid-turn is queued by agy into a turn of its own, so
        // this result is not the end of the work: the chat hears about the end
        // once, when the last queued turn is answered.
        const last = events[events.length - 1]
        const more = unanswered.length > 0 && last?.type === 'result' && last.subtype === 'success'
        forward(more ? events.slice(0, -1) : events)
        if (!more) lifecycle('Stop')
        return
      }
      if (line.event === 'step_update' && ungated(line.step_update)) {
        // A gated tool ran and the hook was never asked: the one thing between
        // this mode and a CLI told to approve everything is not there. Stop
        // now rather than find out what else it would run.
        ended = true
        failure =
          "Antigravity ran a tool without asking Superagent's approval hook, so this chat was " +
          'stopped. Use Full access, or update Superagent.'
        forward(translator.handle(line))
        for (const event of translator.abortTurn(false, failure)) forward([event])
        killProcessTree(p, 'SIGKILL')
        return
      }
      forward(translator.handle(line))
    }

    /** A finished tool step this mode gates, that the hook has no record of. */
    const ungated = (raw: unknown): boolean => {
      const su = (raw ?? {}) as Record<string, unknown>
      if (su.step_type !== 'tool' || su.state !== 'DONE') return false
      if (typeof su.step_index !== 'number') return false
      const info = (su.tool_info ?? {}) as Record<string, unknown>
      const name = typeof su.tool_name === 'string' ? su.tool_name : String(info.name ?? '')
      const params = (info.parameters ?? {}) as Record<string, unknown>
      if (!hooked || !needsHook(opts.permissionMode, name, params)) return false
      return !hookSawStep(gateKey(), su.step_index)
    }

    let buffer = ''
    p.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        onLine(raw)
      }
    })

    p.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr = (stderr + text).slice(-4000)
      host.stderr(text)
    })

    // agy exits after an error result, so the next turn can be written into a
    // pipe whose reader is gone; without a listener that EPIPE is an unhandled
    // 'error' and takes the main process down.
    p.stdin.on('error', () => {})

    const gone = (code: number, spawnError?: string): void => {
      clearTimeout(grace)
      if (proc !== p) return
      proc = null
      const settle = (): void => {
        if (ended) return finish(code, failure || undefined)

        if (!announced) {
          const detail = spawnError || failure || lastLine(stderr)
          // The conversation could not be picked up. A fresh one beats a dead
          // chat — unless the reason is one a fresh one would hit too.
          if (resume && !triedFresh && !spawnError && !isSignInFailure(detail)) {
            triedFresh = true
            conversationId = ''
            briefed = false
            host.resumeLost()
            spawnProc(null)
            // Whatever was written to the process that just died never arrived.
            const lost = unanswered
            unanswered = []
            for (const text of lost) deliver(text)
            return
          }
          return finish(code || 1, agyStartupReason(detail))
        }

        // It was up and now it is not: an interrupt, an error result, a crash.
        // The conversation is intact on disk, so the session carries on and the
        // next message starts a process on it.
        const wasInterrupt = interrupting
        interrupting = false
        if (unanswered.length) {
          unanswered = []
          for (const event of translator.abortTurn(wasInterrupt, lastLine(stderr))) emit(event)
          lifecycle('Stop')
        }
        const queued = afterInterrupt
        afterInterrupt = []
        for (const text of queued) deliver(text)
      }
      // The init is dressed asynchronously; let it land before judging whether
      // this process ever came up.
      if (pendingInit) void pendingInit.then(settle)
      else settle()
    }

    p.on('error', (err) => {
      console.error('[antigravity] spawn error:', err.message)
      gone(1, err.message)
    })
    // 'close', not 'exit': the last lines of stdout have been read by then, and
    // a turn that finished must not be reported as cut short.
    p.on('close', (code) => {
      if (code && stderr) console.error('[antigravity] exited', code, stderr.slice(-300))
      gone(code ?? 0)
    })
  }

  /** Write one turn, starting a process for it if there is none. */
  const deliver = (text: string): void => {
    let body = text
    if (!briefed) {
      body = withBriefing(text, agyBriefing(opts))
      briefed = true
    }
    if (!proc || !proc.stdin.writable) {
      if (proc) killProcessTree(proc)
      spawnProc(conversationId || null)
    }
    unanswered.push(body)
    // A new turn clears whatever the last one read off the web.
    if (gateKey()) clearTurn(gateKey())
    lifecycle('UserPromptSubmit')
    proc?.stdin.write(encodeUserTurn(body))
  }

  const waitGone = async (p: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (p.exitCode !== null || p.signalCode !== null) return true
      await new Promise((r) => setTimeout(r, 60))
    }
    return false
  }

  const backend: AgentBackend = {
    get writable() {
      return !ended
    },
    send(text) {
      if (ended) return false
      if (!text) return true
      // The process is on its way out; this goes to the one that replaces it.
      if (interrupting) afterInterrupt.push(text)
      else deliver(text)
      return true
    },
    /**
     * Antigravity's stream input has no interrupt message (a `control_request`
     * ends the session with an error), so the polite route is the signal: on
     * SIGINT it reports the turn as interrupted and exits. The session stays,
     * and the next message resumes the conversation in a new process.
     */
    interrupt() {
      const p = proc
      if (!p || interrupting || unanswered.length === 0) return
      interrupting = true
      // The CLI alone gets the signal, so it can stop what it started itself.
      p.kill('SIGINT')
      setTimeout(() => {
        if (proc === p) killProcessTree(p, 'SIGKILL')
      }, INTERRUPT_GRACE_MS).unref?.()
    },
    async hardInterrupt() {
      ended = true
      const p = proc
      if (!p) {
        finish(0)
        return true
      }
      p.kill('SIGINT')
      if (await waitGone(p, 1500)) return true
      killProcessTree(p, 'SIGKILL')
      return true
    },
    kill() {
      ended = true
      const p = proc
      if (!p) return finish(0)
      p.stdin.end()
      killProcessTree(p)
    }
  }

  host.ready(backend)
  spawnProc(opts.resumeSessionId ?? null)
}

/**
 * Name a conversation via a throwaway one-shot run. Nothing is approved, so no
 * tool can run: a title is text in, text out. A failure is silent.
 */
export async function suggestTitleWithAntigravity(
  cwd: string,
  excerpt: string
): Promise<string | null> {
  const res = await agyRun(
    'Summarize what this conversation is about as a title of at most 6 words. ' +
      'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
      excerpt,
    { cwd, plainText: true, timeoutMs: 20_000 }
  )
  if (!res.ok) return null
  const title = res.text
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
    ?.replace(/^["']|["']$/g, '')
  // A CLI that reports its own failure as prose once became a chat's real title.
  if (title && /^(error|⚠|warning)\b|rate limit/i.test(title)) return null
  return title && title.length <= 80 ? title : null
}
