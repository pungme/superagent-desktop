/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript entry point run directly by Node. */
/** Real Mail + real app IPC + HTTP MCP. Opt-in: reads a small inbox sample,
 * saves one test draft to example.invalid, verifies it, then moves only that
 * draft to Trash. Never sends. Prints counts/booleans, not mailbox content.
 * MAIL_LIVE=1 node scripts/test-mail-live.mjs
 * MAIL_TEST_EXECUTABLE=/path/to/SuperAgent.app/Contents/MacOS/SuperAgent tests a signed bundle.
 */
import { _electron as electron } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

if (process.env.MAIL_LIVE !== '1')
  throw new Error(
    'Opt in with MAIL_LIVE=1; this test accesses real Mail and creates one unsent test draft.'
  )
const dir = mkdtempSync(join(tmpdir(), 'superagent-mail-live-'))
const urlFile = join(dir, 'mcp-url')
const results = []
const report = (name, details = true) => {
  results.push({ name, details })
  console.log(name, JSON.stringify(details))
}
const fixture = {
  subject: `Superagent live test — unsent — ${Date.now()}`,
  body: 'Test only. Never send.\n"Quotes", apostrophe\'s, \\ backslash.\nGrüß dich 日本語 😀\nLiteral: $(echo NOT_EXECUTED)',
  to: ['superagent-test@example.invalid']
}
let app,
  client,
  draftCreated = false
const native = (source, input) =>
  JSON.parse(
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source, JSON.stringify(input)], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  )
const checkDraft = `function run(argv) { var f=JSON.parse(argv[0]), m=Application('com.apple.mail'), ds=m.draftsMailbox.messages.whose({subject:f.subject}); return JSON.stringify({count:ds.length, body:ds.length===1 && String(ds[0].content()).indexOf(f.body)>=0, recipient:ds.length===1 && ds[0].toRecipients[0].address()===f.to[0], sent:m.sentMailbox.messages.whose({subject:f.subject}).length, outbox:m.outbox.messages.whose({subject:f.subject}).length}); }`
const cleanupDraft = `function run(argv) {
  var f=JSON.parse(argv[0]),m=Application('com.apple.mail');
  var outs=m.outgoingMessages.whose({subject:f.subject});
  for(var i=outs.length-1;i>=0;i--) m.close(outs[i],{saving:'no'});
  var predicate={_and:[{subject:f.subject},{deletedStatus:false}]};
  var ds=m.draftsMailbox.messages.whose(predicate),count=0;
  for(var i=ds.length-1;i>=0;i--){
    if(ds[i].toRecipients.length===1 && ds[i].toRecipients[0].address()===f.to[0]) {m.delete(ds[i]);count++;}
  }
  return JSON.stringify({removed:count,remaining:m.draftsMailbox.messages.whose(predicate).length});
}`
async function launch() {
  const executablePath = process.env.MAIL_TEST_EXECUTABLE
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [resolve('out/main/index.js')] }),
    env: {
      ...process.env,
      COVE_USER_DATA: dir,
      COVE_E2E_QUIET: '1',
      COVE_E2E_MCP_URL_FILE: urlFile,
      NODE_ENV: 'production'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await page.reload()
  await page.locator('.sidebar').waitFor()
  await page.locator('.sidebar-settings[title="Settings"]').click()
  await page.getByRole('button', { name: 'Connections', exact: false }).click()
  const base = readFileSync(urlFile, 'utf8').trim()
  const url = new URL(base)
  url.searchParams.set('ws', '__desktop_chat__')
  client = new Client({ name: 'mail-live-verifier', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(url))
  return page
}
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args })
  if (r.isError) throw new Error(`${name}: ${r.content.find((c) => c.type === 'text')?.text}`)
  const envelope = JSON.parse(r.content.find((c) => c.type === 'text').text)
  if (name !== 'mail_draft') assert.equal(envelope.trust, 'untrusted-email-data')
  return envelope.data
}
try {
  let page = await launch()
  assert.equal((await page.evaluate(() => window.cove.mailStatus())).connected, false)
  assert.equal(
    (await client.listTools()).tools.some((t) => t.name.startsWith('mail_')),
    false
  )
  report('disconnected discovery hides Mail')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor({ timeout: 130000 })
  assert.equal((await page.evaluate(() => window.cove.mailStatus())).connected, true)
  assert.deepEqual(
    (await client.listTools()).tools.filter((t) => t.name.startsWith('mail_')).map((t) => t.name),
    ['mail_accounts', 'mail_search', 'mail_read', 'mail_draft']
  )
  report('Connect through real UI and discover four tools')
  const accounts = await call('mail_accounts')
  assert.ok(accounts.accounts.length > 0, 'Need at least one configured Mail account')
  report('real accounts', {
    accounts: accounts.accounts.length,
    mailboxCount: accounts.accounts.reduce((n, a) => n + a.mailboxPaths.length, 0)
  })
  const first = await call('mail_search', { limit: 2 })
  assert.ok(first.messages.length > 0, 'Need at least one inbox message for read coverage')
  const next = await call('mail_search', { offset: first.nextOffset ?? 2, limit: 2 })
  assert.ok(
    first.messages.every(
      (m) =>
        !next.messages.some(
          (n) =>
            n.locator.messageId === m.locator.messageId &&
            n.locator.accountId === m.locator.accountId
        )
    )
  )
  for (const m of first.messages) {
    const acct = accounts.accounts.find((a) => a.id === m.locator.accountId)
    assert.ok(
      acct.mailboxPaths.some((p) => JSON.stringify(p) === JSON.stringify(m.locator.mailboxPath)),
      'Search locator must match an enumerated mailbox'
    )
    const read = await call('mail_read', { ...m.locator, maxChars: 80 })
    assert.equal(read.locator.messageId, m.locator.messageId)
    assert.equal(read.unread, m.unread)
    assert.ok(read.body.length <= 80)
  }
  report('search → read, pagination, body limit, and unread preserved', {
    readCount: first.messages.length
  })
  for (const args of [
    { query: fixture.subject },
    { unreadOnly: true },
    { query: fixture.subject, unreadOnly: true }
  ]) {
    console.log(
      'checking search filter',
      args.query ? (args.unreadOnly ? 'query + unread' : 'query') : 'unread'
    )
    const r = await call('mail_search', { ...args, limit: 2 })
    if (args.query) assert.equal(r.messages.length, 0)
    if (args.unreadOnly) assert.ok(r.messages.every((m) => m.unread))
  }
  const known = first.messages[0].locator
  await call('mail_search', {
    accountId: known.accountId,
    mailboxPath: known.mailboxPath,
    query: '"quoted" \\ $() 😀 NO_MATCH',
    limit: 1
  })
  report('query-only, unread-only, combined, quoted, and scoped search')
  const invalid = await client.callTool({ name: 'mail_search', arguments: { limit: 9999 } })
  assert.equal(invalid.isError, true)
  const missing = await client.callTool({
    name: 'mail_read',
    arguments: { ...known, messageId: 2147483647 }
  })
  assert.equal(missing.isError, true)
  report('invalid limit and stale message errors')
  draftCreated = true // A timed-out creation may still have saved a draft.
  const draft = await call('mail_draft', fixture)
  assert.equal(draft.saved, true)
  assert.equal(draft.sent, false)
  const checked = native(checkDraft, fixture)
  assert.deepEqual(checked, { count: 1, body: true, recipient: true, sent: 0, outbox: 0 })
  report('unsent draft independently verified in Mail', checked)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.getByRole('button', { name: 'Connect', exact: true }).waitFor()
  assert.equal(
    (await client.listTools()).tools.some((t) => t.name.startsWith('mail_')),
    false
  )
  const revoked = await client.callTool({ name: 'mail_read', arguments: known })
  assert.equal(revoked.isError, true)
  report('disconnect removes discovery and blocks existing MCP client')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor({ timeout: 130000 })
  await client.close()
  await app.close()
  app = undefined
  page = await launch()
  assert.equal((await page.evaluate(() => window.cove.mailStatus())).connected, true)
  await call('mail_accounts')
  report('reconnect and persistence across real app restart')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.getByRole('button', { name: 'Connect', exact: true }).waitFor()
} finally {
  try {
    if (draftCreated) {
      let cleaned
      for (let attempt = 0; attempt < 5; attempt++) {
        cleaned = native(cleanupDraft, fixture)
        if (cleaned.remaining === 0) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      assert.equal(cleaned.remaining, 0, 'Test draft should be removed from active Drafts')
      report('test draft moved to Trash', cleaned)
    }
  } finally {
    await client?.close().catch(() => {})
    await app?.close().catch(() => {})
    writeFileSync(
      process.env.MAIL_TEST_REPORT || '/tmp/superagent-mail-live-report.json',
      JSON.stringify(results, null, 2)
    )
    rmSync(dir, { recursive: true, force: true })
  }
}
