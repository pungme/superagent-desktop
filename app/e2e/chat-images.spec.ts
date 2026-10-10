import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

/**
 * A conversation's pictures, the way a messaging app keeps them: one place
 * that lists every one, and a way to save any of them. A test run saves into
 * its own data folder, never the real Downloads.
 */

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
  head.set([8, 0, 0, 0, 0], 8)
  const rows = Buffer.alloc((width + 1) * height, 0xcc)
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

let app: ElectronApplication
let window: Page
let data: string
let proj: string
const saved = (): string[] =>
  existsSync(join(data, 'downloads')) ? readdirSync(join(data, 'downloads')).sort() : []

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-imgs-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-imgs-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  writeFileSync(join(proj, 'header.png'), png(320, 120))
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  // THEME=dark with SHOT=1 takes the pictures in dark mode, to look at.
  await window.evaluate((theme) => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
    if (theme) localStorage.setItem('cove.theme', theme)
  }, process.env.THEME ?? '')
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.evaluate(
    async ({ attached, shown }) => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const chatId = await window.cove.chatCreate(wsId)
      window.cove.chatSave(
        chatId,
        JSON.stringify([
          {
            kind: 'msg',
            msg: {
              id: 'u1',
              role: 'user',
              text: 'two shots',
              images: [attached, attached],
              at: Date.now() - 3 * 86_400_000
            }
          },
          {
            kind: 'msg',
            msg: {
              id: 'a1',
              role: 'assistant',
              text: `The header:\n\n![the header](${shown})`,
              at: Date.now()
            }
          },
          { kind: 'msg', msg: { id: 'a2', role: 'assistant', text: 'No picture in this one.' } }
        ])
      )
    },
    {
      attached: `data:image/png;base64,${png(40, 40).toString('base64')}`,
      shown: join(proj, 'header.png')
    }
  )
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(window.locator('.easy-msg-images img:visible').first()).toBeVisible({
    timeout: 15_000
  })
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
})

test('an enlarged picture can be downloaded, and says where it went', async () => {
  await window.locator('.easy-msg-images img:visible').first().click()
  const box = window.locator('.easy-lightbox')
  await expect(box).toBeVisible()
  await box.getByRole('button', { name: 'Download' }).click()
  await expect(box.getByRole('status')).toContainText('Saved to Downloads as Superagent ')
  // The picture is still up: saving is not closing.
  await expect(box.locator('img')).toBeVisible()
  expect(saved()).toHaveLength(1)
  expect(saved()[0]).toMatch(/^Superagent \d{4}-\d\d-\d\d at [\d.]+\.png$/)
  expect(
    readFileSync(join(data, 'downloads', saved()[0]))
      .subarray(1, 4)
      .toString()
  ).toBe('PNG')
  await window.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
})

test('a picture the agent showed is saved as the file itself, never over one already there', async () => {
  await window.locator('.md-img-thumb:visible').first().click()
  const box = window.locator('.easy-lightbox')
  await box.getByRole('button', { name: 'Download' }).click()
  await expect(box.getByRole('status')).toContainText('Saved to Downloads as header.png')
  // The original, byte for byte: not the preview that is on screen.
  expect(readFileSync(join(data, 'downloads', 'header.png'))).toEqual(
    readFileSync(join(proj, 'header.png'))
  )
  await window.keyboard.press('Escape')
  await window.locator('.md-img-thumb:visible').first().click()
  await box.getByRole('button', { name: 'Download' }).click()
  await expect(box.getByRole('status')).toContainText('Saved to Downloads as header 2.png')
  await window.keyboard.press('Escape')
  expect(saved().filter((n) => n.startsWith('header'))).toEqual(['header 2.png', 'header.png'])
})

test('a picture can be downloaded where it sits in the conversation, without opening it', async () => {
  const before = saved().length
  // One you attached: the corner button shows on hover and saves at once.
  const mine = window.locator('.easy-msg-thumb:visible').first()
  await mine.hover()
  await mine.getByRole('button', { name: 'Download picture' }).click()
  await expect(mine.locator('.img-save-corner.done')).toBeVisible()
  expect(saved()).toHaveLength(before + 1)
  // It did not open the picture.
  await expect(window.locator('.easy-lightbox')).toHaveCount(0)

  // One the agent showed: saved as the file, under the next free name.
  const theirs = window.locator('.md-img-wrap:visible').first()
  await theirs.hover()
  await theirs.getByRole('button', { name: 'Download picture' }).click()
  await expect(theirs.locator('.img-save-corner.done')).toHaveAttribute(
    'title',
    /Saved to Downloads as header( \d+)?\.png/
  )
  expect(saved()).toHaveLength(before + 2)
  if (process.env.SHOT) await window.screenshot({ path: '/tmp/sa-chat-thumbs.png' })
})

test('Images lists every picture in the chat, newest first, and opens one large', async () => {
  const pill = window.locator('.easy-control-btn:visible', { hasText: 'Images' })
  await expect(pill).toContainText('3')
  await pill.click()
  const view = window.getByRole('dialog', { name: 'Images in this chat' })
  await expect(view).toBeVisible()
  const tiles = view.locator('.chat-images-tile')
  await expect(tiles).toHaveCount(3)
  await expect(view.locator('.chat-images-open img')).toHaveCount(3)
  // The agent's is the latest, so it is first; the two attached follow.
  expect(await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-from')))).toEqual([
    'agent',
    'you',
    'you'
  ])
  // Headed by the day each arrived, newest day first.
  const days = await view.locator('.chat-images-day').allInnerTexts()
  expect(days.length).toBeGreaterThanOrEqual(1)
  expect(days[0].toLowerCase()).toBe('today')
  if (process.env.SHOT) await window.screenshot({ path: '/tmp/sa-chat-images.png' })

  await tiles.first().locator('.chat-images-open').click()
  await expect(window.locator('.easy-lightbox img')).toBeVisible()
  if (process.env.SHOT) await window.screenshot({ path: '/tmp/sa-chat-lightbox.png' })
  // Esc closes the picture first, and the list is still there behind it.
  await window.keyboard.press('Escape')
  await expect(window.locator('.easy-lightbox')).toHaveCount(0)
  await expect(view).toBeVisible()
})

test('a picture can be downloaded straight from the list', async () => {
  const view = window.getByRole('dialog', { name: 'Images in this chat' })
  const before = saved().length
  const tile = view.locator('.chat-images-tile').nth(1)
  await tile.hover()
  await tile.getByRole('button', { name: 'Download Picture' }).click()
  await expect(tile.locator('.chat-images-save.done')).toBeVisible()
  expect(saved()).toHaveLength(before + 1)
  await window.keyboard.press('Escape')
  await expect(view).toHaveCount(0)
})

test('a picture leads back to the message it came from', async () => {
  await window.locator('.easy-control-btn:visible', { hasText: 'Images' }).click()
  const view = window.getByRole('dialog', { name: 'Images in this chat' })
  // The agent's picture, the newest: back to its reply.
  const tile = view.locator('.chat-images-tile').first()
  await tile.hover()
  await tile.getByRole('button', { name: /show in chat/ }).click()
  await expect(view).toHaveCount(0)
  const lit = window.locator('.easy-vrow-found')
  await expect(lit).toHaveCount(1)
  await expect(lit).toContainText('The header:')
  // And the light goes out by itself.
  await expect(lit).toHaveCount(0, { timeout: 5000 })
})
