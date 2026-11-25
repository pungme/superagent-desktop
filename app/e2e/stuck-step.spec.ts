import { test, expect, _electron as electron } from '@playwright/test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A step that waits on something that never answers (a `find` over iCloud files
 * that are not on the Mac sat at 0% CPU for six and a half hours): the chat says it
 * looks stuck and Stop ends just that step. The stand-in `claude` starts a real
 * `sleep` as its tool and goes quiet; "stuck" is made seconds instead of ten minutes.
 */
const FAKE = `#!${process.execPath}
const fs = require('fs')
const { spawn } = require('child_process')
const args = process.argv.slice(2)
const [cmd, sub] = args
if (cmd === '--version') { console.log('2.1.314 (Claude Code)'); process.exit(0) }
if (cmd === 'auth' && sub === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'e2e@example.com', subscriptionType: 'max' })); process.exit(0) }
if (cmd === 'mcp' || cmd === 'update') process.exit(0)
if (args.includes('text')) { console.log('Stuck test'); process.exit(0) }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 's-stuck', model: 'claude-opus-5-5', tools: [] })
let buf = ''
let started = false
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user' || started) continue
    started = true
    out({ type: 'assistant', message: { id: 'a1', role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'find ~/Library/Mobile\\\\ Documents -iname "*Mr Market*"' } }
    ] } })
    // The step: a process that does nothing, started after the step began.
    const child = spawn('/bin/sleep', ['3600'], { stdio: 'ignore' })
    fs.writeFileSync(process.env.FAKE_PID, String(child.pid))
    child.on('exit', (code, signal) => {
      fs.writeFileSync(process.env.FAKE_PID + '.exit', String(signal || code))
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'Terminated' }] } })
      out({ type: 'assistant', message: { id: 'a2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The search was stopped; moving on.' }] } })
      out({ type: 'result', subtype: 'success', is_error: false, result: 'The search was stopped; moving on.' })
    })
  }
})
`

test('a step that does nothing is called stuck, and Stop ends just that step', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-stuck-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-stuck-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-stuck-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-stuck-home-'))
  const pidFile = join(fake, 'step.pid')
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
      COVE_E2E_STUCK_MS: '4000',
      FAKE_PID: pidFile,
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
      localStorage.setItem('cove.e2e.stuckPollMs', '1000')
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
    await input.fill('find the Mr Market screenplay')
    await input.press('Enter')

    // The step's process is running and doing nothing.
    await expect.poll(() => existsSync(pidFile), { timeout: 20_000 }).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).not.toThrow()

    // Not called stuck at once.
    const stuck = page.getByTestId('step-stuck')
    await page.waitForTimeout(1500)
    await expect(stuck).toHaveCount(0)

    // After the (shortened) idle time it is.
    await expect(stuck).toBeVisible({ timeout: 30_000 })
    await expect(stuck).toContainText('This step looks stuck')
    await expect(stuck).toContainText('sleep 3600')

    // Stop ends that process; the agent hears back and carries on.
    await stuck.getByRole('button', { name: 'Stop this step' }).click()
    await expect.poll(() => existsSync(pidFile + '.exit'), { timeout: 10_000 }).toBe(true)
    expect(readFileSync(pidFile + '.exit', 'utf8')).toBe('SIGTERM')
    await expect(page.locator('.easy-msg', { hasText: 'moving on' }).first()).toBeVisible({
      timeout: 15_000
    })
    await expect(stuck).toHaveCount(0)
  } finally {
    await app.close()
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {
      // gone, as it should be
    }
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})
