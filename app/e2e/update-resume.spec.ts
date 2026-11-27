import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  existsSync,
  readFileSync
} from 'fs'
import { tmpdir } from 'os'

/**
 * Restart now, with agents mid-turn: the chats that were working are written down, and the next
 * start tells each to carry on (main/update-resume.ts). Here the note is written by hand, as the
 * updater would just before quitting, and the app is started again.
 */
const FAKE = `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2)
const [cmd, sub] = args
if (cmd === '--version') { console.log('2.1.314 (Claude Code)'); process.exit(0) }
if (cmd === 'auth' && sub === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'e2e@example.com', subscriptionType: 'max' })); process.exit(0) }
if (cmd === 'mcp' || cmd === 'update') process.exit(0)
if (args.includes('text')) { console.log('Header'); process.exit(0) }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 's-w', model: 'claude-opus-5-5', tools: [] })
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const text = typeof msg.message.content === 'string' ? msg.message.content : msg.message.content.map((p) => p.text || '').join('')
    fs.appendFileSync(process.env.FAKE_LOG, text + '\\n---\\n')
    out({ type: 'assistant', message: { id: 'a' + Math.random(), role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'I fixed the header so it never wraps. Everything else is as it was.' }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
  }
})
`

test('a chat that was working when the app restarted is told to carry on', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-resume-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-resume-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-resume-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-resume-home-'))
  const log = join(fake, 'messages.log')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(home, '.claude.json'), '{}')
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  writeFileSync(join(fake, 'claude'), FAKE)
  chmodSync(join(fake, 'claude'), 0o755)
  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        COVE_USER_DATA: data,
        COVE_E2E_PROJECT: proj,
        COVE_E2E_CLAUDE_BIN: join(fake, 'claude'),
        FAKE_LOG: log,
        HOME: home,
        NODE_ENV: 'production'
      }
    })
  try {
    let app = await launch()
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    // Nothing was working: a plain restart sends nothing.
    await page.waitForTimeout(500)
    const chatId = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      const id = await window.cove.chatCreate(ws.id)
      await window.cove.kvSet(
        'resumeAfterUpdate',
        JSON.stringify({ at: Date.now(), chatIds: [id, 'gone-chat'] })
      )
      return id
    })
    expect(chatId).toBeTruthy()
    await app.close()

    app = await launch()
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 40_000 })
      .toContain('updated and restarted')
    // Once: the chat that no longer exists was skipped.
    expect(readFileSync(log, 'utf8').match(/updated and restarted/g)).toHaveLength(1)
    await app.close()
  } finally {
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})
