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
 * The Compact button (Memory bar past 75%): it sends /compact when the agent is idle, and when the
 * agent is working it waits (queued) and runs the moment the turn ends, instead of being dead.
 */
const compacts = (file: string): number => readFileSync(file, 'utf8').split('/compact').length - 1

const FAKE = `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2)
const [cmd, sub] = args
if (cmd === '--version') { console.log('2.1.314 (Claude Code)'); process.exit(0) }
if (cmd === 'auth' && sub === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'e2e@example.com', subscriptionType: 'max' })); process.exit(0) }
if (cmd === 'mcp' || cmd === 'update') process.exit(0)
if (args.includes('text')) { console.log('Header'); process.exit(0) }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 's-c', model: 'claude-sonnet-5-5', tools: [] })
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
    const slow = text.includes('SLOW')
    const done = () => {
      out({ type: 'assistant', message: { id: 'a' + Math.random(), role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 165000, output_tokens: 20 } } })
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    }
    if (slow) setTimeout(done, 4000); else done()
  }
})
`

test('Compact sends /compact when idle, and waits for a working turn instead of being dead', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-cb-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-cb-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-cb-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-cb-home-'))
  const log = join(fake, 'messages.log')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(home, '.claude.json'), '{}')
  writeFileSync(join(proj, 'README.md'), '# cb\n')
  writeFileSync(join(fake, 'claude'), FAKE)
  chmodSync(join(fake, 'claude'), 0o755)
  const app = await electron.launch({
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
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const w = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      await window.cove.chatCreate(w.id)
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    const input = page.locator('textarea.easy-input:visible').first()
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill('hello')
    await input.press('Enter')
    // 165k of the window: past three quarters, so the button is offered.
    const button = page.getByTestId('compact-button')
    await expect(button).toBeVisible({ timeout: 30_000 })
    await expect(button).toBeEnabled()
    // Idle: it sends /compact.
    await button.click()
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 20_000 })
      .toContain('/compact')

    // Working: it is not dead. It queues, and runs when the turn ends.
    await input.fill('SLOW one')
    await input.press('Enter')
    await expect(button).toBeVisible()
    await button.click()
    await expect(button).toContainText('Compact next')
    const before = compacts(log)
    await expect
      .poll(() => compacts(log), {
        timeout: 30_000
      })
      .toBe(before + 1)
  } finally {
    await app.close()
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})
