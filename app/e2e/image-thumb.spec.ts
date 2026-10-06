import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

/** A plain grey PNG of the given size. */
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
  head.set([8, 0, 0, 0, 0], 8) // 8-bit greyscale
  const rows = Buffer.alloc((width + 1) * height, 0xcc)
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * A picture in a reply sits in a frame its own size. A wide picture used to be
 * drawn small inside a frame as wide as the original, an empty box running off
 * to its right.
 */
test("a wide picture's frame is no wider than the picture", async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-th-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-th-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  writeFileSync(join(proj, 'wide.png'), png(644, 202))
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(
      async (p) => {
        const tree = await window.cove.storeTree()
        const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
        const chatId = await window.cove.chatCreate(wsId)
        window.cove.chatSave(
          chatId,
          JSON.stringify([
            { kind: 'msg', msg: { id: 'a1', role: 'assistant', text: `Here:\n\n![menu](${p})` } }
          ])
        )
      },
      join(proj, 'wide.png')
    )
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.click('.sidebar-item:has-text("e2e-project")')
    const thumb = window.locator('.md-img-thumb:visible').first()
    await expect(thumb.locator('img')).toBeVisible({ timeout: 15_000 })
    const frame = (await thumb.boundingBox())!
    const img = (await thumb.locator('img').boundingBox())!
    expect(img.width).toBeGreaterThan(200)
    // The frame is the picture plus its border.
    expect(frame.width - img.width).toBeLessThan(4)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
