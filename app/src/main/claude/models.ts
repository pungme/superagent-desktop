import { spawn } from 'child_process'
import os from 'os'
import { ipcMain } from 'electron'
import { findClaude } from '../claude-cli'

/**
 * Claude Code's own model line-up, asked of the installed CLI rather than
 * written down here.
 *
 * The picker used to hardcode "Opus 5 · …" hints, which went stale with every
 * model release (Opus 5.5 shipped and the menu still said Opus 5). The CLI
 * answers a stream-json `initialize` control request with the exact list its
 * own /model picker shows — ids, names and descriptions, "Default" included,
 * resolved for this account — so we show that instead.
 */

export interface ModelOption {
  /** Passed as --model. '' is Default: no flag, the CLI picks. */
  id: string
  label: string
  hint: string
}

/** One entry of the CLI's `initialize` response `models` array. */
interface CliModel {
  value?: unknown
  displayName?: unknown
  description?: unknown
}

/**
 * CLI entries → picker options. "Default (recommended)" and "Opus (1M context)"
 * become "Default" and "Opus": the label is the pill, the hint carries the rest.
 */
export function toModelOptions(models: unknown): ModelOption[] {
  if (!Array.isArray(models)) return []
  return models.flatMap((raw: CliModel) => {
    if (!raw || typeof raw.value !== 'string' || typeof raw.displayName !== 'string') return []
    return [
      {
        id: raw.value === 'default' ? '' : raw.value,
        label: raw.displayName.replace(/\s*\([^)]*\)\s*$/, '') || raw.displayName,
        hint: typeof raw.description === 'string' ? raw.description : ''
      }
    ]
  })
}

let cached: ModelOption[] | null = null
let inflight: Promise<ModelOption[] | null> | null = null

/** Last successful answer, if any — for callers that can't wait. */
export function cachedClaudeModels(): ModelOption[] | null {
  return cached
}

/**
 * Spawn a throwaway `claude`, send `initialize`, read the models off the reply,
 * and kill it. Nothing is sent to the model, so it costs no tokens. Resolves
 * null on any failure (not installed, signed out, timeout) — the caller keeps
 * its fallback list.
 */
function probe(timeoutMs = 20_000): Promise<ModelOption[] | null> {
  return new Promise((resolve) => {
    let done = false
    const proc = spawn(
      findClaude(),
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: os.homedir(), shell: false }
    )
    const finish = (result: ModelOption[] | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    proc.on('error', () => finish(null))
    proc.on('exit', () => finish(null))
    proc.stdin.on('error', () => {})
    let buffer = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.includes('"control_response"')) continue
        try {
          const ev = JSON.parse(line)
          if (ev?.response?.request_id !== 'models') continue
          const options = toModelOptions(ev.response.response?.models)
          finish(options.length ? options : null)
        } catch {
          // not the line we want
        }
      }
    })
    proc.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'models',
        request: { subtype: 'initialize' }
      }) + '\n'
    )
  })
}

/** The line-up, probed at most once at a time and cached for the app's life. */
export function getClaudeModels(): Promise<ModelOption[] | null> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = probe().then((result) => {
      if (result) cached = result
      inflight = null
      return result
    })
  }
  return inflight
}

export function registerClaudeModelsIpc(): void {
  ipcMain.handle('claude:models', () => getClaudeModels())
  // Warm it off the startup path so the first picker open already has it.
  void getClaudeModels()
}
