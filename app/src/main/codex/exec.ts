import { spawn } from 'child_process'
import os from 'os'
import { findCodex } from '../claude-cli'

/**
 * `codex exec` — Codex's one-shot, non-interactive mode.
 *
 * A chat runs on the app server (see session.ts) because it needs streaming,
 * approvals, steering and interrupts. Two things need none of those: naming a
 * conversation, and running a routine. Both are prompt in, answer out, and for
 * those `codex exec` is the simpler and more robust tool — one process, one
 * turn, exits when it is done.
 */

export interface CodexExecOptions {
  cwd?: string
  model?: string
  /** Where the run may write. Routines get the workspace; a title gets nothing. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Dotted config overrides, same namespace as `codex -c`. */
  config?: Record<string, string>
  /** Don't record this run as a resumable session. */
  ephemeral?: boolean
  timeoutMs?: number
}

export interface CodexExecResult {
  ok: boolean
  /** The agent's final message. */
  text: string
  /** Every JSONL event the run emitted, for callers that render steps. */
  events: Record<string, unknown>[]
  error?: string
}

/**
 * Run one Codex turn to completion.
 *
 * The prompt goes in on stdin rather than as an argument: an argument-length
 * limit is not something a conversation excerpt should ever be able to hit.
 */
export function codexExec(prompt: string, opts: CodexExecOptions = {}): Promise<CodexExecResult> {
  return new Promise((resolve) => {
    const args = [
      'exec',
      '--json',
      // A project folder is not always a git repo, and refusing to run in one
      // would be a surprising place to fail.
      '--skip-git-repo-check',
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.sandbox ? ['--sandbox', opts.sandbox] : []),
      ...(opts.ephemeral ? ['--ephemeral'] : []),
      ...Object.entries(opts.config ?? {}).flatMap(([k, v]) => ['-c', `${k}=${v}`]),
      // Read the prompt from stdin.
      '-'
    ]
    const proc = spawn(findCodex(), args, {
      cwd: opts.cwd || os.homedir(),
      env: process.env,
      shell: false
    })

    const events: Record<string, unknown>[] = []
    let out = ''
    let stderr = ''
    let settled = false

    const done = (result: CodexExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        // already gone
      }
      resolve(result)
    }

    const timer = setTimeout(
      () => done({ ok: false, text: '', events, error: 'timed out' }),
      opts.timeoutMs ?? 20 * 60_000
    )

    proc.stdin.on('error', () => {})
    proc.stdin.end(prompt)

    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (!line) continue
        try {
          events.push(JSON.parse(line))
        } catch {
          // codex prefixes a "Reading additional input from stdin…" notice and
          // can interleave a log line; neither is an event.
        }
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    proc.on('error', (err) => done({ ok: false, text: '', events, error: err.message }))
    proc.on('close', (code) => {
      const failed = events.find(
        (e) => e.type === 'turn.failed' || (e.type === 'error' && !e.willRetry)
      )
      done({
        ok: code === 0 && !failed,
        text: lastAgentMessage(events),
        events,
        ...(code === 0 && !failed
          ? {}
          : { error: codexExecError(failed) ?? meaningfulCodexStderr(stderr) })
      })
    })
  })
}

/** The final thing the agent said, which for a one-shot run is the answer. */
export function lastAgentMessage(events: Record<string, unknown>[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type !== 'item.completed') continue
    const item = e.item as { type?: string; text?: string } | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text
  }
  return ''
}

function codexExecError(failed: Record<string, unknown> | undefined): string | undefined {
  if (!failed) return undefined
  const err = (failed.error ?? failed) as { message?: string }
  return typeof err.message === 'string' ? err.message : undefined
}

/**
 * The one line worth showing out of `codex exec`'s stderr. It logs at INFO with
 * a timestamp and a module path on every line; only the complaint is useful.
 */
export function meaningfulCodexStderr(raw: string): string | undefined {
  const lines = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /ERROR|error:|not logged in|unauthorized|not found/i.test(l))
    .map((l) => l.replace(/^\S*Z\s+(ERROR|WARN)\s+\S+:\s*/, ''))
  return lines.length ? lines[lines.length - 1].slice(0, 300) : undefined
}
