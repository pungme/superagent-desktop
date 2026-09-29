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
  /**
   * An earlier version of a family the list also carries current (Opus 4.8
   * beside Opus 5.5). Pickers fold these away: the CLI began listing every
   * version still available, and eleven rows buried the five that matter.
   */
  older?: true
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
  // The CLI lists each family newest first, so the first Opus is the current
  // one and any Opus after it is an older version.
  const seen = new Set<string>()
  return models.flatMap((raw: CliModel) => {
    if (!raw || typeof raw.value !== 'string' || typeof raw.displayName !== 'string') return []
    const label = raw.displayName.replace(/\s*\([^)]*\)\s*$/, '') || raw.displayName
    const family = label.split(/\s+/)[0].toLowerCase()
    const option: ModelOption = {
      id: raw.value === 'default' ? '' : raw.value,
      label,
      hint: typeof raw.description === 'string' ? raw.description : ''
    }
    if (seen.has(family)) option.older = true
    seen.add(family)
    return [option]
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
