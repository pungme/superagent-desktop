import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '9.9.9' } }))
const { summariseCrashReport, buildDiagnostics } = await import('./diagnostics')

describe('diagnostics', () => {
  it('cuts a macOS crash report down to what says why', () => {
    const head = JSON.stringify({
      app_version: '2.1.0',
      build_version: '1',
      os_version: 'macOS 26'
    })
    const body = JSON.stringify({
      exception: { type: 'EXC_BAD_ACCESS' },
      termination: { namespace: 'SIGNAL' },
      faultingThread: 0,
      usedImages: [{ name: 'Electron Framework' }],
      threads: [{ frames: [{ symbol: 'foo', imageIndex: 0 }] }]
    })
    const out = summariseCrashReport(`${head}\n${body}`)
    expect(out).toContain('EXC_BAD_ACCESS')
    expect(out).toContain('Electron Framework: foo')
    expect(out).toContain('2.1.0')
  })

  it('makes a report even when there are no logs at all', () => {
    const text = buildDiagnostics()
    expect(text).toContain('Superagent 9.9.9')
    expect(text).toContain('Crashes, hangs and errors the app noted:')
  })
})
