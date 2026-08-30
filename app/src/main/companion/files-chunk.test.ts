import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FILE_CHUNK_BYTES, FILE_CHUNK_MAX_BYTES } from '../../shared/companion-protocol'
import { __testing } from './rpc'

const { readForPhone, readChunk } = __testing

/** A PDF big enough to need several chunks, with bytes that don't compress. */
function bigPdf(bytes: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n')
  const body = Buffer.alloc(bytes - head.length)
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff
  return Buffer.concat([head, body])
}

describe('files.chunk', () => {
  it('describes a PDF by its chunk count and hands the bytes back unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-pdf-'))
    const abs = join(dir, 'spec.pdf')
    const original = bigPdf(FILE_CHUNK_BYTES * 3 + 1234)
    writeFileSync(abs, original)
    try {
      const meta = readForPhone(abs, 'spec.pdf')
      expect(meta.kind).toBe('pdf')
      if (meta.kind !== 'pdf') return
      expect(meta.chunks).toBe(4)
      expect(meta.size).toBe(original.length)

      const parts: Buffer[] = []
      for (let i = 0; i < meta.chunks; i++) {
        const c = readChunk(abs, 'spec.pdf', i)
        expect(c).not.toBeNull()
        expect(c!.index).toBe(i)
        expect(c!.chunks).toBe(meta.chunks)
        // Each frame has to fit the relay's 1 MB ceiling once base64'd.
        expect(c!.data.length).toBeLessThan(1_048_576 - 4096)
        parts.push(Buffer.from(c!.data, 'base64'))
      }
      expect(Buffer.concat(parts).equals(original)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a slice past the end, and never reads outside the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-pdf-'))
    const abs = join(dir, 'small.pdf')
    writeFileSync(abs, bigPdf(1000))
    try {
      expect(readChunk(abs, 'small.pdf', 0)!.chunks).toBe(1)
      expect(readChunk(abs, 'small.pdf', 1)).toBeNull()
      expect(readChunk(join(dir, 'nope.pdf'), 'nope.pdf', 0)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a PDF too big to be worth pulling as a plain binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-pdf-'))
    const abs = join(dir, 'huge.pdf')
    writeFileSync(abs, Buffer.alloc(FILE_CHUNK_MAX_BYTES + 1))
    try {
      expect(readForPhone(abs, 'huge.pdf').kind).toBe('binary')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
