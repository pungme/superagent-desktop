import { app, powerMonitor, webContents } from 'electron'
import { Session } from 'node:inspector'
import { execFile } from 'child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { cpus, loadavg } from 'os'
import { basename, join } from 'path'

/**
 * What the Mac was doing when it last felt frozen.
 *
 * 2026-10-19 and 2026-10-20: the Mac froze and had to be hard-reset, both
 * times while Superagent had agents working. The system log of those minutes
 * shows WindowServer dropping events for forty apps at once — the whole
 * machine stalling, not one app hanging — and then nothing: a hard reset
 * leaves no crash report, no memory figures, no process list. memory.log only
 * knew our own heap, which was fine both times.
 *
 * So this leaves a trail of the system itself in the same file: free memory
 * and swap, load, every Electron process of ours and every process the agents
 * spawned, a line every few minutes and at once when memory is under pressure
 * or the main thread notices it was not scheduled for a while. Reading
 * `pressure` or `stall` lines after the next freeze says what was eating the
 * Mac; the hope is that it never has to.
 */

export interface SystemSample {
  at: number
  totalKB: number
  freeKB: number
  swapUsedKB: number
  load1: number
  cpuCount: number
}

export type Pressure = 'ok' | 'swapping' | 'low-memory' | 'overloaded'

/** Swap this deep means the machine is paging in earnest, whatever "free" says. */
export const SWAPPING_KB = 6 * 1024 * 1024
/** macOS keeps "free" small by design (file cache is used memory): alone it says little. */
export const LOW_FREE_FRACTION = 0.03
export const LOW_FREE_SWAP_KB = 1024 * 1024

/** The state of the machine, from one sample. Pure, so the thresholds can be tested. */
export function pressureVerdict(s: SystemSample): Pressure {
  if (s.swapUsedKB >= SWAPPING_KB) return 'swapping'
  if (s.totalKB > 0 && s.freeKB / s.totalKB < LOW_FREE_FRACTION && s.swapUsedKB >= LOW_FREE_SWAP_KB)
    return 'low-memory'
  if (s.cpuCount > 0 && s.load1 >= 2 * s.cpuCount) return 'overloaded'
  return 'ok'
}

/** A one-second timer that fired this late was starved: the machine, or main, was stuck. */
export const STALL_MS = 1500

/** How late a timer was, when that is worth a line; null when it was on time. */
export function stallVerdict(expectedAt: number, firedAt: number): number | null {
  const late = firedAt - expectedAt
  return late >= STALL_MS ? Math.round(late) : null
}

export interface Proc {
  pid: number
  ppid: number
  rssKB: number
  cpu: number
  name: string
}

/** `ps -axo pid=,ppid=,rss=,pcpu=,comm=` as rows. Pure, so it can be tested. */
export function parsePs(text: string): Proc[] {
  const rows: Proc[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKB: Number(m[3]),
      cpu: Number(m[4]),
      name: basename(m[5]).replace(/ Helper.*/, '')
    })
  }
  return rows
}

/** Everything under `root`: the agents, their shells, builds and browsers. */
export function descendants(rows: Proc[], root: number): Proc[] {
  const byParent = new Map<number, Proc[]>()
  for (const r of rows) {
    const list = byParent.get(r.ppid) ?? []
    list.push(r)
    byParent.set(r.ppid, list)
  }
  const out: Proc[] = []
  const walk = (pid: number): void => {
    for (const c of byParent.get(pid) ?? []) {
      out.push(c)
      walk(c.pid)
    }
  }
  walk(root)
  return out
}

/** A window process this busy, twice in a row, is worth a look inside. */
export const HOT_RENDERER_PERCENT = 120
/** The bar in use: a test lowers it, since a test page cannot burn more than one core. */
const hotPercent = (): number =>
  Number(process.env.COVE_HOT_RENDERER_PERCENT) || HOT_RENDERER_PERCENT

/**
 * The renderer worth profiling, if any: the hottest one, when it was hot on the
 * previous sample too. Pure, so the rule can be tested.
 */
export function hotRenderer(
  metrics: { type: string; pid: number; cpu: { percentCPUUsage: number } }[],
  previousHot: Set<number>,
  bar = HOT_RENDERER_PERCENT
): number | null {
  const tabs = metrics
    .filter((m) => m.type === 'Tab' && m.cpu.percentCPUUsage >= bar)
    .sort((a, b) => b.cpu.percentCPUUsage - a.cpu.percentCPUUsage)
  const again = tabs.find((m) => previousHot.has(m.pid))
  return again ? again.pid : null
}

interface CpuProfile {
  nodes: {
    id: number
    callFrame: { functionName: string; url: string; lineNumber: number }
    children?: number[]
  }[]
  samples: number[]
  timeDeltas: number[]
}

/** The functions a CPU profile spent its own time in, one line. Pure. */
export function profileSummary(p: CpuProfile, top = 8): string {
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const self = new Map<string, number>()
  let total = 0
  let idle = 0
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i])
    const dt = p.timeDeltas[i] || 0
    total += dt
    if (!n) continue
    const f = n.callFrame
    if (f.functionName === '(idle)') {
      idle += dt
      continue
    }
    const file = (f.url || '').split('/').pop() || ''
    const key = `${f.functionName || '(anon)'}${file ? ` ${file}:${f.lineNumber + 1}` : ''}`
    self.set(key, (self.get(key) || 0) + dt)
  }
  const ms = (us: number): string => `${Math.round(us / 1000)}ms`
  const list = [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, v]) => `${k}=${ms(v)}`)
    .join(' ')
  return `busy ${total ? Math.round(((total - idle) / total) * 100) : 0}% of ${ms(total)}: ${list}`
}

const mb = (kb: number): string => `${Math.round(kb / 1024)}M`
const gb = (kb: number): string => `${(kb / 1048576).toFixed(1)}G`

/** The heaviest processes on the Mac, ours marked, one line. */
export function topLine(rows: Proc[], ours: Set<number>, n = 8): string {
  return [...rows]
    .sort((a, b) => b.rssKB - a.rssKB)
    .slice(0, n)
    .map((r) => `${ours.has(r.pid) ? '*' : ''}${r.name}:${mb(r.rssKB)}/${r.cpu.toFixed(0)}%`)
    .join(' ')
}

/** Our Electron processes summed by kind, from app.getAppMetrics(). */
export function metricsLine(metrics: Electron.ProcessMetric[]): string {
  const by = new Map<string, { n: number; kb: number; cpu: number }>()
  for (const m of metrics) {
    const kind = m.type === 'Tab' ? 'renderer' : m.type.toLowerCase()
    const e = by.get(kind) ?? { n: 0, kb: 0, cpu: 0 }
    e.n++
    e.kb += m.memory.workingSetSize
    e.cpu += m.cpu.percentCPUUsage
    by.set(kind, e)
  }
  return [...by.entries()].map(([k, e]) => `${k}=${e.n}×${mb(e.kb)}/${e.cpu.toFixed(0)}%`).join(' ')
}

export function healthLog(line: string): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'memory.log'),
      `${new Date().toISOString()} ${line}\n`
    )
  } catch {
    /* logging must never break the app */
  }
}

/** `sysctl -n vm.swapusage` says "total = 4096.00M  used = 1536.00M  free = ...": the used figure, in KB. */
export function parseSwapUsage(text: string): number {
  const m = /used\s*=\s*([\d.]+)([KMG])/i.exec(text)
  if (!m) return 0
  const n = Number(m[1])
  return Math.round(
    m[2].toUpperCase() === 'G' ? n * 1048576 : m[2].toUpperCase() === 'M' ? n * 1024 : n
  )
}

/** Electron reports swap on Windows and Linux only; on a Mac, sysctl knows. */
function swapUsedKB(): Promise<number> {
  const m = process.getSystemMemoryInfo() as { swapUsed?: number }
  if (typeof m.swapUsed === 'number') return Promise.resolve(m.swapUsed)
  return new Promise((resolve) => {
    execFile('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 5000 }, (err, out) =>
      resolve(err ? 0 : parseSwapUsage(out))
    )
  })
}

async function sample(): Promise<SystemSample> {
  const m = process.getSystemMemoryInfo()
  return {
    at: Date.now(),
    totalKB: m.total,
    freeKB: m.free,
    swapUsedKB: await swapUsedKB(),
    load1: loadavg()[0],
    cpuCount: cpus().length
  }
}

function ps(): Promise<Proc[]> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='],
      { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
      (err, out) => resolve(err ? [] : parsePs(out))
    )
  })
}

/** %CPU of these processes as ps reports it (100 = one core). */
function cpuOf(pids: number[]): Promise<Map<number, number>> {
  if (!pids.length) return Promise.resolve(new Map())
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-o', 'pid=,pcpu=', '-p', pids.join(',')],
      { timeout: 5000 },
      (err, out) => {
        const m = new Map<number, number>()
        if (!err)
          for (const line of out.split('\n')) {
            const [pid, cpu] = line.trim().split(/\s+/)
            if (pid) m.set(Number(pid), Number(cpu))
          }
        resolve(m)
      }
    )
  })
}

/** One full picture: the machine, our processes, and what the agents spawned. */
async function snapshot(why: string): Promise<void> {
  const s = await sample()
  const rows = await ps()
  // Electron's own CPU figures are divided by the core count; ps is the scale
  // Activity Monitor shows, so the line reads the way the user reads it.
  const cpuByPid = new Map(rows.map((r) => [r.pid, r.cpu]))
  const electron = app.getAppMetrics().map((m) => ({
    ...m,
    cpu: { ...m.cpu, percentCPUUsage: cpuByPid.get(m.pid) ?? m.cpu.percentCPUUsage }
  }))
  const ours = descendants(rows, process.pid)
  const ourPids = new Set(ours.map((r) => r.pid))
  ourPids.add(process.pid)
  // Not our Electron helpers, and not the ps/sysctl this very line is made from.
  const spawned = ours.filter((r) => !/^(SuperAgent|Electron|ps|sysctl)$/.test(r.name))
  healthLog(
    `${why} free=${gb(s.freeKB)}/${gb(s.totalKB)} swap=${gb(s.swapUsedKB)} ` +
      `load=${s.load1.toFixed(1)}/${s.cpuCount} ` +
      `electron[${metricsLine(electron)}] ` +
      `spawned=${spawned.length}×${mb(spawned.reduce((n, r) => n + r.rssKB, 0))} ` +
      `top[${topLine(rows, ourPids)}]`
  )
}

/**
 * Look inside a window that stays hot: attach to it, sample its JavaScript for
 * five seconds, keep the profile and log the hottest functions. 2026-10-20 the
 * window sat at 150% of a core for an hour and nothing on the Mac could say in
 * what; a profile of a copy of the data on another build said one thing, and
 * the real answer was wanted from the real window.
 */
async function profileRenderer(pid: number): Promise<void> {
  const wc = webContents.getAllWebContents().find((w) => w.getOSProcessId() === pid)
  if (!wc || wc.isDestroyed()) return
  const dbg = wc.debugger
  if (dbg.isAttached()) return
  try {
    dbg.attach('1.3')
    await dbg.sendCommand('Profiler.enable')
    await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 1000 })
    await dbg.sendCommand('Profiler.start')
    await new Promise((r) => setTimeout(r, 5000))
    const { profile } = (await dbg.sendCommand('Profiler.stop')) as { profile: CpuProfile }
    const dir = join(app.getPath('userData'), 'diagnostics')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(dir, `renderer-${pid}-${stamp}.cpuprofile`), JSON.stringify(profile))
    healthLog(
      `profile pid=${pid} url=${wc.getURL().split('#')[1] ?? 'app'} ${profileSummary(profile)}`
    )
  } catch (err) {
    healthLog(`profile pid=${pid} failed: ${String((err as Error)?.message ?? err)}`)
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach()
    } catch {
      /* already gone */
    }
  }
}

/**
 * The same look inside the main process, which is where the app freezes: a
 * window can be slow, but main busy means every window, every agent's output
 * and every click waits. Sampled in-process (the inspector fuses forbid
 * attaching from outside, on purpose). 2026-10-22: main at 85–225% of a core
 * with stalls of seconds, and no record of what it was doing.
 */
export const HOT_MAIN_PERCENT = 80
async function profileMain(): Promise<void> {
  const s = new Session()
  const post = <T>(method: string, params: object = {}): Promise<T> =>
    new Promise((res, rej) => s.post(method, params, (e, r) => (e ? rej(e) : res(r as T))))
  try {
    s.connect()
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 1000 })
    await post('Profiler.start')
    await new Promise((r) => setTimeout(r, 4000))
    const { profile } = await post<{ profile: CpuProfile }>('Profiler.stop')
    const dir = join(app.getPath('userData'), 'diagnostics')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(dir, `main-${stamp}.cpuprofile`), JSON.stringify(profile))
    healthLog(`profile main ${profileSummary(profile)}`)
  } catch (err) {
    healthLog(`profile main failed: ${String((err as Error)?.message ?? err)}`)
  } finally {
    try {
      s.disconnect()
    } catch {
      /* already gone */
    }
  }
}

/** One profile per window this often at most: it is a look, not a watch. */
const PROFILE_EVERY_MS = 10 * 60_000

/** A quiet line this often. */
const EVERY_MS = 5 * 60_000
/** Under pressure or stalling, no more than one full picture this often. */
const ALARM_EVERY_MS = 30_000

let started = false

export function startHealthWatch(): void {
  if (started) return
  started = true
  let lastAlarm = 0
  const alarm = (why: string): void => {
    const now = Date.now()
    if (now - lastAlarm < ALARM_EVERY_MS) return
    lastAlarm = now
    void snapshot(why)
  }

  // The periodic picture, and the pressure check that rides on it.
  let hot = new Set<number>()
  const profiledAt = new Map<number, number>()
  let mainHot = false
  let mainProfiledAt = 0
  setInterval(() => {
    void sample().then((s) => {
      const p = pressureVerdict(s)
      if (p !== 'ok') alarm(`pressure ${p}`)
    })
    // A window burning more than a core, two samples running: profile it.
    // Measured with ps, the scale Activity Monitor uses (100 = one core):
    // Electron's own percentCPUUsage comes back divided by the core count
    // (measured 2026-10-21: 5.1% for a window ps put at 90.7%, on 18 cores),
    // so no bar on it could ever trip.
    const tabs = app.getAppMetrics().filter((m) => m.type === 'Tab')
    void cpuOf([process.pid, ...tabs.map((m) => m.pid)]).then((cpu) => {
      // Main hot twice running: look inside it too.
      const mainCpu = cpu.get(process.pid) ?? 0
      const nowHot = mainCpu >= (Number(process.env.COVE_HOT_MAIN_PERCENT) || HOT_MAIN_PERCENT)
      if (nowHot && mainHot && Date.now() - mainProfiledAt > PROFILE_EVERY_MS) {
        mainProfiledAt = Date.now()
        alarm(`hot main cpu=${Math.round(mainCpu)}%`)
        void profileMain()
      }
      mainHot = nowHot
      const metrics = tabs.map((m) => ({
        type: m.type,
        pid: m.pid,
        cpu: { percentCPUUsage: cpu.get(m.pid) ?? 0 }
      }))
      const pid = hotRenderer(metrics, hot, hotPercent())
      hot = new Set(metrics.filter((m) => m.cpu.percentCPUUsage >= hotPercent()).map((m) => m.pid))
      if (pid !== null && Date.now() - (profiledAt.get(pid) ?? 0) > PROFILE_EVERY_MS) {
        profiledAt.set(pid, Date.now())
        const at = Math.round(metrics.find((m) => m.pid === pid)!.cpu.percentCPUUsage)
        alarm(`hot renderer pid=${pid} cpu=${at}%`)
        void profileRenderer(pid)
      }
    })
  }, 15_000).unref()
  setInterval(() => void snapshot('sys'), EVERY_MS).unref()
  setTimeout(() => void snapshot('sys'), 20_000).unref()

  // A one-second heartbeat: how late it fires is how long main — or the whole
  // Mac — was not running. The agents' own work never runs on this thread, so
  // a stall here is the machine, or something in main that should not be.
  let expected = Date.now() + 1000
  setInterval(() => {
    const now = Date.now()
    const late = stallVerdict(expected, now)
    expected = now + 1000
    if (late !== null) alarm(`stall main=${late}ms`)
  }, 1000).unref()

  try {
    powerMonitor.on('thermal-state-change', (state) => healthLog(`thermal ${state}`))
  } catch {
    /* not every platform reports it */
  }
}
