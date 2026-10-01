import { spawn, execFile } from 'child_process'
import os from 'os'
import { findAgy } from '../claude-cli'
import { killProcessTree, trackOneShot, DETACH_FOR_TREE_KILL } from '../kill-tree'
import {
  AntigravityTranslator,
  encodeUserTurn,
  parseAgyLine,
  type StreamJsonEvent
} from './translate'

/**
 * One Antigravity turn, start to finish, outside any chat.
 *
 * A chat keeps an `agy` process open and feeds it turns (see session.ts). Two
 * things need none of that: naming a conversation, and running a routine. Both
 * are prompt in, answer out — one process, one turn, exits when it is done.
 *
 * It speaks the same stream-json a session does rather than `-p "<prompt>"`: the
 * prompt goes in on stdin, where an argument-length limit cannot reach it, and
 * the steps come back as they happen instead of as one envelope at the end.
 */

export interface AgyRunOptions {
  cwd?: string
  /** Extra directories the run may read: a session folder, attachments. */
  addDirs?: string[]
  model?: string
  /** Approve every tool call. For unattended runs with nobody to ask. */
  skipPermissions?: boolean
  /** Leave a leading `/name` in the prompt alone rather than expanding it. */
  plainText?: boolean
  timeoutMs?: number
  env?: Record<string, string>
  /** Called with each translated event as it arrives. */
  onEvent?: (event: StreamJsonEvent) => void
}

export interface AgyRunResult {
  ok: boolean
  /** The agent's final answer. */
  text: string
  /** Every translated event the run produced, for callers that render steps. */
  events: StreamJsonEvent[]
  error?: string
}

/** The command line for a one-shot run. Pure, so it can be tested. */
export function agyRunArgs(opts: AgyRunOptions): string[] {
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // Without this the tools work in Antigravity's own scratch folder, whatever
    // the process's working directory is.
    '--add-dir',
    opts.cwd || os.homedir(),
    ...(opts.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
    ...(opts.plainText ? ['--disable-slash-commands'] : []),
    // 0 waits for the turn; the caller's own timeout is what bounds the run.
    '--print-timeout',
    '0',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : [])
  ]
}

export function agyRun(prompt: string, opts: AgyRunOptions = {}): Promise<AgyRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(findAgy(), agyRunArgs(opts), {
      cwd: opts.cwd || os.homedir(),
      env: { ...process.env, ...opts.env },
      shell: false,
      detached: DETACH_FOR_TREE_KILL
    })
    trackOneShot(proc)

    const translator = new AntigravityTranslator()
    const events: StreamJsonEvent[] = []
    let text = ''
    let error = ''
    let ok = false
    let answered = false
    let stderr = ''
    let settled = false

    const done = (result: AgyRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killProcessTree(proc)
      resolve(result)
    }
    const timer = setTimeout(
      () => done({ ok: false, text, events, error: 'The run timed out.' }),
      opts.timeoutMs ?? 120_000
    )

    let buffer = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = parseAgyLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        if (line.event === 'result') {
          const result = (line.result ?? {}) as Record<string, unknown>
          answered = true
          ok = result.status === 'SUCCESS'
          if (typeof result.response === 'string') text = result.response
          if (typeof result.error === 'string') error = result.error
        }
        for (const event of translator.handle(line)) {
          events.push(event)
          opts.onEvent?.(event)
        }
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    proc.stdin.on('error', () => {})
    proc.on('error', (err) => done({ ok: false, text, events, error: err.message }))
    proc.on('close', () =>
      done({
        ok: answered && ok,
        text: text.trim(),
        events,
        ...(answered && ok
          ? {}
          : { error: error || lastLine(stderr) || 'Antigravity did not answer.' })
      })
    )

    // One turn, then end of input: agy answers the turn it was given and exits.
    proc.stdin.write(encodeUserTurn(prompt))
    proc.stdin.end()
  })
}

/** The last thing agy said on stderr, without its `error:` marker. */
export function lastLine(stderr: string): string {
  const lines = stderr
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('AGY_ERROR:'))
  return (lines[lines.length - 1] ?? '').replace(/^(error|warning):\s*/i, '')
}

export interface AgyModel {
  id: string
  label: string
  hint: string
}

/**
 * `agy models` prints one model per line — a slug, then its name:
 *
 *     gemini-3.8-flash-high     Gemini 3.8 Flash (High)
 *
 * The reasoning tier is part of the slug rather than a separate setting, so the
 * tier in the name's brackets is the hint and the rest is the label.
 */
export function parseAgyModels(out: string): AgyModel[] {
  const models: AgyModel[] = []
  for (const raw of out.split('\n')) {
    // Columns are padded with spaces on a terminal and split by a tab in a pipe.
    const m = raw.trim().match(/^([a-z0-9][\w.-]*)(?:\t+|\s{2,})(\S.*)$/i)
    if (!m) continue
    const tier = m[2].match(/\(([^)]*)\)\s*$/)
    models.push({
      id: m[1],
      label: m[2].replace(/\s*\([^)]*\)\s*$/, '') || m[2],
      hint: tier ? tier[1] : ''
    })
  }
  return models
}

let cachedModels: AgyModel[] | null = null
let inflight: Promise<AgyModel[]> | null = null

/**
 * The model line-up of the signed-in account, asked of the CLI and cached for
 * the app's life. Empty on any failure — the picker then offers Default alone.
 */
export function agyModels(timeoutMs = 15_000): Promise<AgyModel[]> {
  if (cachedModels) return Promise.resolve(cachedModels)
  if (!inflight) {
    inflight = new Promise<AgyModel[]>((resolve) => {
      execFile(
        findAgy(),
        ['models'],
        { cwd: os.homedir(), timeout: timeoutMs, encoding: 'utf8' },
        (err, stdout) => {
          const models = err ? [] : parseAgyModels(stdout)
          if (models.length) cachedModels = models
          inflight = null
          resolve(models)
        }
      )
    })
  }
  return inflight
}
