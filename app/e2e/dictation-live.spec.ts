import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Dictation for real (DICTATION_LIVE=1): macOS `say` speaks a sentence into a
 * file, Chromium plays it as the microphone, and Whisper runs in its worker.
 * The words must appear in the composer while the mic is still held, and the
 * whole sentence lands when it is let go. The model is downloaded once into
 * DICTATION_DATA (or a temporary folder), so the first run is slow.
 */
/**
 * `say` puts a JUNK chunk before "fmt ", and Chromium's fake microphone then
 * plays silence. Rewrite the file as the plain 44-byte-header WAV it reads.
 */
function plainWav(path: string): void {
  const src = readFileSync(path)
  const chunks: Record<string, Buffer> = {}
  for (let at = 12; at + 8 <= src.length;) {
    const id = src.toString('ascii', at, at + 4)
    const size = src.readUInt32LE(at + 4)
    chunks[id] = src.subarray(at + 8, at + 8 + size)
    at += 8 + size + (size % 2)
  }
  const fmt = chunks['fmt ']
  const data = chunks.data
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4)
  head.write('WAVE', 8, 'ascii')
  const chunk = (id: string, body: Buffer): Buffer => {
    const h = Buffer.alloc(8)
    h.write(id, 0, 'ascii')
    h.writeUInt32LE(body.length, 4)
    return Buffer.concat([h, body])
  }
  writeFileSync(path, Buffer.concat([head, chunk('fmt ', fmt), chunk('data', data)]))
}

test.skip(!process.env.DICTATION_LIVE, 'set DICTATION_LIVE=1 (downloads the speech model)')
test.setTimeout(10 * 60_000)

test('the words appear while you speak, and the sentence lands when you stop', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cove-dictate-'))
  const data = process.env.DICTATION_DATA ?? join(work, 'data')
  mkdirSync(data, { recursive: true })
  const proj = join(work, 'proj')
  mkdirSync(proj)
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const wav = join(work, 'speech.wav')
  execFileSync('/usr/bin/say', [
    '-o',
    wav,
    '--data-format=LEI16@16000',
    'Make the pricing page match the new plans. Free, pro and team, side by side, with a yearly switch.'
  ])
  expect(existsSync(wav)).toBe(true)
  plainWav(wav)

  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      // The spoken file is the microphone (harden.ts).
      COVE_E2E_FAKE_AUDIO: wav,
      NODE_ENV: 'production'
    }
  })
  try {
    const window = await app.firstWindow()
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await window.click('.sidebar-item:has-text("e2e-project")')
    // The test's Electron is not the app macOS asked about: the microphone is on.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('mic:access')
      ipcMain.handle('mic:access', () => 'granted')
    })
    const input = window.locator('textarea.easy-input:visible')
    await expect(input).toBeVisible({ timeout: 20_000 })

    // Load the model first (a one-time download), so the timing below is about dictation.
    const mic = window.locator('.easy-mic:visible')
    await mic.dispatchEvent('pointerdown')
    await expect(mic).toHaveClass(/recording/)
    await window.waitForTimeout(1500)
    await mic.dispatchEvent('pointerup')
    await expect(mic).not.toHaveClass(/recording/, { timeout: 8 * 60_000 })
    await expect(mic).toBeEnabled({ timeout: 8 * 60_000 })
    await input.fill('')

    // Now for real: hold, and watch the words come while still holding.
    await mic.dispatchEvent('pointerdown')
    await expect(mic).toHaveClass(/recording/)
    const started = Date.now()
    await expect(input).toHaveValue(/\w{3,}/, { timeout: 15_000 })
    const firstWordsAfter = Date.now() - started
    await expect(mic).toHaveClass(/recording/) // still listening: these words came while speaking
    await window.screenshot({ path: 'test-results/dictation-live-partial.png' })
    await window.waitForTimeout(6000)
    await mic.dispatchEvent('pointerup')
    await expect(mic).toBeEnabled({ timeout: 60_000 })
    const final = await input.inputValue()
    console.log(`first words after ${firstWordsAfter} ms; final: ${final}`)
    expect(final.toLowerCase()).toMatch(/pricing/)
    expect(await input.getAttribute('readonly')).toBeNull()
  } finally {
    await app.close()
    rmSync(work, { recursive: true, force: true })
  }
})
