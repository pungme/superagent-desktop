import { createCipheriv, createDecipheriv, hkdfSync, createHash, randomBytes } from 'crypto'

/**
 * End-to-end encryption between this Mac and one paired phone (SPEC §2.5).
 *
 * AES-256-GCM rather than ChaCha20-Poly1305: Electron ships BoringSSL, whose
 * Node bindings do not expose chacha20-poly1305 through createCipheriv (plain
 * Node does, which is how a test can pass and the app still fail). GCM is
 * available in Electron, Node and CryptoKit alike.
 *
 * Both sides hold the same 32-byte secret `k` (from the pairing QR). Each
 * direction gets its own key so counters never collide:
 *   key_m2p = HKDF-SHA256(k, salt = machineId, info = "sa-m2p")
 *   key_p2m = HKDF-SHA256(k, salt = machineId, info = "sa-p2m")
 * A frame is base64( nonce(12) ‖ ciphertext ‖ tag(16) ) with
 *   nonce = connectionSalt(4) ‖ counter(8, big-endian)
 * The receiver pins the salt on the first frame and requires the counter to
 * strictly increase, so a relay cannot replay or reorder frames.
 * AAD = machineId ‖ direction, binding a frame to this Mac and its direction.
 *
 * Pure Node crypto; the Swift side uses CryptoKit's HKDF + AES.GCM, which
 * produce byte-identical results (shared vectors in fixtures/companion/).
 */

export type Direction = 'm2p' | 'p2m'

export interface DeviceKeys {
  m2p: Buffer
  p2m: Buffer
}

export function deriveKeys(secret: Buffer, machineId: string): DeviceKeys {
  const salt = Buffer.from(machineId, 'utf8')
  return {
    m2p: Buffer.from(hkdfSync('sha256', secret, salt, 'sa-m2p', 32)),
    p2m: Buffer.from(hkdfSync('sha256', secret, salt, 'sa-p2m', 32))
  }
}

export function aadFor(machineId: string, dir: Direction): Buffer {
  return Buffer.from(`${machineId}${dir}`, 'utf8')
}

/** Sends frames in one direction on one connection: fresh salt, counter from 1. */
export class Sealer {
  private counter = 0n
  private salt: Buffer
  constructor(
    private key: Buffer,
    private aad: Buffer,
    salt?: Buffer
  ) {
    this.salt = salt ?? randomBytes(4)
  }

  seal(plaintext: string): string {
    this.counter += 1n
    const nonce = Buffer.alloc(12)
    this.salt.copy(nonce, 0)
    nonce.writeBigUInt64BE(this.counter, 4)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(this.aad, { plaintextLength: Buffer.byteLength(plaintext, 'utf8') })
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64')
  }
}

/** Receives frames in one direction on one connection. */
export class Opener {
  private salt: Buffer | null = null
  private last = 0n
  constructor(
    private key: Buffer,
    private aad: Buffer
  ) {}

  /** Returns the plaintext, or null if the frame is not for this key / is stale. */
  open(frame: string): string | null {
    let buf: Buffer
    try {
      buf = Buffer.from(frame, 'base64')
    } catch {
      return null
    }
    if (buf.length < 12 + 16) return null
    const nonce = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const ct = buf.subarray(12, buf.length - 16)
    const salt = nonce.subarray(0, 4)
    const counter = nonce.readBigUInt64BE(4)
    if (this.salt && !this.salt.equals(salt)) return null
    if (counter <= this.last) return null
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, nonce)
      d.setAAD(this.aad, { plaintextLength: ct.length })
      d.setAuthTag(tag)
      const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8')
      // Only commit state once the frame authenticated.
      if (!this.salt) this.salt = Buffer.from(salt)
      this.last = counter
      return pt
    } catch {
      return null
    }
  }
}

/** Ask "does this frame belong to this key?" without disturbing a live Opener. */
export function probe(key: Buffer, aad: Buffer, frame: string): boolean {
  return new Opener(key, aad).open(frame) !== null
}

export function newSecret(): Buffer {
  return randomBytes(32)
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Both screens show this — the phone from k, the Mac from the pending pairing. */
export function pairingDigest(secret: Buffer, machineId: string): string {
  return createHash('sha256').update(secret).update(machineId, 'utf8').digest('hex')
}
