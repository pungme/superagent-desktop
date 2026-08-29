import { app, safeStorage } from 'electron'
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, KeyObject } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Who this Mac is to the relay: an Ed25519 keypair generated once. The public
 * key's hex is the machine id — the relay verifies a signed nonce against it,
 * so nobody else can claim this id. The private key lives safeStorage-encrypted
 * in userData; the OS keychain holds the encryption key.
 */

let cached: { machineId: string; privateKey: KeyObject } | null = null

/** Thrown when the OS keychain refused us (the user clicked Deny). */
export class KeychainDeniedError extends Error {
  constructor() {
    super(
      'Keychain access was denied. Superagent keeps the phone pairing key in your login keychain — allow it next time it asks, or in Keychain Access.'
    )
    this.name = 'KeychainDeniedError'
  }
}

/**
 * The machine id if the identity is already loaded — never loads it. The
 * Settings page and the tray show state constantly; the keychain is touched
 * only when a phone is actually involved (pairing, or a paired phone's relay
 * connection), never on launch.
 */
export function loadedMachineId(): string {
  return cached?.machineId ?? ''
}

function dir(): string {
  const d = join(app.getPath('userData'), 'companion')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function loadIdentity(): { machineId: string; privateKey: KeyObject } {
  if (cached) return cached
  const file = join(dir(), 'identity.bin')
  let pem: string
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file)
      pem = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8')
    } else {
      const { privateKey } = generateKeyPairSync('ed25519')
      pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
      const stored = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(pem)
        : Buffer.from(pem, 'utf8')
      writeFileSync(file, stored, { mode: 0o600 })
    }
  } catch {
    throw new KeychainDeniedError()
  }
  const privateKey = createPrivateKey(pem)
  const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
  const machineId = publicDer.subarray(-32).toString('hex')
  cached = { machineId, privateKey }
  return cached
}

export function machineId(): string {
  return loadIdentity().machineId
}

/** Sign the relay's nonce. Returns base64. */
export function signNonce(nonce: Buffer): string {
  return sign(null, nonce, loadIdentity().privateKey).toString('base64')
}

/** Encrypt a device secret at rest (falls back to plaintext where safeStorage is unavailable). */
export function protect(bytes: Buffer): Buffer {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(bytes.toString('base64'))
      : Buffer.from(bytes.toString('base64'), 'utf8')
  } catch {
    throw new KeychainDeniedError()
  }
}

export function unprotect(stored: Buffer): Buffer {
  try {
    const b64 = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(stored)
      : stored.toString('utf8')
    return Buffer.from(b64, 'base64')
  } catch {
    throw new KeychainDeniedError()
  }
}
