import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir, arch, release, totalmem } from 'os'
import { join } from 'path'

/**
 * What to send when the app has been crashing: one block of text a person can
 * copy from Settings and paste to us. Facts about the app and this Mac, the
 * crashes and hangs the app itself noted, and the macOS crash reports that name
 * it, cut down to what says why. Nothing of the user's conversations is in it.
 */

function tail(path: string, keep: (line: string) => boolean, max: number): string[] {
  try {
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf8')
    // The last megabyte is plenty, and keeps a huge log from being read whole.
    const part = text.length > 1_500_000 ? text.slice(-1_500_000) : text
    return part
      .split('\n')
      .filter((l) => l && keep(l))
      .slice(-max)
      .map((l) => l.slice(0, 400))
  } catch {
    return []
  }
}

/** The part of a macOS .ips crash report that says what happened. */
export function summariseCrashReport(raw: string): string {
  try {
    const nl = raw.indexOf('\n')
    const head = JSON.parse(raw.slice(0, nl)) as Record<string, unknown>
    const body = JSON.parse(raw.slice(nl + 1)) as {
      exception?: Record<string, unknown>
      termination?: Record<string, unknown>
      faultingThread?: number
      threads?: { frames?: { symbol?: string; imageIndex?: number }[] }[]
      usedImages?: { name?: string }[]
    }
    const lines = [
      `app ${String(head.app_version ?? '?')} (${String(head.build_version ?? '?')}), macOS ${String(head.os_version ?? '?')}`,
      `exception: ${JSON.stringify(body.exception ?? {})}`,
      `termination: ${JSON.stringify(body.termination ?? {})}`
    ]
    const th = body.threads?.[body.faultingThread ?? 0]
    for (const f of (th?.frames ?? []).slice(0, 10)) {
      const img = body.usedImages?.[f.imageIndex ?? -1]?.name ?? '?'
      lines.push(`  ${img}: ${f.symbol ?? '?'}`)
    }
    return lines.join('\n')
  } catch {
    return raw.slice(0, 600)
  }
}

function macCrashReports(): string[] {
  const dir = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
  try {
    const week = Date.now() - 7 * 24 * 3600 * 1000
    const files = readdirSync(dir)
      .filter((f) => /super.?agent|electron/i.test(f) && /\.(ips|crash)$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .filter((x) => x.t > week)
      .sort((a, b) => b.t - a.t)
      .slice(0, 5)
    return files.map(
      ({ f }) =>
        `${f}\n${summariseCrashReport(readFileSync(join(dir, f), 'utf8')).replace(/^/gm, '  ')}`
    )
  } catch {
    return []
  }
}

export function buildDiagnostics(): string {
  const userData = app.getPath('userData')
  const memory = join(userData, 'memory.log')
  const out: string[] = []
  out.push(
    `Superagent ${app.getVersion()} · Electron ${process.versions.electron} · macOS ${release()} ${arch()} · ${Math.round(totalmem() / 1073741824)} GB`,
    `Report made ${new Date().toISOString()}`,
    ''
  )
  out.push('Starts (a restart after a crash shows as a start):')
  out.push(...tail(memory, (l) => / start version=/.test(l), 10).map((l) => '  ' + l))
  out.push('', 'Crashes, hangs and errors the app noted:')
  const noted = tail(memory, (l) => /CRASH|HANG|unresponsive|uncaught|rejection|gone/i.test(l), 30)
  out.push(...(noted.length ? noted.map((l) => '  ' + l) : ['  none']))
  const pane = tail(
    join(userData, 'pane-debug.log'),
    (l) => /uncaught-exception|render-process-gone/.test(l),
    10
  )
  if (pane.length) out.push('', 'From the pane log:', ...pane.map((l) => '  ' + l))
  out.push('', 'Memory, latest:')
  out.push(...tail(memory, (l) => / sys free=| pressure /.test(l), 6).map((l) => '  ' + l))
  out.push('', 'Update log, errors:')
  const upd = tail(join(userData, 'updater.log'), (l) => /error|fail/i.test(l), 8)
  out.push(...(upd.length ? upd.map((l) => '  ' + l) : ['  none']))
  const crashes = macCrashReports()
  out.push('', 'macOS crash reports from the last week:')
  out.push(...(crashes.length ? crashes : ['  none']))
  return out.join('\n').slice(0, 60_000)
}
