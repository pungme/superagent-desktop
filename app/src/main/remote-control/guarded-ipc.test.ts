import { describe, expect, it, vi } from 'vitest'
import { registerPairingIpc, registerSwitchIpc, type IpcLike } from './guarded-ipc'

/** A fake ipcMain: remembers each channel's handler so a test can call it as a renderer would. */
function fakeIpc(): {
  ipc: IpcLike
  call: (channel: string, e: unknown, ...args: unknown[]) => unknown
  channels: () => string[]
} {
  const fns = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  return {
    ipc: {
      handle: (c, fn) => void fns.set(c, fn),
      on: (c, fn) => void fns.set(c, fn)
    },
    call: (c, e, ...a) => fns.get(c)!(e, ...a),
    channels: () => [...fns.keys()]
  }
}

const main = { who: 'main' }
const intruder = { who: 'dot or a sub-frame' }
const trusted = (e: unknown): boolean => e === main

describe('pairing channels', () => {
  const make = (): {
    f: ReturnType<typeof fakeIpc>
    a: Record<'start' | 'cancel' | 'decide' | 'revoke' | 'setRelay', ReturnType<typeof vi.fn>>
  } => {
    const f = fakeIpc()
    const a = {
      start: vi.fn(() => ({ payload: 'p', code: '123' })),
      cancel: vi.fn(),
      decide: vi.fn(),
      revoke: vi.fn(),
      setRelay: vi.fn()
    }
    registerPairingIpc(f.ipc, trusted, a)
    return { f, a }
  }

  it('registers every channel that decides who is paired, and each does its work for the main window', () => {
    const { f, a } = make()
    expect(f.channels().sort()).toEqual(
      [
        'companion:pair-cancel',
        'companion:pair-decide',
        'companion:pair-start',
        'companion:revoke',
        'companion:set-relay'
      ].sort()
    )
    expect(f.call('companion:pair-start', main)).toEqual({ payload: 'p', code: '123' })
    f.call('companion:pair-cancel', main)
    f.call('companion:pair-decide', main, true)
    f.call('companion:revoke', main, 'dev-1')
    f.call('companion:set-relay', main, 'wss://relay.example')
    expect(a.cancel).toHaveBeenCalledOnce()
    expect(a.decide).toHaveBeenCalledWith(true)
    expect(a.revoke).toHaveBeenCalledWith('dev-1')
    expect(a.setRelay).toHaveBeenCalledWith('wss://relay.example')
  })

  it('does nothing for anyone else, and the pairing payload is never handed out', () => {
    const { f, a } = make()
    expect(() => f.call('companion:pair-start', intruder)).toThrow()
    f.call('companion:pair-cancel', intruder)
    f.call('companion:pair-decide', intruder, true)
    f.call('companion:revoke', intruder, 'dev-1')
    f.call('companion:set-relay', intruder, 'wss://evil.example')
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('the two switches', () => {
  const make = (
    ok = true
  ): { f: ReturnType<typeof fakeIpc>; d: Record<string, ReturnType<typeof vi.fn>> } => {
    const f = fakeIpc()
    const d = {
      confirm: vi.fn(async () => ok),
      isEnabled: vi.fn(() => true),
      setEnabled: vi.fn(),
      setShells: vi.fn(),
      status: vi.fn(() => 'status')
    }
    registerSwitchIpc(f.ipc, trusted, d as never)
    return { f, d }
  }

  it('turns on only for the main window and after a yes at the Mac', async () => {
    const { f, d } = make()
    expect(await f.call('remote:set-enabled', main, true)).toBe('status')
    expect(d.setEnabled).toHaveBeenCalledWith(true)
    await f.call('remote:set-shells', main, true)
    expect(d.setShells).toHaveBeenCalledWith(true)
    expect(d.confirm).toHaveBeenCalledTimes(2)
    const no = make(false)
    await no.f.call('remote:set-enabled', main, true)
    await no.f.call('remote:set-shells', main, true)
    expect(no.d.setEnabled).not.toHaveBeenCalled()
    expect(no.d.setShells).not.toHaveBeenCalled()
  })

  it('does nothing for anyone else, on or off, and never asks', async () => {
    const { f, d } = make()
    await f.call('remote:set-enabled', intruder, true)
    await f.call('remote:set-enabled', intruder, false)
    await f.call('remote:set-shells', intruder, true)
    await f.call('remote:set-shells', intruder, false)
    expect(d.setEnabled).not.toHaveBeenCalled()
    expect(d.setShells).not.toHaveBeenCalled()
    expect(d.confirm).not.toHaveBeenCalled()
  })
})
