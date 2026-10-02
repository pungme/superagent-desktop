/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript entry point run directly by Node. */
/** Opt-in real-provider test, no message bodies: each provider searches for a
 * unique nonexistent subject, then a fresh session checks the disconnected state.
 * MAIL_LIVE=1 node scripts/test-mail-agents-live.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
if (process.env.MAIL_LIVE !== '1')
  throw new Error('MAIL_LIVE=1 is required; this runs signed-in agent CLIs.')
const dir = mkdtempSync(join(tmpdir(), 'superagent-mail-agents-'))
const results = []
const app = await electron.launch({
  ...(process.env.MAIL_TEST_EXECUTABLE
    ? { executablePath: process.env.MAIL_TEST_EXECUTABLE, args: [] }
    : { args: [resolve('out/main/index.js')] }),
  env: { ...process.env, COVE_USER_DATA: dir, COVE_E2E_QUIET: '1', NODE_ENV: 'production' }
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await page.reload()
  const status = await page.evaluate(() => window.cove.mailConnect())
  assert.equal(status.connected, true, status.error)
  async function run(provider, connected) {
    const marker = `SUPERAGENT_NONEXISTENT_MAIL_TEST_${Date.now()}_${provider}`
    const prompt = connected
      ? `Is Apple Mail connected through this app? Use the built-in email search tool to search inbox subjects/senders for exactly ${marker}. Return only CONNECTION:connected or CONNECTION:disconnected and MATCHES:<number>. Do not use shell or UI, read bodies, list accounts, or print private information.`
      : 'Is Apple Mail connected through this app? Use your startup briefing; do not call any tools. Reply only CONNECTION:connected or CONNECTION:disconnected.'
    const outcome = await page.evaluate(
      async ({ provider, prompt, cwd }) => {
        const chatId = await window.cove.chatCreate('__desktop_chat__', cwd)
        const id = await window.cove.agentStart({
          provider,
          cwd,
          workspaceId: '__desktop_chat__',
          chatId,
          permissionMode: 'bypassPermissions'
        })
        return await new Promise((resolve) => {
          const tools = [],
            texts = []
          let ended = false
          const finish = (result) => {
            if (ended) return
            ended = true
            clearTimeout(timer)
            offEvent()
            offExit()
            window.cove.agentStop(id)
            resolve({ ...result, tools, text: texts.join('\n') })
          }
          const offEvent = window.cove.onAgentEvent(id, (event) => {
            for (const part of event.message?.content ?? []) {
              if (part.type === 'tool_use') tools.push({ name: part.name, input: part.input })
              if (event.type === 'assistant' && part.type === 'text') texts.push(part.text)
            }
            if (event.type === 'result') {
              if (typeof event.result === 'string') texts.push(event.result)
              finish({ error: !!event.is_error })
            }
          })
          const offExit = window.cove.onAgentExit(id, (code) => finish({ exit: code }))
          const timer = setTimeout(() => finish({ timeout: true }), 180000)
          window.cove.agentSend(id, prompt)
        })
      },
      { provider, prompt, cwd: dir }
    )
    // Only retain this test's empty-result conversation; no real email bodies are requested.
    writeFileSync(join(dir, `${provider}-${connected}.json`), JSON.stringify(outcome), {
      mode: 0o600
    })
    console.log(
      provider,
      connected ? 'connected' : 'disconnected',
      JSON.stringify({
        tools: outcome.tools.map((t) => t.name),
        text: outcome.text.slice(-500),
        error: outcome.error,
        timeout: outcome.timeout,
        exit: outcome.exit
      })
    )
    assert.ok(
      !outcome.timeout && !outcome.error && outcome.exit === undefined,
      `${provider} turn did not finish successfully`
    )
    assert.ok(
      outcome.text.includes(`CONNECTION:${connected ? 'connected' : 'disconnected'}`),
      `${provider} connection awareness`
    )
    if (connected) {
      assert.ok(
        outcome.tools.some(
          (t) => /mail_search/.test(t.name) || JSON.stringify(t.input).includes('mail_search')
        ),
        `${provider} must actually call the Mail search tool`
      )
      assert.ok(/MATCHES:\s*0/.test(outcome.text), `${provider} should return zero matches`)
    } else assert.equal(outcome.tools.length, 0)
    results.push({ provider, connected, passed: true })
  }
  const providers = (process.env.MAIL_TEST_PROVIDERS || 'claude,codex,antigravity').split(',')
  if (process.env.MAIL_TEST_DISCONNECTED_ONLY !== '1')
    for (const provider of providers) await run(provider, true)
  await page.evaluate(() => window.cove.mailDisconnect())
  for (const provider of providers) await run(provider, false)
} finally {
  writeFileSync('/tmp/superagent-mail-agents-report.json', JSON.stringify(results, null, 2))
  await app.close()
  rmSync(dir, { recursive: true, force: true })
}
