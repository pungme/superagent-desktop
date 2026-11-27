import { test, expect, _electron as electron, type Page } from '@playwright/test'
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
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Conductor: a project's Main chat and its sessions. Turned on, chats connected to it with
 * their numbers, listed and read by the Main chat's own tools (called over HTTP the way Claude
 * Code calls them), closed and reopened from the Sessions tab, routing set to Auto.
 */
let mcpUrl = ''
let wsId = ''
let mainId = ''

async function tool(
  name: string,
  args: Record<string, unknown> = {},
  chat = mainId
): Promise<string> {
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(wsId)}&chat=${encodeURIComponent(chat)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    }
  )
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6)
  const msg = JSON.parse(json) as {
    result?: { content: { text?: string }[] }
    error?: { message: string }
  }
  if (msg.error) throw new Error(msg.error.message)
  return msg.result!.content.map((c) => c.text ?? '').join('\n')
}

test('conductor: Main chat, numbered sessions, the Sessions tab, its own tools', async () => {
  test.setTimeout(40_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-conductor-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-conductor-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const urlFile = join(data, 'mcp-url.txt')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      NODE_ENV: 'production'
    }
  })
  try {
    const page: Page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect.poll(() => existsSync(urlFile)).toBe(true)
    mcpUrl = readFileSync(urlFile, 'utf8')

    const made = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      const a = await window.cove.chatCreate(ws.id)
      const b = await window.cove.chatCreate(ws.id)
      const state = await window.cove.conductorEnable(ws.id, [a])
      return { wsId: ws.id, a, b, state }
    })
    wsId = made.wsId
    mainId = made.state!.chatId
    await tool('app_rename_chat', { chatId: made.a, title: 'Fix the header' }, made.a)
    await tool('app_rename_chat', { chatId: made.b, title: 'Pricing page' }, made.b)
    // Main exists, chat `a` is connected as #101.
    expect(made.state!.sessions.map((s) => s.ticket)).toEqual([101])
    expect(made.state!.unlinked.map((c) => c.chatId)).toContain(made.b)

    // The Main chat's own tools.
    const list = await tool('conductor_list_sessions')
    expect(list).toContain('#101')
    expect(list).toContain('Routing: Confirm')
    expect(await tool('conductor_adopt_session', { chatId: made.b })).toContain('#102')
    expect(
      await tool('conductor_note_session', { ticket: 102, summary: 'Waiting on the design' })
    ).toContain('Noted')
    expect(await tool('conductor_list_sessions')).toContain('Waiting on the design')
    expect(await tool('conductor_inspect_session', { ticket: 101 })).toContain('#101')
    // Each session drives a browser of its own, as any chat does.
    writeFileSync(join(proj, 'a.html'), '<title>Session A</title><h1>Page of A</h1>')
    writeFileSync(join(proj, 'b.html'), '<title>Session B</title><h1>Page of B</h1>')
    await tool('browser_navigate', { url: `file://${join(proj, 'a.html')}` }, made.a)
    await tool('browser_navigate', { url: `file://${join(proj, 'b.html')}` }, made.b)
    await expect.poll(() => tool('browser_read_page', {}, made.a)).toContain('Page of A')
    await expect.poll(() => tool('browser_read_page', {}, made.b)).toContain('Page of B')
    expect(await tool('browser_read_page', {}, made.a)).not.toContain('Page of B')
    // Any other chat of the project has no Conductor tools.
    const other = await tool('conductor_list_sessions', {}, made.a).catch((e) => String(e))
    expect(other).not.toContain('#101')

    // A session asks to run something: the Sessions tab shows what, and Approve answers it.
    const asked = tool(
      'permission_prompt',
      { tool_name: 'Bash', input: { command: 'rm -rf build' } },
      made.a
    )
    await expect.poll(() => tool('conductor_list_sessions')).toContain('Needs you')
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    if (
      !(await page
        .getByTestId('tab-sessions')
        .isVisible()
        .catch(() => false))
    )
      await page
        .locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible')
        .first()
        .click()
    await page.getByTestId('tab-sessions').click()
    await expect(page.getByTestId('conductor-approval')).toContainText('rm -rf build')
    await expect(page.getByTestId('tab-sessions').locator('.cd-tabdot')).toBeVisible()
    await page.getByTestId('conductor-approve').click()
    expect(await asked).toContain('allow')
    await expect(page.getByTestId('conductor-approval')).toHaveCount(0)
    // And one denied from the same place.
    const refused2 = tool(
      'permission_prompt',
      { tool_name: 'Bash', input: { command: 'git push' } },
      made.a
    )
    await expect(page.getByTestId('conductor-approval')).toContainText('git push', {
      timeout: 10_000
    })
    await page.getByTestId('conductor-approval').getByText('Deny').click()
    expect(await refused2).toContain('deny')

    // The Sessions tab.
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    if (
      !(await page
        .getByTestId('tab-sessions')
        .isVisible()
        .catch(() => false))
    )
      await page
        .locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible')
        .first()
        .click()
    await page.getByTestId('tab-sessions').click()
    const panel = page.getByTestId('conductor-panel')
    await expect(panel.getByTestId('conductor-session')).toHaveCount(2)
    await expect(panel).toContainText('#101')
    await expect(panel).toContainText('Pricing page')
    await expect(panel).toContainText('Waiting on the design')
    if (process.env.SHOT) {
      await page.evaluate(() => document.querySelector('.intro')?.remove())
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(process.env.SHOT, 'conductor-panel.png') })
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(process.env.SHOT, 'conductor-panel-dark.png') })
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    }

    // The sidebar numbers the sessions too.
    await expect(page.locator('.sidebar')).toContainText('#101 Fix the header')

    // Peek: the arrow shows a session's latest messages under its row.
    await panel.locator('.cd-peek-btn').first().click()
    await expect(panel.locator('.cd-peek')).toContainText(
      /Nothing in that conversation yet|USER|AGENT/
    )
    await panel.locator('.cd-peek-btn').first().click()
    await expect(panel.locator('.cd-peek')).toHaveCount(0)

    // In Main, a session's question is a card above the composer.
    await panel.getByTestId('conductor-main').click()
    const asked3 = tool(
      'permission_prompt',
      { tool_name: 'Bash', input: { command: 'make deploy' } },
      made.a
    )
    await expect(page.getByTestId('conductor-escalations')).toContainText('make deploy', {
      timeout: 10_000
    })
    await expect(page.getByTestId('conductor-escalations')).toContainText('#101')
    await page.getByTestId('conductor-escalations').getByRole('button', { name: 'Approve' }).click()
    expect(await asked3).toContain('allow')
    await expect(page.getByTestId('conductor-escalations')).toHaveCount(0)
    // The side panel is per conversation: bring Sessions back on Main for what follows.
    await page.waitForTimeout(1500) // let the pane settle after the card goes
    if (!(await panel.isVisible().catch(() => false))) {
      await page
        .locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible')
        .first()
        .click()
      await page.getByTestId('tab-sessions').click()
    }

    // Routing, from the panel and as the Main chat sees it.
    await panel.getByTestId('conductor-routing').selectOption('auto')
    await expect.poll(() => tool('conductor_list_sessions')).toContain('Routing: Auto')

    // Closed from the panel, reopened. (The chat on screen stays in the list, so look at Main.)
    await panel.getByTestId('conductor-main').click()
    // The side panel is per conversation: open Sessions again on Main if it is not there.
    if (!(await panel.isVisible().catch(() => false))) {
      await page
        .locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible')
        .first()
        .click()
      await page.getByTestId('tab-sessions').click()
    }
    await panel.getByTestId('conductor-session').first().hover()
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click()
    await expect(panel.getByTestId('conductor-session')).toHaveCount(1)
    // A closed session is archived: not in the sidebar list any more.
    await expect(page.locator('.sidebar')).not.toContainText('#101 Fix the header')
    await panel.getByText(/Closed \(1\)/).click()
    await panel.getByRole('button', { name: 'Reopen' }).click({ force: true })
    await expect(panel.getByTestId('conductor-session')).toHaveCount(2)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})

/** A stand-in `claude`: writes down each message it is given, and answers with one sentence. */
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

test('conductor: Main starts a worker, which gets its brief and leaves a summary', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-conductor2-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-conductor2-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-conductor2-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-conductor2-home-'))
  const log = join(fake, 'messages.log')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(home, '.claude.json'), '{}')
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  writeFileSync(join(fake, 'claude'), FAKE)
  chmodSync(join(fake, 'claude'), 0o755)
  const urlFile = join(data, 'mcp-url.txt')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      COVE_E2E_CLAUDE_BIN: join(fake, 'claude'),
      FAKE_LOG: log,
      HOME: home,
      NODE_ENV: 'production'
    }
  })
  try {
    const page: Page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect.poll(() => existsSync(urlFile)).toBe(true)
    mcpUrl = readFileSync(urlFile, 'utf8')
    const made = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      return { wsId: ws.id, state: await window.cove.conductorEnable(ws.id, []) }
    })
    wsId = made.wsId
    mainId = made.state!.chatId

    const started = await tool('conductor_spawn_session', {
      task: 'Fix the header so it never wraps on a phone.',
      title: 'Fix the header'
    })
    expect(started).toContain('#101')
    // The worker got the brief, as typed.
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''))
      .toContain('Fix the header so it never wraps on a phone.')
    // It finished a turn: the list carries its summary, written by Superagent.
    await expect
      .poll(() => tool('conductor_list_sessions'), { timeout: 20_000 })
      .toContain('I fixed the header so it never wraps.')
    // A follow-up goes to the same worker.
    expect(
      await tool('conductor_send_to_session', { ticket: 101, text: 'Also check the footer.' })
    ).toContain('#101')
    await expect.poll(() => readFileSync(log, 'utf8')).toContain('Also check the footer.')
    // A second task is a second session.
    expect(await tool('conductor_spawn_session', { task: 'Look at the pricing page.' })).toContain(
      '#102'
    )
  } finally {
    await app.close()
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})

test('conductor: each session gets its own worktree, and closing one with unmerged commits asks first', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-conductor3-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-conductor3-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-conductor3-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-conductor3-home-'))
  const log = join(fake, 'messages.log')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(home, '.claude.json'), '{}')
  // A real git repository with one commit on main.
  const git = (cwd: string, ...a: string[]): string =>
    execFileSync('git', ['-C', cwd, ...a], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home }
    })
  git(proj, 'init', '-q', '-b', 'main')
  git(proj, 'config', 'user.email', 'e2e@example.com')
  git(proj, 'config', 'user.name', 'e2e')
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  git(proj, 'add', '.')
  git(proj, 'commit', '-qm', 'first')
  writeFileSync(join(fake, 'claude'), FAKE)
  chmodSync(join(fake, 'claude'), 0o755)
  const urlFile = join(data, 'mcp-url.txt')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      COVE_E2E_CLAUDE_BIN: join(fake, 'claude'),
      FAKE_LOG: log,
      HOME: home,
      NODE_ENV: 'production'
    }
  })
  try {
    const page: Page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect.poll(() => existsSync(urlFile)).toBe(true)
    mcpUrl = readFileSync(urlFile, 'utf8')
    const made = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      return { wsId: ws.id, state: await window.cove.conductorEnable(ws.id, []) }
    })
    wsId = made.wsId
    mainId = made.state!.chatId

    // Two tasks, two sessions, each in a worktree of its own on its own branch.
    await tool('conductor_spawn_session', {
      task: 'Fix the header so it never wraps.',
      title: 'Fix the header'
    })
    await tool('conductor_spawn_session', { task: 'Redo the pricing page.', title: 'Pricing page' })
    const cwds = async (): Promise<(string | null)[]> =>
      page.evaluate(async (ws) => {
        const chats = await window.cove.chatList(ws)
        return chats.filter((c) => c.ticketNumber != null).map((c) => c.cwd)
      }, wsId)
    await expect
      .poll(async () => (await cwds()).filter(Boolean).length, { timeout: 20_000 })
      .toBe(2)
    const [a, b] = (await cwds()) as string[]
    expect(a).not.toBe(b)
    expect(a).not.toBe(proj)
    const branchA = git(a, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
    const branchB = git(b, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
    expect(branchA).not.toBe('main')
    expect(branchA).not.toBe(branchB)
    // The list says which branch each session is on.
    await expect.poll(() => tool('conductor_list_sessions')).toContain(branchA)

    // #101 commits on its branch: closing it asks how, until told.
    writeFileSync(join(a, 'header.txt'), 'fixed\n')
    git(a, 'add', '.')
    git(a, 'commit', '-qm', 'Fix the header')
    expect(await tool('conductor_list_sessions')).toContain('1 unmerged')
    const refused = await tool('conductor_close_session', { ticket: 101 }).catch((e) => String(e))
    expect(refused).toContain('not in the main branch')
    expect(await tool('conductor_list_sessions')).toContain('#101')
    // Merged and kept open: the commit lands on main, and the session stays in the list.
    expect(await tool('conductor_merge_session', { ticket: 101 })).toContain('stays open')
    expect(git(proj, 'log', '--oneline', 'main')).toContain('Fix the header')
    expect(await tool('conductor_list_sessions')).toContain('#101')
    expect(await tool('conductor_list_sessions')).not.toContain('1 unmerged')
    // Closed: nothing is left to ask about.
    expect(await tool('conductor_close_session', { ticket: 101 })).toContain('Closed #101')
    expect(await tool('conductor_list_sessions')).not.toContain('#101')
    // #102, with nothing to merge, closes straight away; its branch was not touched.
    expect(await tool('conductor_close_session', { ticket: 102 })).toContain('Closed #102')
  } finally {
    await app.close()
    for (const d of [data, proj, fake, home]) rmSync(d, { recursive: true, force: true })
  }
})
