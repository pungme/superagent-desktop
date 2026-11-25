import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * "Turn off every simulator" is for an agent the person asked to, and nothing
 * is turned off unless the person says yes in the app's own dialog.
 */
const h = vi.hoisted(() => ({
  calls: [] as string[][],
  released: [] as string[],
  devices: [] as { udid: string; name: string; state: string }[]
}))

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (): void => undefined
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (
    _cmd: string,
    args: string[]
  ) => {
    h.calls.push(args)
    if (args[1] === 'list')
      return { stdout: JSON.stringify({ devices: { 'iOS 26': h.devices } }), stderr: '' }
    return { stdout: '', stderr: '' }
  }
  return { execFile }
})
vi.mock('./store', () => ({ kvGet: () => null, kvSet: () => undefined, getChat: () => undefined }))
vi.mock('./simulator', () => ({
  chatHoldingSimulator: () => null,
  openSimulators: () => [],
  releaseSimulatorHelpers: (udid: string) => h.released.push(udid)
}))
vi.mock('./health', () => ({ healthLog: () => undefined }))

const { shutDownAllSimulators } = await import('./sim-cleanup')

describe('shutDownAllSimulators', () => {
  beforeEach(() => {
    h.calls.length = 0
    h.released.length = 0
    h.devices = [
      { udid: 'A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'B', name: 'iPhone 17e', state: 'Shutdown' },
      { udid: 'C', name: 'iPad', state: 'Booted' }
    ]
  })
  const shutdowns = (): string[] => h.calls.filter((a) => a[1] === 'shutdown').map((a) => a[2])

  it('turns off every running device, and only those, once the person agrees', async () => {
    const asked: string[][] = []
    const r = await shutDownAllSimulators(async (names) => (asked.push(names), true))
    expect(asked).toEqual([['iPhone 17', 'iPad']])
    expect(shutdowns()).toEqual(['A', 'C'])
    expect(h.released).toEqual(['A', 'C'])
    expect(r).toEqual({ done: ['iPhone 17', 'iPad'], declined: false })
  })

  it('turns off nothing when the person declines', async () => {
    const r = await shutDownAllSimulators(async () => false)
    expect(shutdowns()).toEqual([])
    expect(h.released).toEqual([])
    expect(r.declined).toBe(true)
  })

  it('does not even ask when nothing is running', async () => {
    h.devices = [{ udid: 'B', name: 'iPhone 17e', state: 'Shutdown' }]
    let asked = false
    const r = await shutDownAllSimulators(async () => ((asked = true), true))
    expect(asked).toBe(false)
    expect(r).toEqual({ done: [], declined: false })
  })
})
