import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

/** A PNG whose left half is dark and right half light, so a slide is visible. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0)
  head.writeUInt32BE(height, 4)
  head.set([8, 0, 0, 0, 0], 8)
  const rows = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = x < width / 2 ? 0x30 : 0xd0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Your own picture as the app icon: it opens in an editor with a live preview
 * to drag and zoom, nothing changes until it is accepted, and afterwards the
 * swatch in Settings shows that icon. Any colour can be picked, too.
 */
test('a picture is placed in the icon before it is used, and Settings shows it', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-icon-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-icon-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const pic = join(proj, 'wide.png')
  writeFileSync(pic, png(400, 200))
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const w = await app.firstWindow()
    await w.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await w.reload()
    await w.waitForSelector('.sidebar', { timeout: 20_000 })
    await w.click('.sidebar-settings[title="Settings"]')
    const photo = w.locator('.icon-swatch-photo')
    await expect(photo).toBeVisible()

    await w.locator('input[type="file"][accept="image/*"]').setInputFiles(pic)
    const editor = w.getByRole('dialog', { name: 'Place your picture in the icon' })
    await expect(editor).toBeVisible()
    // Nothing is in use yet.
    expect(await w.evaluate(() => localStorage.getItem('cove.iconPhoto'))).toBeNull()

    // Drag it: the wide picture slides, and the preview changes with it.
    const canvas = editor.locator('canvas')
    const pixels = (): Promise<string> =>
      canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL().slice(-80))
    const before = await pixels()
    const box = (await canvas.boundingBox())!
    await w.mouse.move(box.x + 130, box.y + 60)
    await w.mouse.down()
    await w.mouse.move(box.x + 60, box.y + 60, { steps: 4 })
    await w.mouse.up()
    expect(await pixels()).not.toBe(before)
    // And zoom.
    await editor.getByLabel('Zoom').fill('2')
    if (process.env.SHOT) await editor.screenshot({ path: '/tmp/sa-icon-editor.png' })

    await editor.getByRole('button', { name: 'Use this icon' }).click()
    await expect(editor).toBeHidden()
    const saved = await w.evaluate(() => ({
      photo: !!localStorage.getItem('cove.iconPhoto'),
      place: JSON.parse(localStorage.getItem('cove.iconPlace')!) as { zoom: number; x: number },
      thumb: localStorage.getItem('cove.iconThumb')
    }))
    expect(saved.photo).toBe(true)
    expect(saved.place.zoom).toBe(2)
    expect(saved.place.x).toBeLessThan(0)
    // The swatch is that icon now, and marked as the one in use.
    await expect(photo).toHaveAttribute('aria-pressed', 'true')
    expect(await photo.evaluate((e) => getComputedStyle(e).backgroundImage)).toContain('data:image')
    if (process.env.SHOT)
      await w
        .locator('.settings-row', { hasText: 'App icon' })
        .screenshot({ path: '/tmp/sa-icon-row.png' })

    // Pressing it again reopens the same picture where it was left; Cancel keeps it.
    await photo.click()
    await expect(editor.getByLabel('Zoom')).toHaveValue('2')
    await editor.getByRole('button', { name: 'Cancel' }).click()
    expect((await w.evaluate(() => localStorage.getItem('cove.iconThumb'))) === saved.thumb).toBe(
      true
    )

    // Any colour, for the icon and for the accent.
    await w.getByLabel('Pick any colour for the icon').fill('#00aa88')
    expect(await w.evaluate(() => localStorage.getItem('cove.iconColour'))).toBe('#00aa88')
    expect(await w.evaluate(() => localStorage.getItem('cove.iconPhoto'))).toBeNull()
    await w.getByLabel('Pick any colour for the accent').fill('#ffe14d')
    const accent = await w.evaluate(() => {
      const s = getComputedStyle(document.documentElement)
      return [s.getPropertyValue('--accent').trim(), s.getPropertyValue('--accent-fg').trim()]
    })
    // A light accent gets dark text on it.
    expect(accent).toEqual(['#ffe14d', '#17181d'])
    // A named accent takes over again.
    await w.locator('.accent-swatch.accent-blue').click()
    expect(await w.evaluate(() => localStorage.getItem('cove.accentCustom'))).toBeNull()
    expect(
      await w.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      )
    ).toBe('#3d82e8')
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
