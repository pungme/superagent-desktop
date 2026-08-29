import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The internal app name is an identifier: Electron derives the user-data
 * folder (~/Library/Application Support/<name>) and the keychain item for
 * cookies and companion secrets (<name> Safe Storage) from it. 1.7.2 changed
 * it during a brand rename and every updated install opened empty. Every
 * other test here runs against a throwaway data directory, which is exactly
 * the condition under which that mistake is invisible — so this one reads the
 * source instead.
 */
describe('app.setName', () => {
  it('is the identifier "SuperAgent", whatever the brand is spelled like', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(src).toMatch(/app\.setName\('SuperAgent'\)/)
    expect(src).not.toMatch(/app\.setName\('(?!SuperAgent')/)
  })
})
