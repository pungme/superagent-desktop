import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A chat moved to Antigravity from the phone: the window that had it open still
 * held Claude's thread id and asked Antigravity to resume it, which it cannot
 * ("the earlier session could not be resumed", 2026-11-25). Main now resumes
 * the thread the chat's record names, whatever the window asks for. The
 * stand-in `agy` writes down the conversation it was asked to resume.
 */
const FAKE = `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2)
if (args[0] === 'models') { console.log('gemini-4-neon-high\\tGemini 4 Neon (High)'); process.exit(0) }
if (args[0] !== '--input-format') process.exit(1)
const i = args.indexOf('--conversation')
fs.appendFileSync(process.env.FAKE_LOG, (i >= 0 ? args[i + 1] : '-') + '\\n')
const conv = i >= 0 ? args[i + 1] : 'agy-new'
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: conv, init: { model: 'gemini-4-neon-high', tools: [] } }) + '\\n')
process.stdin.on('data', () => {})
`

test("a chat resumes its own agent's thread, not one a window still holds", async () => {
  test.setTimeout(90_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-resume-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-resume-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-resume-cli-'))
  const log = join(fake, 'resumed.log')
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  writeFileSync(join(fake, 'agy'), FAKE)
  chmodSync(join(fake, 'agy'), 0o755)
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_AGY_BIN: join(fake, 'agy'),
      FAKE_LOG: log,
      NODE_ENV: 'production'
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const ids = await page.evaluate(async () => {
      localStorage.setItem('cove.onboarded', '1')
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      const chatId = await window.cove.chatCreate(ws.id)
      // The chat is on Antigravity, with its own thread on record.
      await window.cove.chatUpdate(chatId, { provider: 'antigravity' })
      await window.cove.chatUpdate(chatId, { claudeSessionId: 'agy-own-thread' })
      return { chatId, wsId: ws.id }
    })
    // What a window that still held Claude's thread would send.
    await page.evaluate(
      ({ chatId, wsId }) =>
        window.cove.agentStart({
          chatId,
          workspaceId: wsId,
          cwd: '/tmp',
          provider: 'antigravity',
          resumeSessionId: '7475bf59-8485-4337-b2f8-015e0cd29111'
        } as never),
      ids
    )
    await expect.poll(() => existsSync(log), { timeout: 20_000 }).toBe(true)
    expect(readFileSync(log, 'utf8').trim().split('\n')[0]).toBe('agy-own-thread')
  } finally {
    await app.close()
    for (const d of [data, proj, fake]) rmSync(d, { recursive: true, force: true })
  }
})
