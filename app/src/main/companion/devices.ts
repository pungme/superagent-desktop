import { getDb } from '../store'
import { protect, unprotect, machineId } from './identity'
import { deriveKeys, hashToken, DeviceKeys } from './crypto'

/**
 * Phones paired with this Mac. Each has its own secret (so revoking one never
 * touches another) and a bearer token the phone presents in `hello`.
 */

export interface Device {
  id: string
  name: string
  model: string
  pushToken: string | null
  pushEnv: 'production' | 'sandbox'
  createdAt: number
  lastSeenAt: number | null
}

interface Row extends Device {
  secret: Buffer
  tokenHash: string
}

const keyCache = new Map<string, DeviceKeys>()

export function listDevices(): Device[] {
  return getDb()
    .prepare(
      'SELECT id, name, model, pushToken, pushEnv, createdAt, lastSeenAt FROM devices ORDER BY createdAt'
    )
    .all() as Device[]
}

export function addDevice(
  d: { id: string; name: string; model: string; pushToken?: string },
  secret: Buffer,
  token: string
): void {
  getDb()
    .prepare(
      `INSERT INTO devices (id, name, model, secret, tokenHash, pushToken, pushEnv, createdAt, lastSeenAt)
       VALUES (?, ?, ?, ?, ?, ?, 'production', ?, NULL)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, model = excluded.model,
         secret = excluded.secret, tokenHash = excluded.tokenHash, pushToken = excluded.pushToken`
    )
    .run(d.id, d.name, d.model, protect(secret), hashToken(token), d.pushToken ?? null, Date.now())
  keyCache.delete(d.id)
}

export function removeDevice(id: string): void {
  getDb().prepare('DELETE FROM devices WHERE id = ?').run(id)
  keyCache.delete(id)
}

export function touchDevice(id: string): void {
  getDb().prepare('UPDATE devices SET lastSeenAt = ? WHERE id = ?').run(Date.now(), id)
}

export function setPushToken(
  id: string,
  token: string | null,
  env: 'production' | 'sandbox'
): void {
  getDb().prepare('UPDATE devices SET pushToken = ?, pushEnv = ? WHERE id = ?').run(token, env, id)
}

/** Every device's keys — used to work out which phone a fresh connection is. */
export function allDeviceKeys(): { id: string; keys: DeviceKeys }[] {
  const rows = getDb().prepare('SELECT id, secret FROM devices').all() as {
    id: string
    secret: Buffer
  }[]
  return rows.map((r) => ({ id: r.id, keys: keysFor(r.id, r.secret) }))
}

function keysFor(id: string, stored: Buffer): DeviceKeys {
  let k = keyCache.get(id)
  if (!k) {
    k = deriveKeys(unprotect(stored), machineId())
    keyCache.set(id, k)
  }
  return k
}

export function tokenMatches(id: string, token: string): boolean {
  const row = getDb().prepare('SELECT tokenHash FROM devices WHERE id = ?').get(id) as
    { tokenHash: string } | undefined
  if (!row) return false
  const a = Buffer.from(row.tokenHash, 'hex')
  const b = Buffer.from(hashToken(token), 'hex')
  return a.length === b.length && a.equals(b)
}

export function getDevice(id: string): Device | undefined {
  return getDb()
    .prepare(
      'SELECT id, name, model, pushToken, pushEnv, createdAt, lastSeenAt FROM devices WHERE id = ?'
    )
    .get(id) as Device | undefined
}

export function devicesWithPush(): Row[] {
  return getDb().prepare('SELECT * FROM devices WHERE pushToken IS NOT NULL').all() as Row[]
}
