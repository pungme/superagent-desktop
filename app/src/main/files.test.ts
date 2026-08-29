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
