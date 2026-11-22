import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * What the phone recorded about its own freezes, kept on the Mac where it can be
 * read: the phone keeps no report of a stall under iOS's ten-second watchdog, so
 * "the app froze" left nothing behind. The phone sends two kinds:
 *
 *  - `hang`: its own watcher noticed the main thread stop answering, with what was
 *    on screen (which chat, how many events, its longest text) and how long.
 *  - `metrickit`: Apple's MetricKit diagnostic payload, with the main thread's
 *    call stack during the hang.
 *
 * One file per report under `<userData>/phone-diagnostics/`, newest kept.
 */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024
export const KEEP_REPORTS = 200

export type DiagnosticKind = 'hang' | 'metrickit'

/** A name safe to use as a file name, from what the phone sent. */
export function reportFileName(
  device: string,
  kind: DiagnosticKind,
  id: string,
  now = Date.now()
): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'x'
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return `${stamp}_${clean(device)}_${kind}_${clean(id)}.json`
}

/**
 * Store one report. Refuses what is not a report: an unknown kind, an empty or
 * oversized body, a body that is not JSON. Returns the file written, or an error.
 */
export function savePhoneDiagnostic(
  dir: string,
  device: string,
  params: unknown,
  now = Date.now()
): { ok: true; file: string } | { ok: false; error: string } {
  const p = (params ?? {}) as { kind?: unknown; id?: unknown; body?: unknown }
  if (p.kind !== 'hang' && p.kind !== 'metrickit') return { ok: false, error: 'kind' }
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id' }
  if (typeof p.body !== 'string' || !p.body || Buffer.byteLength(p.body) > MAX_REPORT_BYTES)
    return { ok: false, error: 'body' }
  try {
    JSON.parse(p.body)
  } catch {
    return { ok: false, error: 'body is not JSON' }
  }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, reportFileName(device, p.kind, p.id, now))
  writeFileSync(file, p.body)
  prune(dir)
  return { ok: true, file }
}

function prune(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (b.f < a.f ? -1 : 1))
  for (const { f } of files.slice(KEEP_REPORTS)) rmSync(join(dir, f), { force: true })
}
