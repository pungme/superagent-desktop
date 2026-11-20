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
 * A chat no Mac window has open (the phone sent the message; the Today box uses the same
 * path) runs out of allowance. The window used to be what moved a chat to the next account
 * and sent the message again, so with none it simply stopped. Main does it now. The
 * stand-in `claude` runs out on the CLI's own login and answers on the token account.
 */
const TOKEN = 'sk-ant-oat01-' + 'e2e'.repeat(14)
const FAKE = `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2)
const [cmd, sub] = args
if (cmd === '--version') { console.log('2.1.314 (Claude Code)'); process.exit(0) }
if (cmd === 'auth' && sub === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'e2e@example.com', subscriptionType: 'max' })); process.exit(0) }
if (cmd === 'mcp' || cmd === 'update') process.exit(0)
// A one-shot title: text in, text out.
if (args.includes('text')) { console.log('Limit test'); process.exit(0) }
const who = process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'token' : 'login'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 's-' + who, model: 'claude-fable-5-2', tools: [] })
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const content = msg.message && msg.message.content
    const text = typeof content === 'string' ? content : (content || []).map((b) => b.text || '').join(' ')
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ who, text }) + '\\n')
    if (who === 'login') {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit" })
    } else {
      out({ type: 'assistant', message: { id: 'a1', role: 'assistant', model: 'claude-fable-5-2', content: [{ type: 'text', text: 'Done on the second account.' }] } })
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Done on the second account.' })
    }
  }
})
`

test('out of allowance with no window on the chat: main moves it and sends the message again', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-nowin-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-nowin-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-nowin-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-nowin-home-'))
  const log = join(fake, 'runs.log')
  writeFileSync(join(home, '.zshrc'), `export PATH="${fake}:$PATH"\n`)
  writeFileSync(join(home, '.bashrc'), `export PATH="${fake}:$PATH"\n`)
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
    await page.evaluate((t) => window.cove.accountsAddClaude('Second account', t), TOKEN)

    // Into a chat no window shows, by the phone's own send path.
    const r = await page.evaluate(() =>
      window.cove.todayAsk('Rename the screenshots on my desktop')
    )
    expect(r).toBeTruthy()
    const runs = (): { who: string; text: string }[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : []
    // First on the CLI's own login, which is out; then the same message on the second account.
    await expect
      .poll(() => runs().map((x) => x.who), { timeout: 40_000 })
      .toEqual(['login', 'token'])
    expect(runs()[1].text).toContain('Rename the screenshots on my desktop')
    // And the chat stays on it.
    const accounts = JSON.parse(readFileSync(join(data, 'accounts.json'), 'utf8')) as {
      accounts: { id: string; name: string }[]
      chats: Record<string, string>
    }
    const second = accounts.accounts.find((a) => a.name === 'Second account')!
    expect(Object.values(accounts.chats)).toContain(second.id)
  } finally {
    await app.close()
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})
