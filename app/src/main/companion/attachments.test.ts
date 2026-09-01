import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'sa-attach-'))

/** A tiny stand-in for nativeImage: records the resize, returns fixed bytes. */
const resized: { width?: number; height?: number }[] = []
vi.mock('electron', () => {
  const makeImage = (empty: boolean, w = 2000, h = 1000): unknown => ({
    isEmpty: () => empty,
    getSize: () => ({ width: w, height: h }),
    resize: (opts: { width?: number; height?: number }) => {
      resized.push(opts)
      return makeImage(false, opts.width ?? 600, opts.height ?? 300)
    },
    toJPEG: () => Buffer.from('jpeg-bytes')
  })
  return {
    app: { getPath: () => userData },
    nativeImage: {
      createFromBuffer: (b: Buffer) => makeImage(b.length === 0)
    }
  }
})

const { keepThumbnails, readThumbnail } = await import('./attachments')

describe('message attachments', () => {
  beforeEach(() => {
    resized.length = 0
  })

  it('keeps a thumbnail per image and hands it back by index', () => {
    keepThumbnails('u-1', [
      { mediaType: 'image/png', data: Buffer.from('a').toString('base64') },
      { mediaType: 'image/png', data: Buffer.from('b').toString('base64') }
    ])
    const first = readThumbnail('u-1', 0)
    const second = readThumbnail('u-1', 1)
    expect(first?.mediaType).toBe('image/jpeg')
    expect(Buffer.from(first!.data, 'base64').toString()).toBe('jpeg-bytes')
    expect(second).not.toBeNull()
    expect(readThumbnail('u-1', 2)).toBeNull()
    expect(readThumbnail('nope', 0)).toBeNull()
  })

  it('scales the long edge down, and only when it is too long', () => {
    keepThumbnails('u-wide', [{ mediaType: 'image/png', data: 'AAAA' }])
    expect(resized).toEqual([{ width: 600 }])
  })

  it('never throws on a message id that is a path', () => {
    expect(() =>
      keepThumbnails('../../etc/passwd', [{ mediaType: 'image/png', data: 'AAAA' }])
    ).not.toThrow()
    // written somewhere inside the store, not up the tree
    expect(readThumbnail('../../etc/passwd', 0)).not.toBeNull()
  })

  it('ignores a message with no images, and an image that will not decode', () => {
    expect(() => keepThumbnails('u-2', [])).not.toThrow()
    keepThumbnails('u-3', [{ mediaType: 'image/png', data: '' }])
    expect(readThumbnail('u-3', 0)).toBeNull()
  })
})
