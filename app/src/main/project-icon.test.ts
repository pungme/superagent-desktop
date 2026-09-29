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

  it("prefers the app's icon to a widget's that has a picture of its own", () => {
    root = mkdtempSync(join(tmpdir(), 'cove-icon-'))
    // The widget's is shallower and would have won on depth alone.
    iconSet(join(root, 'LaterWidget', 'Assets.xcassets', 'AppIcon.appiconset'), {
      name: 'widget.png',
      bytes: 10
    })
    iconSet(join(root, 'App', 'Sources', 'Assets.xcassets', 'AppIcon.appiconset'), {
      name: 'app.png',
      bytes: 20
    })
    const icon = detectProjectIcon(root)
    const b64 = icon && 'dataUri' in icon ? icon.dataUri.split(',')[1] : ''
    expect(Buffer.from(b64, 'base64').length).toBe(20)
  })

  it('looks deeper when every icon set near the top is empty', () => {
    root = mkdtempSync(join(tmpdir(), 'cove-icon-'))
    iconSet(join(root, 'App', 'Assets.xcassets', 'AppIcon.appiconset'))
    iconSet(join(root, 'App', 'Nested', 'Deeper', 'Assets.xcassets', 'AppIcon.appiconset'), {
      name: 'icon.png',
      bytes: 30
    })
    expect(detectProjectIcon(root)?.source).toBe('app-icon')
  })

  it('draws an Icon Composer icon: its fill, with its layers on top', () => {
    root = mkdtempSync(join(tmpdir(), 'cove-icon-'))
    const dir = join(root, 'App', 'Resources', 'AppIcon.icon')
    mkdirSync(join(dir, 'Assets'), { recursive: true })
    writeFileSync(join(dir, 'Assets', 'star.png'), Buffer.alloc(40, 1))
    writeFileSync(
      join(dir, 'icon.json'),
      JSON.stringify({
        fill: { solid: 'srgb:0.00000,0.50000,1.00000,1.00000' },
        groups: [{ layers: [{ 'image-name': 'star.png', name: 'star' }] }]
      })
    )
    const icon = detectProjectIcon(root)
    expect(icon?.source).toBe('app-icon')
    const uri = icon && 'dataUri' in icon ? icon.dataUri : ''
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/)
    const svg = Buffer.from(uri.split(',')[1], 'base64').toString()
    expect(svg).toContain('fill="rgba(0,128,255,1)"')
    expect(svg).toContain('<image href="data:image/png;base64,')
  })
})
