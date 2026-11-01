import { mayFlip, onlyTrusted, type Asker } from './switches'

/**
 * The IPC channels that decide who may pair a phone, point the app at a relay,
 * remove a phone, or switch remote control on, registered here so that the sender
 * check is one thing in one place and a test with a fake `ipcMain` proves every
 * channel has it. Each is answered only for the main window's top frame
 * (`trusted`); anyone else gets nothing done (a handled call throws).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface IpcLike {
  handle(channel: string, fn: (e: any, ...args: any[]) => unknown): void
  on(channel: string, fn: (e: any, ...args: any[]) => void): void
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Trusted = (e: any) => boolean

export function registerPairingIpc(
  ipc: IpcLike,
  trusted: Trusted,
  a: {
    start(): unknown
    cancel(): void
    decide(accepted: boolean): void
    revoke(id: string): void
    setRelay(url: string): void
  }
): void {
  ipc.handle('companion:pair-start', (e: Asker) => {
    // The pairing payload and code: only the main window may ask for them.
    if (!trusted(e)) throw new Error('not allowed')
    return a.start()
  })
  ipc.on(
    'companion:pair-cancel',
    onlyTrusted(trusted, () => a.cancel())
  )
  ipc.on('companion:pair-decide', onlyTrusted(trusted, a.decide))
  ipc.on('companion:revoke', onlyTrusted(trusted, a.revoke))
  ipc.on('companion:set-relay', onlyTrusted(trusted, a.setRelay))
}

export function registerSwitchIpc<S>(
  ipc: IpcLike,
  trusted: Trusted,
  d: {
    confirm(what: 'on' | 'shells'): Promise<boolean>
    isEnabled(): boolean
    setEnabled(on: boolean): void
    setShells(on: boolean): void
    status(): S
  }
): void {
  ipc.handle('remote:set-enabled', async (e: Asker, on: boolean) => {
    const v = !!on
    if (!(await mayFlip({ trusted: trusted(e), on: v, confirm: () => d.confirm('on') })))
      return d.status()
    d.setEnabled(v)
    return d.status()
  })
  ipc.handle('remote:set-shells', async (e: Asker, on: boolean) => {
    const v = !!on && d.isEnabled()
    if (!(await mayFlip({ trusted: trusted(e), on: v, confirm: () => d.confirm('shells') })))
      return d.status()
    d.setShells(v)
    return d.status()
  })
}
