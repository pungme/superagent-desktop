import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Antigravity's sub-agents: its stream says only that one was dispatched, with the
 * transcript it writes. Superagent follows that transcript, so the pill shows in
 * "Running in background", its panel shows what it is doing, and it goes when the
 * sub-agent is done. The stand-in `agy` sends the step_updates agy 1.2.16 really
 * sends and writes a real sub-agent transcript (src/main/__fixtures__) a line at a time.
 */
const FIXTURE = join(
  __dirname,
  '..',
  'src',
  'main',
  '__fixtures__',
  'agy-subagent-transcript.jsonl'
)

const FAKE = `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
if (args[0] === 'models') { console.log('gemini-4-neon-high\\tGemini 4 Neon (High)'); process.exit(0) }
if (args[0] !== '--input-format') process.exit(1)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const conv = '75de2168-1552-47a6-b910-a4b56b6717f7'
const step = (su) => out({ event: 'step_update', step_update: { conversation_id: conv, ...su } })
out({ event: 'init', conversation_id: conv, init: { cwd: process.cwd(), model: 'gemini-4-neon-high', tools: [] } })
const log = process.env.FAKE_TRANSCRIPT
const lines = fs.readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\\n').filter(Boolean)
let buf = ''
let started = false
process.stdin.on('data', (c) => {
  buf += c
  if (started || !buf.includes('\\n')) return
  started = true
  const sub = { type_name: 'research', role: 'Workspace File Researcher', initial_prompt: 'List the files and read a.txt' }
  step({ step_index: 0, state: 'DONE', step_type: 'user_input' })
  step({ step_index: 2, state: 'ACTIVE', step_type: 'subagent', tool_name: 'invoke_subagent', subagent_info: { subagents: [sub] } })
  step({ step_index: 2, state: 'DONE', step_type: 'subagent', tool_name: 'invoke_subagent', subagent_info: { subagents: [{ ...sub,
    conversation_id: '32ed3058-9590-4919-96ad-0e9146597e09', log_uri: 'file://' + log }] } })
  step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Started the research subagent. Waiting for its reply.' })
  // The sub-agent works: its transcript grows a line every 700 ms, the last one
  // only when the test says so.
  fs.mkdirSync(path.dirname(log), { recursive: true })
  let n = 0
  const tick = setInterval(() => {
    if (n === lines.length - 1 && !fs.existsSync(process.env.FAKE_GO)) return
    fs.appendFileSync(log, lines[n] + '\\n')
    n++
    if (n < lines.length) return
    clearInterval(tick)
    step({ step_index: 4, state: 'DONE', step_type: 'system_message' })
    step({ step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'a.txt says hello.' })
    out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'a.txt says hello.' } })
  }, 700)
})
`

test('an Antigravity sub-agent shows in Running in background, with what it is doing, until it is done', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-agysub-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-agysub-proj-'))
  const fake = mkdtempSync(join(tmpdir(), 'cove-agysub-cli-'))
  const transcript = join(fake, 'brain', '32ed3058', 'transcript.jsonl')
  const go = join(fake, 'go')
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
      FAKE_TRANSCRIPT: transcript,
      FAKE_FIXTURE: FIXTURE,
      FAKE_GO: go,
      NODE_ENV: 'production'
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async () => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      const id = await window.cove.chatCreate(ws.id)
      await window.cove.chatUpdate(id, { provider: 'antigravity', claudeSessionId: null })
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    const input = page.locator('textarea.easy-input:visible')
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill('have a research subagent read a.txt')
    await input.press('Enter')

    // The pill, named after its role.
    const pill = page.getByTestId('subagent-pill')
    await expect(pill).toBeVisible({ timeout: 20_000 })
    await expect(pill).toContainText('Workspace File Researcher')

    // Its steps come through as it writes them.
    await pill.click()
    const menu = page.getByTestId('subagent-menu')
    await expect(menu).toBeVisible()
    await expect(
      menu.locator('.easy-agent-step', { hasText: 'ls -la /tmp/agy-probe' })
    ).toBeVisible({
      timeout: 15_000
    })
    await expect(menu.locator('.easy-agent-step.ok', { hasText: 'a.txt' })).toHaveCount(1, {
      timeout: 15_000
    })
    await expect(page.getByTestId('subagent-progress')).toContainText('steps', { timeout: 15_000 })
    if (process.env.SHOT)
      await page.screenshot({ path: join(process.env.SHOT, 'agy-subagent.png') })

    // Still there until it is done; then gone.
    await expect(pill).toBeVisible()
    writeFileSync(go, '1')
    expect(existsSync(go)).toBe(true)
    await expect(pill).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.easy-msg', { hasText: 'a.txt says hello' }).first()).toBeVisible({
      timeout: 15_000
    })
    expect(readFileSync(transcript, 'utf8').split('\n').filter(Boolean)).toHaveLength(7)
  } finally {
    await app.close()
    for (const d of [data, proj, fake]) rmSync(d, { recursive: true, force: true })
  }
})
