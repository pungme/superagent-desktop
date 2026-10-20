import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, powerMonitor: { on: () => undefined } }))

import {
  pressureVerdict,
  stallVerdict,
  parsePs,
  descendants,
  topLine,
  metricsLine,
  parseSwapUsage,
  hotRenderer,
  profileSummary,
  SWAPPING_KB,
  STALL_MS
} from './health'

const GB = 1024 * 1024
const calm = { at: 0, totalKB: 48 * GB, freeKB: 6 * GB, swapUsedKB: 0, load1: 4, cpuCount: 18 }

describe('pressureVerdict', () => {
  it('is quiet on an ordinary busy Mac, even with little "free" memory', () => {
    expect(pressureVerdict(calm)).toBe('ok')
    // macOS keeps free small on purpose; without swap that means nothing.
    expect(pressureVerdict({ ...calm, freeKB: 0.5 * GB })).toBe('ok')
  })

  it('calls deep swap swapping, whatever free says', () => {
    expect(pressureVerdict({ ...calm, freeKB: 6 * GB, swapUsedKB: SWAPPING_KB })).toBe('swapping')
  })

  it('calls little free memory plus some swap low-memory', () => {
    expect(pressureVerdict({ ...calm, freeKB: 0.5 * GB, swapUsedKB: 2 * GB })).toBe('low-memory')
  })

  it('calls a load far past the core count overloaded', () => {
    expect(pressureVerdict({ ...calm, load1: 40 })).toBe('overloaded')
    expect(pressureVerdict({ ...calm, load1: 30 })).toBe('ok')
  })
})

describe('stallVerdict', () => {
  it('ignores ordinary jitter and reports a late heartbeat in whole milliseconds', () => {
    expect(stallVerdict(1000, 1400)).toBeNull()
    expect(stallVerdict(1000, 1000 + STALL_MS)).toBe(STALL_MS)
    expect(stallVerdict(1000, 8200.4)).toBe(7200)
  })
})

describe('process list', () => {
  const text = [
    '  1     0  12000  0.0 /sbin/launchd',
    ' 500     1 400000  3.5 /Applications/SuperAgent.app/Contents/MacOS/SuperAgent',
    ' 501   500 900000 12.0 /Applications/SuperAgent.app/Contents/Frameworks/SuperAgent Helper (Renderer).app/Contents/MacOS/SuperAgent Helper (Renderer)',
    ' 600   500 180000  1.0 /Users/me/.nvm/versions/node/v22/bin/node',
    ' 601   600  50000 90.0 /usr/bin/xcodebuild',
    ' 700     1 6000000 2.0 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    'garbage line'
  ].join('\n')

  it('parses ps output and shortens names', () => {
    const rows = parsePs(text)
    expect(rows).toHaveLength(6)
    expect(rows[2]).toEqual({ pid: 501, ppid: 500, rssKB: 900000, cpu: 12, name: 'SuperAgent' })
    expect(rows[5].name).toBe('Brave Browser')
  })

  it('finds everything the app spawned, grandchildren included', () => {
    const ours = descendants(parsePs(text), 500).map((r) => r.pid)
    expect(ours).toEqual([501, 600, 601])
  })

  it('lists the heaviest processes with ours marked', () => {
    const rows = parsePs(text)
    expect(topLine(rows, new Set([500, 501, 600, 601]), 3)).toBe(
      'Brave Browser:5859M/2% *SuperAgent:879M/12% *SuperAgent:391M/4%'
    )
  })

  it('sums Electron processes by kind', () => {
    const line = metricsLine([
      { type: 'Browser', memory: { workingSetSize: 300 * 1024 }, cpu: { percentCPUUsage: 2 } },
      { type: 'Tab', memory: { workingSetSize: 500 * 1024 }, cpu: { percentCPUUsage: 10 } },
      { type: 'Tab', memory: { workingSetSize: 700 * 1024 }, cpu: { percentCPUUsage: 1 } },
      { type: 'GPU', memory: { workingSetSize: 200 * 1024 }, cpu: { percentCPUUsage: 5 } }
    ] as unknown as Electron.ProcessMetric[])
    expect(line).toBe('browser=1×300M/2% renderer=2×1200M/11% gpu=1×200M/5%')
  })
})

describe('parseSwapUsage', () => {
  it('reads the used figure from sysctl, in KB', () => {
    expect(parseSwapUsage('total = 4096.00M  used = 1536.50M  free = 2559.50M  (encrypted)')).toBe(
      1573376
    )
    expect(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)')).toBe(0)
    expect(parseSwapUsage('total = 8.00G  used = 6.50G  free = 1.50G')).toBe(6815744)
    expect(parseSwapUsage('nonsense')).toBe(0)
  })
})

describe('a hot window', () => {
  const m = (pid: number, cpu: number, type = 'Tab') => ({
    type,
    pid,
    cpu: { percentCPUUsage: cpu }
  })
  it('is profiled only when hot twice running, and the hottest one first', () => {
    expect(hotRenderer([m(1, 150), m(2, 130)], new Set())).toBeNull()
    expect(hotRenderer([m(1, 150), m(2, 130)], new Set([1, 2]))).toBe(1)
    expect(hotRenderer([m(1, 90), m(2, 130)], new Set([1, 2]))).toBe(2)
    // The main process or the GPU getting hot is not a window to profile.
    expect(hotRenderer([m(3, 200, 'Browser'), m(4, 200, 'GPU')], new Set([3, 4]))).toBeNull()
  })

  it('summarises a profile by self time, leaving idle out', () => {
    const profile = {
      nodes: [
        {
          id: 1,
          callFrame: { functionName: '(root)', url: '', lineNumber: 0 },
          children: [2, 3, 4]
        },
        { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 0 } },
        { id: 3, callFrame: { functionName: 'EasyChat', url: '/x/App-abc.js', lineNumber: 9415 } },
        { id: 4, callFrame: { functionName: '', url: '/x/App-abc.js', lineNumber: 11 } }
      ],
      samples: [2, 2, 3, 3, 3, 4],
      timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000]
    }
    expect(profileSummary(profile)).toBe(
      'busy 67% of 6ms: EasyChat App-abc.js:9416=3ms (anon) App-abc.js:12=1ms'
    )
  })
})
