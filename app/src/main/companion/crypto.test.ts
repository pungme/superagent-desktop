import { describe, it, expect } from 'vitest'
import { deriveKeys, aadFor, Sealer, Opener, probe, pairingDigest } from './crypto'
import { pairingCodeFromDigest } from '../../shared/companion-protocol'
import { readFileSync } from 'fs'
import { join } from 'path'

const machineId = 'ab'.repeat(32)
const secret = Buffer.alloc(32, 7)

describe('companion crypto', () => {
  it('derives distinct per-direction keys deterministically', () => {
    const a = deriveKeys(secret, machineId)
    const b = deriveKeys(secret, machineId)
    expect(a.m2p.equals(b.m2p)).toBe(true)
    expect(a.m2p.equals(a.p2m)).toBe(false)
    expect(deriveKeys(secret, 'cd'.repeat(32)).m2p.equals(a.m2p)).toBe(false)
  })

  it('seals and opens with increasing counters and a pinned salt', () => {
    const keys = deriveKeys(secret, machineId)
    const s = new Sealer(keys.m2p, aadFor(machineId, 'm2p'))
    const o = new Opener(keys.m2p, aadFor(machineId, 'm2p'))
    const f1 = s.seal('{"t":"welcome"}')
    const f2 = s.seal('{"t":"event"}')
    expect(o.open(f1)).toBe('{"t":"welcome"}')
    expect(o.open(f2)).toBe('{"t":"event"}')
    // Replay and reorder are refused.
    expect(o.open(f1)).toBeNull()
    expect(o.open(f2)).toBeNull()
    // A frame from a different connection (other salt) is refused too.
    const s2 = new Sealer(keys.m2p, aadFor(machineId, 'm2p'))
    expect(o.open(s2.seal('x'))).toBeNull()
  })

  it('refuses the wrong key, wrong direction, and tampering', () => {
    const keys = deriveKeys(secret, machineId)
    const s = new Sealer(keys.m2p, aadFor(machineId, 'm2p'))
    const frame = s.seal('hi')
    expect(new Opener(keys.p2m, aadFor(machineId, 'p2m')).open(frame)).toBeNull()
    expect(new Opener(keys.m2p, aadFor(machineId, 'p2m')).open(frame)).toBeNull()
    const buf = Buffer.from(frame, 'base64')
    buf[14] ^= 1
    expect(new Opener(keys.m2p, aadFor(machineId, 'm2p')).open(buf.toString('base64'))).toBeNull()
    expect(new Opener(keys.m2p, aadFor(machineId, 'm2p')).open('not-base64!!')).toBeNull()
  })

  it('probe answers without consuming the frame', () => {
    const keys = deriveKeys(secret, machineId)
    const frame = new Sealer(keys.p2m, aadFor(machineId, 'p2m')).seal('pair')
    expect(probe(keys.p2m, aadFor(machineId, 'p2m'), frame)).toBe(true)
    expect(probe(keys.m2p, aadFor(machineId, 'p2m'), frame)).toBe(false)
    expect(new Opener(keys.p2m, aadFor(machineId, 'p2m')).open(frame)).toBe('pair')
  })

  it('matches the shared vectors the iOS app also decodes', () => {
    const v = JSON.parse(
      readFileSync(join(__dirname, '../../shared/fixtures/companion/crypto-vectors.json'), 'utf8')
    )
    const k = Buffer.from(v.secretHex, 'hex')
    const keys = deriveKeys(k, v.machineId)
    expect(keys.m2p.toString('hex')).toBe(v.keyM2pHex)
    expect(keys.p2m.toString('hex')).toBe(v.keyP2mHex)
    const o = new Opener(keys.m2p, aadFor(v.machineId, 'm2p'))
    expect(o.open(v.frameM2p)).toBe(v.plaintext)
    expect(pairingCodeFromDigest(pairingDigest(k, v.machineId))).toBe(v.pairingCode)
    // Sealing with the fixed salt reproduces the exact frame.
    const s = new Sealer(keys.m2p, aadFor(v.machineId, 'm2p'), Buffer.from(v.saltHex, 'hex'))
    expect(s.seal(v.plaintext)).toBe(v.frameM2p)
  })
})
