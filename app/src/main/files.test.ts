import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  nativeImage: {}
}))

import { resolveInside } from './files'

describe('resolveInside', () => {
  it('keeps a phone inside the project folder', () => {
    expect(resolveInside('/p/app', 'src/index.ts')).toBe('/p/app/src/index.ts')
    expect(resolveInside('/p/app', '.')).toBe('/p/app')
    expect(resolveInside('/p/app', './a/../b')).toBe('/p/app/b')
    expect(resolveInside('/p/app', '../secrets')).toBeNull()
    expect(resolveInside('/p/app', '/etc/passwd')).toBeNull()
    // A sibling whose name merely starts with the root is not inside it.
    expect(resolveInside('/p/app', '../app2/x')).toBeNull()
  })
})

describe('an image named in a reply', () => {
  it('finds it on disk from a path, a file URL, ~ or the chat folder', async () => {
    const { localImagePath } = await import('./files')
    const { homedir } = await import('os')
    expect(localImagePath('/tmp/a b/shot.png')).toBe('/tmp/a b/shot.png')
    expect(localImagePath('file:///tmp/a%20b/shot.png')).toBe('/tmp/a b/shot.png')
    expect(localImagePath('/tmp/a%20b/shot.png')).toBe('/tmp/a b/shot.png')
    expect(localImagePath('~/Desktop/x.png')).toBe(`${homedir()}/Desktop/x.png`)
    expect(localImagePath('test-results/1.png', '/Users/me/proj')).toBe(
      '/Users/me/proj/test-results/1.png'
    )
    // Relative with nowhere to look from, and anything on the web: not ours.
    expect(localImagePath('shots/1.png')).toBeNull()
    expect(localImagePath('https://example.com/x.png')).toBeNull()
    expect(localImagePath('data:image/png;base64,AAAA')).toBeNull()
  })
})
