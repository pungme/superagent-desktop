import { describe, it, expect, vi } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, existsSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: {} }))

import { appBundleOf, WATCH_SCRIPT } from './crash-relaunch'

describe('appBundleOf', () => {
  it('finds the .app around the executable', () => {
    expect(appBundleOf('/Applications/SuperAgent.app/Contents/MacOS/SuperAgent')).toBe(
      '/Applications/SuperAgent.app'
    )
  })
  it('is null when run from source', () => {
    expect(appBundleOf('/tmp/node_modules/electron/dist/electron')).toBeNull()
  })
})

/** Run the watcher against a process that then ends; `open` is a stand-in that leaves a mark. */
function watch(minUptime: number): { mark: string; done: Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'relaunch-'))
  const mark = join(dir, 'opened')
  const fakeOpen = join(dir, 'open')
  writeFileSync(fakeOpen, `#!/bin/sh\ntouch "${mark}"\n`)
  chmodSync(fakeOpen, 0o755)
  const victim = spawn('/bin/sleep', ['1'])
  const script = WATCH_SCRIPT.replace('/usr/bin/open', fakeOpen)
  const w = spawn('/bin/sh', ['-c', script, 'sh', String(victim.pid), '/x.app', String(minUptime)])
  return { mark, done: new Promise((r) => w.on('exit', () => r())) }
}

describe.skipIf(process.platform === 'win32')('the watcher', () => {
  it('opens the app once the process it watches is gone', async () => {
    const { mark, done } = watch(0)
    await done
    expect(existsSync(mark)).toBe(true)
  }, 15_000)

  it('does not when the app died straight after launch', async () => {
    const { mark, done } = watch(60)
    await done
    expect(existsSync(mark)).toBe(false)
  }, 15_000)
})
