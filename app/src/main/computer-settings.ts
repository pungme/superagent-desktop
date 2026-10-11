import { app, safeStorage } from 'electron'
import { kvGet, kvSet } from './store'
import { loadSealed, type Seal } from '../shared/sealed-settings'

/**
 * Where computer use keeps its settings (see shared/sealed-settings.ts for
 * why they are sealed). In the released app: one blob, encrypted with the key
 * macOS keeps for Superagent. From source or in a test run: the plain rows, as
 * before, so no test ever asks the keychain for anything.
 */

const SEALED_KEY = 'computer.sealed'

const seal: Seal = {
  open: (blob) => {
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      return null
    }
  },
  close: (text) => safeStorage.encryptString(text).toString('base64')
}

let held: Record<string, string> | null = null

function sealedNow(): Record<string, string> | null {
  if (held) return held
  // The key is not to be had before the app is ready; asked for then, a
  // setting is "not known yet", never a guess that gets remembered.
  if (!app.isReady() || !safeStorage.isEncryptionAvailable()) return null
  held = loadSealed(kvGet(SEALED_KEY) ?? null, (k) => kvGet(k) ?? null, seal)
  // Sealed from here on, including what was just carried over.
  kvSet(SEALED_KEY, seal.close(JSON.stringify(held)))
  return held
}

/** A setting's value; null when it was never set; undefined when it cannot be known yet. */
export function settingGet(key: string): string | null | undefined {
  if (!app.isPackaged) return kvGet(key) ?? null
  const all = sealedNow()
  return all ? (all[key] ?? null) : undefined
}

export function settingSet(key: string, value: string): void {
  if (!app.isPackaged) return kvSet(key, value)
  const all = sealedNow()
  // Not ready: nothing is written rather than something unsealed.
  if (!all) return
  all[key] = value
  kvSet(SEALED_KEY, seal.close(JSON.stringify(all)))
}
