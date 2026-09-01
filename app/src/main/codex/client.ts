import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { findCodex } from '../claude-cli'

/**
 * A JSON-RPC client for `codex app-server --stdio`.
 *
 * Codex's non-interactive `codex exec` runs one process per turn: it cannot
 * stream tokens, cannot be steered mid-turn, cannot be interrupted without
 * throwing the turn away, and has nowhere to answer an approval prompt. The
 * app server is the interface OpenAI's own editor integration uses, and it does
 * all four — so it is what a Superagent chat runs on.
 *
 * This file is deliberately protocol-only: it knows about requests, responses
 * and notifications, and nothing about Superagent. Translating what comes out
 * into the event vocabulary the rest of the app speaks is `translate.ts`.
 */

/** The subset of the protocol we depend on. Anything else passes through as a raw notification. */
export interface CodexThreadOptions {
  cwd: string
  model?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  /** Appended to the system prompt — Codex's answer to `--append-system-prompt`. */
  developerInstructions?: string
  /** Dotted config overrides, same namespace as `codex -c`. Used to inject MCP servers. */
  config?: Record<string, unknown>
}

export interface CodexServerRequest {
  method: string
  params: Record<string, unknown>
  /** Answer the server. Exactly one of respond/respondError must be called. */
  respond: (result: unknown) => void
  respondError: (message: string) => void
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
}

/**
 * Emits:
 *  - 'notification' (method: string, params: Record<string, unknown>)
 *  - 'request'      (req: CodexServerRequest)
 *  - 'stderr'       (text: string)
 *  - 'exit'         (code: number | null)
 *  - 'error'        (err: Error)   — spawn failure
 */
export class CodexClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private seq = 0
  private pending = new Map<number, Pending>()
  private closed = false

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    super()
  }

  get alive(): boolean {
    return !!this.proc && !this.closed && this.proc.exitCode === null
  }

  /** Spawn the server and complete the initialize handshake. */
  async start(clientVersion: string): Promise<void> {
    const proc = spawn(findCodex(), ['app-server', '--stdio'], {
      env: this.env,
      shell: false
    }) as ChildProcessWithoutNullStreams
    this.proc = proc

    // Writing to a server that has already closed stdin throws EPIPE; without a
    // listener that becomes an unhandled 'error' and takes down the main process.
    proc.stdin.on('error', () => {})

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')))
    proc.on('error', (err) => {
      this.closed = true
      this.failPending(err)
      this.emit('error', err)
    })
    proc.on('exit', (code) => {
      this.closed = true
      this.failPending(new Error(`codex app-server exited (${code ?? 0})`))
      this.emit('exit', code)
    })

    await this.request('initialize', {
      clientInfo: { name: 'superagent', title: 'Superagent', version: clientVersion },
      capabilities: null
    })
    this.notify('initialized', {})
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        // The server logs to stderr, so a non-JSON stdout line is a protocol
        // hiccup rather than output. Skipping it keeps the stream in sync.
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : null

    // A response to something we asked.
    if (typeof id === 'number' && !method) {
      const waiting = this.pending.get(id)
      this.pending.delete(id)
      if (!waiting) return
      if (msg.error) waiting.reject(new Error(JSON.stringify(msg.error)))
      else waiting.resolve((msg.result as Record<string, unknown>) ?? {})
      return
    }

    // A request FROM the server — approvals, elicitations. It blocks the turn
    // until answered, so every path out of the handler must reply.
    if (id !== undefined && method) {
      let answered = false
      const reply = (payload: Record<string, unknown>): void => {
        if (answered || !this.alive) return
        answered = true
        this.write({ jsonrpc: '2.0', id, ...payload })
      }
      this.emit('request', {
        method,
        params: (msg.params as Record<string, unknown>) ?? {},
        respond: (result: unknown) => reply({ result }),
        respondError: (message: string) => reply({ error: { code: -32000, message } })
      } satisfies CodexServerRequest)
      return
    }

    if (method) this.emit('notification', method, (msg.params as Record<string, unknown>) ?? {})
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) return
    this.proc.stdin.write(JSON.stringify(payload) + '\n')
  }

  private failPending(err: Error): void {
    for (const [, waiting] of this.pending) waiting.reject(err)
    this.pending.clear()
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new Error('codex app-server is not running'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  stop(): void {
    this.closed = true
    this.failPending(new Error('stopped'))
    try {
      this.proc?.kill()
    } catch {
      // already gone
    }
  }

  // --- the handful of calls a chat actually makes ------------------------

  async threadStart(opts: CodexThreadOptions): Promise<string> {
    const res = await this.request('thread/start', {
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
      ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
      ...(opts.config ? { config: opts.config } : {})
    })
    return threadIdOf(res)
  }

  /**
   * Re-open an existing thread. Everything a fresh thread is configured with has
   * to be sent again — a resumed thread inherits the recorded conversation, not
   * the client's settings, so omitting them silently drops the MCP servers and
   * the system prompt on every chat that survived a restart.
   */
  async threadResume(threadId: string, opts: CodexThreadOptions): Promise<string> {
    const res = await this.request('thread/resume', {
      threadId,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
      ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
      ...(opts.config ? { config: opts.config } : {})
    })
    return threadIdOf(res)
  }

  async turnStart(threadId: string, input: unknown[]): Promise<string> {
    const res = await this.request('turn/start', { threadId, input })
    const turn = res.turn as { id?: string } | undefined
    return turn?.id ?? ''
  }

  /** Add to a turn that is already running, rather than queueing behind it. */
  async turnSteer(threadId: string, turnId: string, input: unknown[]): Promise<void> {
    await this.request('turn/steer', { threadId, input, expectedTurnId: turnId })
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId })
  }

  /**
   * The models this account can actually use.
   *
   * Asked rather than hardcoded: Codex's line-up moves, and a baked-in list goes
   * stale silently — the picker would keep offering a model that no longer exists
   * and quietly fall back to the default.
   */
  async modelList(): Promise<{ id: string; label: string; hint: string; isDefault: boolean }[]> {
    try {
      const res = await this.request('model/list', {})
      const items = (res.data ?? res.models ?? res.items ?? []) as Record<string, unknown>[]
      return items
        .filter((m) => m.hidden !== true)
        .map((m) => ({
          id: String(m.id ?? m.model ?? ''),
          label: String(m.displayName ?? m.label ?? m.id ?? ''),
          hint: String(m.description ?? ''),
          isDefault: m.isDefault === true
        }))
        .filter((m) => m.id)
    } catch {
      return []
    }
  }
}

/** thread/start and thread/resume both answer with a Thread object. */
function threadIdOf(res: Record<string, unknown>): string {
  const thread = res.thread as { id?: string } | undefined
  return thread?.id ?? String(res.threadId ?? '')
}
