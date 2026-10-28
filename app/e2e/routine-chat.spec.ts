import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A routine an agent set up shows under the conversation that set it up, not
 * loose under the project. Routines made before that was recorded are matched
 * to their chat from its event log when the app starts.
 */
test('a routine shows under the chat that created it', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-routine-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-routine-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const db = join(data, 'cove.db')
  const sql = (q: string): string => execFileSync('sqlite3', [db, q]).toString().trim()
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
  const prompt = 'Monitor two prod releases, read-only, and say when either finishes'
  try {
    let app = await launch()
    let page = await app.firstWindow()
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const ws = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const w = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      for (const t of ['First chat', 'Release watcher']) {
        const id = await window.cove.chatCreate(w.id)
        await window.cove.chatUpdate(id, { title: t })
      }
      return w.id
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    // The chat that has a row of its own in the project's tree.
    const row = page
      .locator('.sidebar-item:has-text("e2e-project") ~ .routine-tree [data-split-chat]')
      .first()
    await expect(row).toBeVisible({ timeout: 10_000 })
    const chatId = (await row.getAttribute('data-split-chat'))!
    await app.close()

    // Its agent called create_routine, before routines recorded their chat.
    const detail = JSON.stringify({
      kind: 'tool',
      id: 't1',
      name: 'mcp__cove-browser__create_routine',
      detail: prompt.slice(0, 50)
    })
    sql(
      `INSERT INTO chat_events (chatId, seq, ts, kind, data) VALUES ('${chatId}', 9001, 1, 'tool', '${detail.replace(/'/g, "''")}')`
    )
    sql(
      `INSERT INTO routines (id, workspaceId, workspacePath, prompt, intervalMs, enabled, nextRunAt) VALUES ('r1', '${ws}', '${proj}', '${prompt}', 3600000, 0, ${Date.now() + 3_600_000})`
    )

    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const under = page.locator('.chat-routines .routine-tree-row', { hasText: 'Monitor two prod' })
    await expect(under).toHaveCount(1, { timeout: 10_000 })
    // Right after its chat's row, and not repeated loose under the project.
    const prevChat = await under.evaluate((el) => {
      const prev = el.closest('.chat-routines')?.previousElementSibling as HTMLElement | null
      return (
        prev?.getAttribute('data-split-chat') ??
        prev?.querySelector('[data-split-chat]')?.getAttribute('data-split-chat')
      )
    })
    expect(prevChat).toBe(chatId)
    await expect(page.locator('.routine-tree-row', { hasText: 'Monitor two prod' })).toHaveCount(1)
    expect(sql("SELECT chatId FROM routines WHERE id = 'r1'")).toBe(chatId)
    await app.close()
  } finally {
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
