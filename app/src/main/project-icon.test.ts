import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      resize: () => ({ toPNG: () => Buffer.from('small') })
    })
  }
}))

import { detectProjectIcon } from './project-icon'

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

function iconSet(dir: string, file?: { name: string; bytes: number }): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'Contents.json'),
    JSON.stringify({
      images: [{ ...(file ? { filename: file.name } : {}), size: '1024x1024', idiom: 'universal' }]
    })
  )
  if (file) writeFileSync(join(dir, file.name), Buffer.alloc(file.bytes, 1))
}

describe('an app icon', () => {
  it("skips a widget's empty icon set for the app's own, found at the same depth", () => {
    root = mkdtempSync(join(tmpdir(), 'cove-icon-'))
    // readlater: laterwidget/ lists before readlater/, and its set names no file.
    iconSet(join(root, 'readlater', 'laterwidget', 'Assets.xcassets', 'AppIcon.appiconset'))
    iconSet(join(root, 'readlater', 'readlater', 'Assets.xcassets', 'AppIcon.appiconset'), {
      name: 'Frame 7 (2).png',
      bytes: 2000
    })
    const icon = detectProjectIcon(root)
    expect(icon?.source).toBe('app-icon')
    expect(icon && 'dataUri' in icon && icon.dataUri).toMatch(/^data:image\/png;base64,/)
  })

  it('shrinks a big App Store icon to sidebar size', () => {
    root = mkdtempSync(join(tmpdir(), 'cove-icon-'))
    iconSet(join(root, 'App', 'Assets.xcassets', 'AppIcon.appiconset'), {
      name: 'icon.png',
      bytes: 1_500_000
    })
    const icon = detectProjectIcon(root)
    expect(icon && 'dataUri' in icon && icon.dataUri).toBe(
      `data:image/png;base64,${Buffer.from('small').toString('base64')}`
    )
  })
})
