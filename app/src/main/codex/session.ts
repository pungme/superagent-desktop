import { app } from 'electron'
import { basename } from 'path'
import os from 'os'
import { CodexClient, type CodexServerRequest, type CodexThreadOptions } from './client'
import { CodexTranslator, unwrapShellCommand } from './translate'
import { codexExec } from './exec'
import { buildAppendedPrompt } from '../prompts'
import { workspaceMcpUrl } from '../mcp'
import { requestApproval, reportAgentLifecycle } from '../hooks'
import type { AgentBackend, AgentStartOptions, SessionContext, SessionHost } from '../agent-backend'

/**
 * The Codex backend.
 *
 * Codex's own non-interactive mode (`codex exec`) runs one process per turn: no
 * token streaming, no way to answer an approval, no mid-turn steering, and an
 * interrupt that throws the turn away. Superagent already has all four on Claude
 * Code, so a chat runs on `codex app-server` instead — the same interface
 * OpenAI's editor integration uses — and everything it emits is translated into
 * the event vocabulary the rest of the app already speaks (see translate.ts).
 *
 * Everything Codex-specific lives in this directory. It imports nothing from
 * `claude/`, and `claude/` imports nothing from here.
 */

/**
 * Superagent's four permission modes in Codex's vocabulary.
 *
 * Codex splits the one decision Claude expresses as a permission mode into two:
 * how much the sandbox allows outright, and when it stops to ask. Plan mode is
 * the only inexact fit — Codex has no plan mode, so it gets a read-only sandbox
 * and is told to produce a plan, which behaves the same from the user's side.
 */
export function codexPermissions(mode: AgentStartOptions['permissionMode']): {
  sandbox: NonNullable<CodexThreadOptions['sandbox']>
  approvalPolicy: NonNullable<CodexThreadOptions['approvalPolicy']>
} {
  switch (mode) {
    case 'ask':
      return { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    case 'plan':
      return { sandbox: 'read-only', approvalPolicy: 'never' }
    case 'bypassPermissions':
    default:
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  }
}

const PLAN_MODE_PROMPT =
  ' You are in plan mode: the workspace is read-only. Work out what you would do and present ' +
  'the plan for approval. Do not edit files or run commands that change anything.'

/** Everything the thread is configured with, for a fresh start and for a resume alike. */
export function codexThreadOptions(opts: AgentStartOptions): CodexThreadOptions {
  const { sandbox, approvalPolicy } = codexPermissions(opts.permissionMode)
  const mcpUrl = opts.workspaceId ? workspaceMcpUrl(opts.workspaceId, opts.chatId) : ''
  return {
    cwd: opts.cwd || os.homedir(),
    ...(opts.model ? { model: opts.model } : {}),
    sandbox,
    approvalPolicy,
    developerInstructions:
      buildAppendedPrompt({
        browserProject: opts.browserProject,
        workspaceId: opts.workspaceId,
        provider: 'codex'
      }) + (opts.permissionMode === 'plan' ? PLAN_MODE_PROMPT : ''),
    // Superagent's own tools reach Codex the same way they reach Claude Code —
    // as an MCP server — but per thread rather than via a config file, so a
    // chat's browser pane and board are scoped to that chat.
    ...(mcpUrl ? { config: { mcp_servers: { 'cove-browser': { url: mcpUrl } } } } : {})
  }
}

export function startCodexSession(
  opts: AgentStartOptions,
  _ctx: SessionContext,
  host: SessionHost
): void {
  const client = new CodexClient()
  const translator = new CodexTranslator()
  const threadOptions = codexThreadOptions(opts)

  let threadId = ''
  let activeTurn: string | null = null
  let ended = false
  /** Messages that arrived before the thread was open. Flushed once it is. */
  const queued: { text: string; imagePaths: string[] }[] = []

  const finish = (code: number, reason?: string): void => {
    if (ended) return
    ended = true
    host.exit(code, reason)
  }

  // --- approvals ---------------------------------------------------------
  // Codex asks over the wire, which is why a Codex chat needs none of the
  // `~/.claude/settings.json` hook installation: the request arrives here and
  // goes straight to the same approval bus the Mac modal and the phone read.
  const onRequest = (req: CodexServerRequest): void => {
    const p = req.params
    const decide = async (toolName: string, preview: string): Promise<boolean> => {
      // The turn is blocked on a person now — same beat Claude's Notification
      // hook reports, so the badge and the phone say so either way.
      reportAgentLifecycle('Notification', opts.workspaceId ?? '', {
        session_id: threadId,
        message: preview.split('\n')[0].slice(0, 120)
      })
      const ok = await requestApproval(
        opts.workspaceId ?? '',
        threadId,
        toolName,
        preview,
        'permission'
      )
      reportAgentLifecycle('UserPromptSubmit', opts.workspaceId ?? '', { session_id: threadId })
      return ok
    }

    switch (req.method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval': {
        const command = typeof p.command === 'string' ? unwrapShellCommand(p.command) : '(command)'
        const reason = typeof p.reason === 'string' && p.reason ? `\n${p.reason}` : ''
        void decide('Bash', command.slice(0, 400) + reason).then((ok) =>
          req.respond({ decision: ok ? 'accept' : 'decline' })
        )
        return
      }
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval': {
        const root = typeof p.grantRoot === 'string' ? p.grantRoot : ''
        const preview = root ? `Write files under ${root}` : 'Apply a file change'
        void decide('Edit', preview).then((ok) =>
          req.respond({ decision: ok ? 'accept' : 'decline' })
        )
        return
      }
      case 'item/permissions/requestApproval': {
        // A request for extra reach (network, a directory outside the workspace).
        // We have no UI for granting a partial profile, so the honest answer to
        // "may I have more?" is no — the turn continues inside its sandbox.
        req.respondError('Superagent does not grant additional permissions mid-turn.')
        return
      }
      case 'mcpServer/elicitation/request': {
        const server = typeof p.serverName === 'string' ? p.serverName : 'a tool'
        const message = typeof p.message === 'string' ? p.message : ''
        void decide(`mcp__${server}`, message || `${server} wants to run a tool`).then((ok) =>
          req.respond({ action: ok ? 'accept' : 'decline', content: null, _meta: null })
        )
        return
      }
      default:
        // Anything we don't implement must still be answered, or the turn hangs
        // waiting on a reply that is never coming.
        req.respondError(`Superagent does not handle ${req.method}.`)
    }
  }

  // --- the backend the rest of the app talks to --------------------------

  const encode = (text: string, imagePaths: string[]): unknown[] => [
    // A path, not base64: Codex reads the file itself, and the copy on disk is
    // the one that survives a resumed thread.
    ...imagePaths.map((path) => ({ type: 'localImage', path })),
    ...(text ? [{ type: 'text', text, text_elements: [] }] : [])
  ]

  const deliver = (text: string, imagePaths: string[]): void => {
    const input = encode(text, imagePaths)
    if (!input.length) return
    // Mid-turn: steer rather than queue, so a correction lands on the work in
    // progress instead of waiting for it to finish being wrong.
    const turn = activeTurn
    if (turn) {
      client
        .turnSteer(threadId, turn, input)
        .catch(() => client.turnStart(threadId, input).then((t) => (activeTurn = t)))
      return
    }
    client
      .turnStart(threadId, input)
      .then((t) => {
        activeTurn = t
      })
      .catch((err: Error) => finish(1, err.message))
  }

  const backend: AgentBackend = {
    get writable() {
      return !ended && client.alive
    },
    send(text, _images, imagePaths) {
      if (!client.alive) return false
      if (!threadId) {
        queued.push({ text, imagePaths })
        return true
      }
      deliver(text, imagePaths)
      return true
    },
    interrupt() {
      if (activeTurn) void client.turnInterrupt(threadId, activeTurn).catch(() => {})
    },
    async hardInterrupt() {
      if (activeTurn) {
        await client.turnInterrupt(threadId, activeTurn).catch(() => {})
        // Give the server a beat to wind the turn down cleanly before the socket
        // goes; an abrupt kill can leave the last item unrecorded on the thread.
        await new Promise((r) => setTimeout(r, 250))
      }
      ended = true
      client.stop()
      return true
    },
    kill() {
      ended = true
      client.stop()
    }
  }

  // --- wiring ------------------------------------------------------------

  // Claude Code drives the workspace badge and the "is done" notification
  // through its hooks; Codex has none, so the session reports the same beats
  // straight off the protocol. Without this a Codex chat would sit on a stale
  // status and never ping you when a long turn finished while you were away.
  const lifecycle = (event: string): void =>
    reportAgentLifecycle(event, opts.workspaceId ?? '', { session_id: threadId })

  client.on('notification', (method: string, params: Record<string, unknown>) => {
    if (method === 'turn/started') {
      const turn = params.turn as { id?: string } | undefined
      activeTurn = turn?.id ?? activeTurn
      translator.startTurn()
      lifecycle('UserPromptSubmit')
      return
    }
    if (method === 'turn/completed') activeTurn = null
    for (const event of translator.handle(method, params)) host.event(event)
    if (method === 'turn/completed') lifecycle('Stop')
  })

  client.on('request', onRequest)

  client.on('stderr', (text: string) => {
    // The server logs at INFO on stderr; only a real complaint is worth showing.
    if (/\bERROR\b|\bWARN\b|panicked/.test(text)) host.stderr(text)
  })

  client.on('error', (err: Error) => finish(1, err.message))
  client.on('exit', (code: number | null) => finish(code ?? 0))

  // --- start -------------------------------------------------------------

  const open = async (): Promise<void> => {
    await client.start(app.getVersion())
    const resume = opts.resumeSessionId
    if (resume) {
      try {
        threadId = await client.threadResume(resume, threadOptions)
      } catch {
        // The recorded thread is gone (cleaned up, or written by another
        // machine). A fresh one beats a dead chat, but the conversation on
        // screen now has an agent that remembers none of it.
        host.resumeLost()
        threadId = await client.threadStart(threadOptions)
      }
    } else {
      threadId = await client.threadStart(threadOptions)
    }
    if (!threadId) throw new Error('codex did not return a thread')

    // The renderer waits for init before it enables the composer. Codex has no
    // equivalent event, so the session synthesises the one the app expects — and
    // carries along the two things Claude cannot report: the real model list for
    // the picker, and the model's real context window for the gauge.
    const [skills, models] = await Promise.all([
      listSkills(client, threadOptions.cwd),
      client.modelList()
    ])
    host.event({
      type: 'system',
      subtype: 'init',
      session_id: threadId,
      model: threadOptions.model || models.find((m) => m.isDefault)?.id || 'codex',
      slash_commands: skills,
      cwd: threadOptions.cwd,
      models,
      ...(translator.modelContextWindow ? { context_window: translator.modelContextWindow } : {})
    })

    for (const q of queued.splice(0)) deliver(q.text, q.imagePaths)
  }

  host.ready(backend)
  void open().catch((err: Error) => finish(1, codexStartupReason(err)))
}

/**
 * Codex's skills show up in the same "/" menu as Claude's slash commands. A
 * failure here is not worth failing a session over — the menu just has fewer
 * entries in it.
 */
async function listSkills(client: CodexClient, cwd: string): Promise<string[]> {
  try {
    const res = await client.request('skills/list', { cwds: [cwd] })
    const data = (res.data as Record<string, unknown>[] | undefined) ?? []
    return data
      .map((entry) => String(entry.name ?? basename(String(entry.path ?? ''))))
      .filter(Boolean)
      .map((name) => (name.startsWith('/') ? name : `/${name}`))
  } catch {
    return []
  }
}

/** Turn a startup failure into the one line a person can act on. */
export function codexStartupReason(err: Error): string {
  const message = err.message || 'Codex failed to start.'
  if (/ENOENT|not found/i.test(message))
    return 'Codex is not installed. Install it, then try again.'
  if (/not (logged in|authenticated)|unauthor/i.test(message))
    return 'Codex is not signed in. Run `codex login` in a terminal, then try again.'
  return message
}

/**
 * Name a conversation via a throwaway `codex exec`. Read-only and ephemeral: a
 * title is text in, text out, and it should leave no session behind.
 */
export async function suggestTitleWithCodex(cwd: string, excerpt: string): Promise<string | null> {
  const res = await codexExec(
    'Summarize what this conversation is about as a title of at most 6 words. ' +
      'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
      excerpt,
    { cwd, sandbox: 'read-only', ephemeral: true, timeoutMs: 20_000 }
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
