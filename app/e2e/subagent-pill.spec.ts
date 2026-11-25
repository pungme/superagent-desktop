import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The "Running in background" strip names a sub-agent but gave no way to see what
 * it was doing. Its pill now opens onto its steps: the commands it ran, whether
 * they came back, and what it said. The stand-in `claude` starts a sub-agent
 * and streams its steps tagged with the call that started it.
 */
const FAKE = `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2)
const [cmd, sub] = args
if (cmd === '--version') { console.log('2.1.314 (Claude Code)'); process.exit(0) }
if (cmd === 'auth' && sub === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'e2e@example.com', subscriptionType: 'max' })); process.exit(0) }
if (cmd === 'mcp' || cmd === 'update') process.exit(0)
if (args.includes('text')) { console.log('Sub-agent'); process.exit(0) }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 's-sub', model: 'claude-opus-5-5', tools: [] })
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
    const P = 'agent-1'
    out({ type: 'assistant', message: { id: 'a1', role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: P, name: 'Agent', input: { description: 'Find why To-do loads slowly', subagent_type: 'general-purpose', prompt: 'look' } }
    ] } })
    const sub = (parent, content, type = 'assistant') => out({ type, parent_tool_use_id: parent, message: { id: 'm' + Math.random(), role: type, model: 'claude-opus-5-5', content } })
    setTimeout(() => {
      sub(P, [{ type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/repo/src/todo/List.tsx' } }])
      sub(P, [{ type: 'tool_result', tool_use_id: 's1', content: 'ok' }], 'user')
      sub(P, [{ type: 'text', text: 'The list renders every row; checking the query.' }])
      sub(P, [{ type: 'tool_use', id: 'w1', name: 'TodoWrite', input: { todos: [
        { content: 'Read the list', status: 'completed' },
        { content: 'Profile the query', status: 'in_progress' },
        { content: 'Write it up', status: 'pending' } ] } }])
      sub(P, [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }], 'user')
      sub(P, [{ type: 'thinking', thinking: 'The query returns every row, so the cost is in the render.' }])
      sub(P, [{ type: 'tool_use', id: 's2', name: 'Bash', input: { command: 'cd /repo && python profile.py' } }])
    }, 800)
    // Stay working until told to stop.
    const wait = setInterval(() => {
      if (!fs.existsSync(process.env.FAKE_DONE)) return
      clearInterval(wait)
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    }, 200)
  }
})
`

test('the sub-agent pill opens onto what the sub-agent is doing', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-subagent-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-subagent-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-subagent-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-subagent-home-'))
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
    await input.fill('find out why the to-do list is slow')
    await input.press('Enter')

    const pill = page.getByTestId('subagent-pill')
    await expect(pill).toBeVisible({ timeout: 20_000 })
    await expect(pill).toContainText('Find why To-do loads slowly')
    // What it is doing now is in the tooltip, before any click.
    await expect(pill).toHaveAttribute('title', /python profile\.py/, { timeout: 10_000 })

    await pill.click()
    const menu = page.getByTestId('subagent-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Find why To-do loads slowly')
    // How far along it is: its own to-do list, and what it is on.
    const progress = menu.getByTestId('subagent-progress')
    await expect(progress).toContainText('1 of 3 tasks done')
    await expect(progress).toContainText('on: Profile the query')
    // Its latest thinking.
    await expect(menu).toContainText('Thinking: The query returns every row')
    // A call that came back, what it said, and the one still running.
    await expect(menu.locator('.easy-agent-step.ok', { hasText: 'List.tsx' })).toHaveCount(1)
    await expect(menu).toContainText('The list renders every row')
    await expect(menu.locator('.easy-agent-step.now')).toContainText('python profile.py')

    if (process.env.SHOT) {
      await page.screenshot({ path: join(process.env.SHOT, 'subagent-pill.png') })
    }
    // Clicking again puts it away.
    await pill.click()
    await expect(menu).toHaveCount(0)

    writeFileSync(done, '1')
    expect(existsSync(done)).toBe(true)
  } finally {
    await app.close()
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})
