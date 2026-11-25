import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The agent starts a turn nobody typed (a background task finished, it carries on
 * after asking a question): the chat used to fill with steps and show no spinner,
 * because "working" was only switched on by a message from you. The stand-in
 * `claude` ends one turn, then runs another by itself and ends it when told to.
 */
const FAKE = `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2)
const [cmd, sub] = args
if (cmd === '--version') { console.log('2.1.314 (Claude Code)'); process.exit(0) }
if (cmd === 'auth' && sub === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'e2e@example.com', subscriptionType: 'max' })); process.exit(0) }
if (cmd === 'mcp' || cmd === 'update') process.exit(0)
if (args.includes('text')) { console.log('Unprompted'); process.exit(0) }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 's-unprompted', model: 'claude-opus-5-5', tools: [] })
let buf = ''
let first = true
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim() || !first) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    first = false
    out({ type: 'assistant', message: { id: 'a1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Which colours do you want?' }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Which colours do you want?' })
    // Then, with nobody asking: carry on by itself.
    setTimeout(() => {
      out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'a2' } } })
      out({ type: 'assistant', message: { id: 'a2', role: 'assistant', model: 'claude-opus-5-5', content: [
        { type: 'tool_use', id: 'tool-9', name: 'Bash', input: { command: 'npm run build' } }
      ] } })
      const wait = setInterval(() => {
        if (!fs.existsSync(process.env.FAKE_DONE)) return
        clearInterval(wait)
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-9', content: 'built' }] } })
        out({ type: 'assistant', message: { id: 'a3', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The preview is built.' }] } })
        out({ type: 'result', subtype: 'success', is_error: false, result: 'The preview is built.' })
      }, 200)
    }, 2500)
  }
})
`

test('a turn the agent starts by itself shows the spinner, and ends when it ends', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-unprompted-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-unprompted-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-unprompted-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-unprompted-home-'))
  const done = join(fake, 'done')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(home, '.claude.json'), '{}')
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  writeFileSync(join(fake, 'claude'), FAKE)
  chmodSync(join(fake, 'claude'), 0o755)
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_CLAUDE_BIN: join(fake, 'claude'),
      FAKE_DONE: done,
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
    await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    const input = page.locator('textarea.easy-input:visible')
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill('optimise the storefront')
    await input.press('Enter')

    // The first turn ends: no spinner.
    await expect(page.locator('.easy-msg', { hasText: 'Which colours' }).first()).toBeVisible({
      timeout: 20_000
    })
    const spinner = page.locator('.easy-think-mark:visible')
    await expect(spinner).toHaveCount(0, { timeout: 10_000 })

    // Then the agent carries on by itself, and nobody typed anything: the spinner shows.
    await expect(spinner.first()).toBeVisible({ timeout: 20_000 })

    // And it goes when that turn ends.
    writeFileSync(done, '1')
    expect(existsSync(done)).toBe(true)
    await expect(page.locator('.easy-msg', { hasText: 'preview is built' }).first()).toBeVisible({
      timeout: 15_000
    })
    await expect(spinner).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await app.close()
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})
