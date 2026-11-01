import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('terminals and scripting apps start off every time', () => {
  // index.ts cannot be loaded without Electron; what matters is that nothing
  // in it reads the setting back from the store, or writes one to be read.
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  it('is never read from or written to the store', () => {
    expect(src).not.toMatch(/remote\.shells/)
    expect(src).not.toMatch(/readShells|SHELLS_KEY/)
    expect(src).not.toMatch(/setShells\(\s*read/)
  })
  it('only the confirmed IPC can switch it on', () => {
    expect(src.match(/setShells\(/g)).toHaveLength(1)
  })
})
