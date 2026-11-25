import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Incognito chats: marked in the sidebar and in the chat, deleted by hand or
 * when Superagent quits, and the agent's own log of the session goes with them.
 * HOME is a temp folder, so the "agent log" is a file we made.
 */
test('an incognito chat is marked, and is gone with the session and its agent log', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-incog-data-'))
  const home = mkdtempSync(join(tmpdir(), 'cove-incog-home-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-incog-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const db = join(data, 'cove.db')
  const sql = (q: string): string => execFileSync('sqlite3', [db, q]).toString().trim()
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        HOME: home,
        COVE_USER_DATA: data,
        COVE_E2E_PROJECT: proj,
        NODE_ENV: 'production'
      }
    })
  const SESSION = '2b018f43-92ee-45df-bdbd-44964af72390'
  const log = join(home, '.claude', 'projects', '-tmp-proj', `${SESSION}.jsonl`)
  mkdirSync(join(log, '..'), { recursive: true })
  try {
    let app = await launch()
    let page = await app.firstWindow()
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })

    // Made from the Chats header.
    await page.getByTestId('new-incognito-chat').click()
    const row = page.locator('.sidebar-chat-row.incognito')
    await expect(row).toHaveCount(1, { timeout: 10_000 })
    await expect(row).toContainText('Incognito chat')
    await expect(row.locator('.incognito-glyph')).toBeVisible()
    await expect(page.getByTestId('incognito-notice')).toContainText('never shows on your phone')
    expect(sql('SELECT COUNT(*) FROM chats WHERE incognito = 1')).toBe('1')
    // An ordinary chat is not marked.
    expect(sql('SELECT COUNT(*) FROM chats WHERE incognito = 0 AND title IS NOT NULL')).toBe('0')

    // Delete now: the chat is gone.
    await page.getByTestId('incognito-notice').getByRole('button', { name: 'Delete now' }).click()
    await expect(page.locator('.sidebar-chat-row.incognito')).toHaveCount(0, { timeout: 10_000 })
    expect(sql('SELECT COUNT(*) FROM chats WHERE incognito = 1')).toBe('0')

    // Another one, with an agent session on disk, left for the app to end.
    await page.getByTestId('new-incognito-chat').click()
    await expect(page.locator('.sidebar-chat-row.incognito')).toHaveCount(1, { timeout: 10_000 })
    const id = sql('SELECT id FROM chats WHERE incognito = 1')
    sql(`UPDATE chats SET claudeSessionId = '${SESSION}', provider = 'claude' WHERE id = '${id}'`)
    writeFileSync(log, '{"type":"user"}\n')
    expect(existsSync(log)).toBe(true)
    await app.close()

    // Quitting deleted it and the agent's log of it.
    expect(sql('SELECT COUNT(*) FROM chats WHERE incognito = 1')).toBe('0')
    expect(existsSync(log)).toBe(false)

    // A crash leaves a chat behind: the next start sweeps it too.
    writeFileSync(log, '{"type":"user"}\n')
    sql(
      `INSERT INTO chats (id, workspaceId, title, claudeSessionId, position, updatedAt, data, provider, incognito)
       SELECT 'left-over', id, 'Incognito chat', '${SESSION}', 99, 1, '[]', 'claude', 1 FROM workspaces LIMIT 1`
    )
    expect(sql('SELECT COUNT(*) FROM chats WHERE incognito = 1')).toBe('1')
    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect(page.locator('.sidebar-chat-row.incognito')).toHaveCount(0)
    expect(sql('SELECT COUNT(*) FROM chats WHERE incognito = 1')).toBe('0')
    expect(existsSync(log)).toBe(false)
    await app.close()
  } finally {
    rmSync(data, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
