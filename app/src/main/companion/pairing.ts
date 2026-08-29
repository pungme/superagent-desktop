import { hostname } from 'os'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { newSecret, deriveKeys, pairingDigest, DeviceKeys } from './crypto'
import { machineId } from './identity'
import {
  PROTOCOL_VERSION,
  pairingCodeFromDigest,
  type PairPayload
} from '../../shared/companion-protocol'

/**
 * One pairing at a time. The Mac shows a QR carrying a fresh secret; a phone
 * that scans it can speak to us with keys nobody else has. The secret dies
 * with the pairing screen (or after 120 s), and a phone still has to be
 * accepted by a click on the Mac before it becomes a device.
 *
 *  pairingBus 'changed'   the Settings UI re-reads state()
 *  pairingBus 'request'   { device, code }  a phone asked to pair; needs Accept
 */
export const pairingBus = new EventEmitter()

export const PAIRING_TTL_MS = 120_000

export interface PairingRequest {
  device: { id: string; name: string; model: string; pushToken?: string }
  code: string
  accept: () => void
  reject: () => void
}

interface Pending {
  secret: Buffer
  keys: DeviceKeys
  payload: PairPayload
  code: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
  request: PairingRequest | null
}

let pending: Pending | null = null

export function pendingPairing(): Pending | null {
  if (pending && Date.now() > pending.expiresAt) cancelPairing()
  return pending
}

export function startPairing(relay: string): {
  payload: PairPayload
  code: string
  expiresAt: number
} {
  cancelPairing()
  const secret = newSecret()
  const m = machineId()
  const payload: PairPayload = {
    v: PROTOCOL_VERSION,
    name: prettyHostname(),
    relay,
    m,
    k: secret.toString('base64url')
  }
  const code = pairingCodeFromDigest(pairingDigest(secret, m))
  const expiresAt = Date.now() + PAIRING_TTL_MS
  pending = {
    secret,
    keys: deriveKeys(secret, m),
    payload,
    code,
    expiresAt,
    timer: setTimeout(cancelPairing, PAIRING_TTL_MS),
    request: null
  }
  pairingBus.emit('changed')
  return { payload, code, expiresAt }
}

export function cancelPairing(): void {
  if (!pending) return
  clearTimeout(pending.timer)
  pending.request?.reject()
  pending = null
  pairingBus.emit('changed')
}

/** A phone proved it has the secret and wants in. The UI decides. */
export function offerPairing(
  device: PairingRequest['device'],
  onDecision: (accepted: boolean) => void
): void {
  if (!pending) return onDecision(false)
  const p = pending
  let decided = false
  const request: PairingRequest = {
    device,
    code: p.code,
    accept: () => {
      if (decided || pending !== p) return
      decided = true
      p.request = null // settled — closing the pairing must not reject it again
      onDecision(true)
    },
    reject: () => {
      if (decided) return
      decided = true
      p.request = null
      onDecision(false)
    }
  }
  p.request = request
  pairingBus.emit('request', request)
}

export function decidePairing(accepted: boolean): void {
  const p = pendingPairing()
  if (!p?.request) return
  if (accepted) p.request.accept()
  else p.request.reject()
}

export function state(): {
  open: boolean
  payload?: PairPayload
  code?: string
  expiresAt?: number
  request?: { device: PairingRequest['device'] }
} {
  const p = pendingPairing()
  if (!p) return { open: false }
  return {
    open: true,
    payload: p.payload,
    code: p.code,
    expiresAt: p.expiresAt,
    ...(p.request ? { request: { device: p.request.device } } : {})
  }
}

let cachedName: string | null = null
/** The name the Mac calls itself in System Settings ("Pung's MacBook Pro"), else the hostname. */
export function prettyHostname(): string {
  if (cachedName) return cachedName
  let name = ''
  if (process.platform === 'darwin') {
    try {
      name = execFileSync('scutil', ['--get', 'ComputerName'], { timeout: 2000 }).toString().trim()
    } catch {
      name = ''
    }
  }
  if (!name)
    name = hostname()
      .replace(/\.local$/i, '')
      .replace(/-/g, ' ')
      .trim()
  cachedName = name || 'Mac'
  return cachedName
}
