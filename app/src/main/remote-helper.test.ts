import { describe, expect, it, vi } from 'vitest'
import { offLimitsApp } from '../shared/computer-use'

/**
 * What remote control borrows from computer-use.ts, with the helper process
 * faked: which runs Stop cuts short, and what a failed run says. No process is
 * started, nothing is posted.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn() },
  clipboard: { readText: () => '', writeText: vi.fn() },
  desktopCapturer: {},
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  ipcMain: { handle: vi.fn() },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } })
  },
  shell: {},
  systemPreferences: {}
}))
vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  // The helper "exists": it is never run, execFile below is the fake.
  existsSync: () => true
}))

interface Fake {
  args: string[]
  killed: boolean
  done: (e: Error | null, out: string) => void
}
const helperRuns: Fake[] = []
vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    done: (e: Error | null, out: string) => void
  ) => {
    // The system's own questions (the app in front) answer at once.
    if (cmd.endsWith('lsappinfo')) {
      done(
        null,
        args[0] === 'front'
          ? 'ASN:0x0-0x1001:'
          : '"Front" ASN:0x0-0x1001: \n    bundleID="com.apple.TextEdit"'
      )
      return undefined
    }
    // The helper: held until the test finishes it.
    const run: Fake = { args, killed: false, done }
    helperRuns.push(run)
    return {
      kill: () => {
        run.killed = true
        done(new Error('killed'), '')
      }
    }
  }
}))
vi.mock('./store', () => ({ getChat: () => undefined, kvGet: () => undefined, kvSet: vi.fn() }))
vi.mock('./util', () => ({ broadcastToWindows: vi.fn() }))

const {
  act,
  appUnder,
  grantConsent,
  killRunningHelper,
  runHelper,
  sawFront,
  stopComputerUse,
  windowLayout
} = await import('./computer-use')

describe('the helper, as remote control uses it', () => {
  it('says one fixed thing when a run fails, never the error message with the typed text in it', async () => {
    helperRuns.length = 0
    const p = runHelper(['type', 'hunter2'])
    helperRuns[0].done(
      new Error(
        'Command failed: /Applications/Superagent.app/Contents/Resources/helper type hunter2'
      ),
      ''
    )
    expect(await p).toEqual({ ok: false, error: 'The Mac did not do that.' })
    const q = runHelper(['type', 'x'])
    helperRuns[1].done(new Error('boom'), JSON.stringify({ ok: false, error: 'unknown key' }))
    expect((await q).error).toBe('The Mac did not do that.')
    const r = runHelper(['key', 'a'])
    helperRuns[2].done(null, '{"ok":true}')
    expect(await r).toEqual({ ok: true, error: '' })
  })

  it("ending a remote session cuts short its own runs and leaves a computer-use agent's alone", async () => {
    helperRuns.length = 0
    stopComputerUse()
    // A computer-use agent is typing, and the phone is dragging.
    grantConsent('agent')
    sawFront('agent', 'com.apple.TextEdit')
    const agent = act('agent', { type: 'key', keys: 'a' })
    await vi.waitFor(() => expect(helperRuns).toHaveLength(1))
    const remote = runHelper(['dragto', '5', '5'])
    await vi.waitFor(() => expect(helperRuns).toHaveLength(2))
    const [agentRun, remoteRun] = helperRuns
    expect(agentRun.args[0]).toBe('key')
    expect(remoteRun.args[0]).toBe('dragto')
    killRunningHelper()
    expect(remoteRun.killed).toBe(true)
    expect(agentRun.killed).toBe(false)
    expect(await remote).toMatchObject({ ok: false })
    agentRun.done(null, '{"ok":true}')
    await agent
  })

  it('⌥Esc, which stops computer use, cuts short remote control runs as well', async () => {
    helperRuns.length = 0
    const remote = runHelper(['dragto', '5', '5'])
    await vi.waitFor(() => expect(helperRuns).toHaveLength(1))
    stopComputerUse()
    expect(helperRuns[0].killed).toBe(true)
    expect(await remote).toMatchObject({ ok: false })
  })
})

describe('what is under a point, as remote control asks it', () => {
  it('says nobody when the helper says nobody (the desktop), and says it does not know when it fails', async () => {
    helperRuns.length = 0
    const none = appUnder(10, 10)
    helperRuns[0].done(null, '{}')
    expect(await none).toBeNull()
    const some = appUnder(10, 10)
    helperRuns[1].done(null, JSON.stringify({ name: 'Notes', bundle: 'com.apple.Notes' }))
    expect(await some).toMatchObject({ id: 'com.apple.Notes' })
    // Timed out, killed, could not start: never the same as nobody.
    const failed = appUnder(10, 10)
    helperRuns[2].done(new Error('timed out'), '')
    await expect(failed).rejects.toThrow()
    const refused = appUnder(10, 10)
    helperRuns[3].done(null, JSON.stringify({ ok: false, error: 'nope' }))
    await expect(refused).rejects.toThrow()
  })
})

describe('system prompts that are not in any app, as the layout and the point lookup read them', () => {
  it('the layout names a window with no bundle by its process name, as appUnder does', async () => {
    helperRuns.length = 0
    const p = windowLayout()
    helperRuns[0].done(
      null,
      JSON.stringify({
        windows: [
          { name: 'coreautha', bundle: '', layer: 8, x: 0, y: 0, w: 300, h: 200 },
          { name: 'Window Server', bundle: '', layer: 0, x: 0, y: 0, w: 10, h: 10 },
          { name: 'Notes', bundle: 'com.apple.Notes', layer: 0, x: 0, y: 0, w: 10, h: 10 }
        ]
      })
    )
    const w = await p
    expect(w[0].app).toEqual({ id: 'name:coreautha', name: 'coreautha' })
    expect(w[1].app).toBeNull()
    expect(w[2].app).toMatchObject({ id: 'com.apple.Notes' })
    expect(offLimitsApp(w[0].app?.id)).toBeTruthy()
    const at = appUnder(1, 1)
    helperRuns[1].done(null, JSON.stringify({ name: 'coreautha', bundle: '', layer: 2000 }))
    expect(await at).toEqual({ id: 'name:coreautha', name: 'coreautha' })
  })
})
