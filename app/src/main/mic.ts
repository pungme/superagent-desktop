import { ipcMain, shell, systemPreferences } from 'electron'
import { QUIET } from './quiet'

/**
 * The microphone, for dictation. Chromium asks macOS for it the first time a
 * page records, but a request made from the dot, a panel that never becomes
 * the active app, has nothing to hang the system's own prompt on: nothing
 * appears and the recording fails with a word of Chromium's. So the asking is
 * done here, by the app itself, before the page records; and a no is reported
 * as what it is, with the way to System Settings, rather than left as "could
 * not access the microphone".
 */
export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export async function micAccess(): Promise<MicAccess> {
  if (process.platform !== 'darwin') return 'granted'
  // A quiet test run never records, and must never put a system prompt up.
  if (QUIET) return 'granted'
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'not-determined') {
    const ok = await systemPreferences.askForMediaAccess('microphone')
    return ok ? 'granted' : 'denied'
  }
  return status
}

export function registerMicIpc(): void {
  ipcMain.handle('mic:access', () => micAccess())
  ipcMain.handle('mic:open-settings', () =>
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  )
}
