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

  // The phone reads files through the project, and a screenshot is usually
  // saved outside it: on the phone the picture never loaded.
  it('lets the phone have one from outside the project, when a reply in the chat names it', async () => {
    const { replyImagePath } = await import('./files')
    const reply =
      'Here it is:\n\n![The new header](/tmp/pv/header.png)\n\nand ![b](<~/My Shots/b.png>)'
    const said = (text: string): boolean => reply.includes(text)
    expect(replyImagePath('/tmp/pv/header.png', '/Users/me/proj', said)).toBe('/tmp/pv/header.png')
    const { homedir } = await import('os')
    expect(replyImagePath('~/My Shots/b.png', '/Users/me/proj', said)).toBe(
      `${homedir()}/My Shots/b.png`
    )
    // A path no reply named, and one named only in passing, stay out of reach.
    expect(replyImagePath('/tmp/pv/other.png', '/Users/me/proj', said)).toBeNull()
    expect(
      replyImagePath('/tmp/x.png', '/Users/me/proj', (t) => 'I saved /tmp/x.png'.includes(t))
    ).toBeNull()
    // Only pictures: a reply that links a key file does not hand it over.
    expect(
      replyImagePath('/Users/me/.ssh/id_rsa', '/Users/me/proj', (t) =>
        '![k](/Users/me/.ssh/id_rsa)'.includes(t)
      )
    ).toBeNull()
  })
})
