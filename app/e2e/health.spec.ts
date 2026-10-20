import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The health trail is only worth having if it is really written by the app as
 * shipped: the metrics call, the process list and the swap reading all run in
 * the real main process here, not in a unit test's mock.
 */
test('the app leaves a line about the Mac in memory.log soon after starting', async () => {
  test.setTimeout(90_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-health-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-health-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    await app.firstWindow()
    const log = join(data, 'memory.log')
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 60_000 })
      .toMatch(/ sys free=/)
    const line = readFileSync(log, 'utf8')
      .split('\n')
      .find((l) => l.includes(' sys free='))!
    // The machine: memory, swap, load over core count.
    expect(line).toMatch(/ sys free=[\d.]+G\/[\d.]+G swap=[\d.]+G load=[\d.]+\/\d+ /)
    // Our own processes by kind, from the real metrics call.
    expect(line).toMatch(/electron\[.*browser=1×\d+M\/\d+%.*\]/)
    expect(line).toMatch(/renderer=\d+×\d+M/)
    // What the agents spawned (nothing yet), and the heaviest processes on the Mac.
    expect(line).toMatch(/ spawned=0×0M /)
    // Names may have spaces ("Brave Browser"); each entry ends in size/cpu.
    expect(line).toMatch(/top\[(.+?:\d+M\/\d+% ){3,}.+?:\d+M\/\d+%\]$/)
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
