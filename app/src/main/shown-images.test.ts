import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, utimesSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { keepShownImage, keptShownImage, setShownImagesRoot } from './shown-images'

describe('copies of pictures an agent showed', () => {
  let data: string
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'shown-'))
    setShownImagesRoot(data)
  })

  it('keeps a copy the first time, and finds it when the file is gone', () => {
    expect(keptShownImage('/tmp/mockup.png')).toBeNull()
    keepShownImage('/tmp/mockup.png', 1000, () => Buffer.from('v1'))
    const kept = keptShownImage('/tmp/mockup.png')!
    expect(readFileSync(kept, 'utf8')).toBe('v1')
    expect(keptShownImage('/tmp/other.png')).toBeNull()
  })

  it('does not rewrite a copy on every render, only when the file has changed since', () => {
    let made = 0
    const jpeg = (v: string) => () => {
      made++
      return Buffer.from(v)
    }
    keepShownImage('/tmp/a.png', 1000, jpeg('v1'))
    const kept = keptShownImage('/tmp/a.png')!
    utimesSync(kept, 2, 2) // the copy was written at t=2000ms
    keepShownImage('/tmp/a.png', 1500, jpeg('again'))
    expect(made).toBe(1)
    keepShownImage('/tmp/a.png', 3000, jpeg('v2'))
    expect(made).toBe(2)
    expect(readFileSync(kept, 'utf8')).toBe('v2')
    expect(readdirSync(join(data, 'attachments', 'shown'))).toHaveLength(1)
  })

  it('never lets a failure to keep a copy throw', () => {
    expect(() =>
      keepShownImage('/tmp/b.png', 1, () => {
        throw new Error('decode failed')
      })
    ).not.toThrow()
  })
})
