import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A conversation's transcript moved out of the `chats` row into a table of its
 * own: in the row it made every chat listing read megabytes. An install from
 * before keeps its conversations — moved once at start, shown as they were,
 * and saved to the new place from then on.
 */
test('a transcript saved the old way is moved, still shown, and still saved', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-move-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-move-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const db = join(data, 'cove.db')
  const sql = (q: string): string => execFileSync('sqlite3', [db, q]).toString().trim()
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
  try {
    // An install as it was: a chat whose transcript is in its row.
    let app = await launch()
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async () => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await app.close()
    const items = [
      { kind: 'msg', msg: { id: 'u1', role: 'user', text: 'why is the header broken?', at: 1 } },
      { kind: 'msg', msg: { id: 'a1', role: 'assistant', text: 'The nav wraps below 400 points.', at: 2 } }
    ]
    const chatId = sql('SELECT id FROM chats LIMIT 1')
    sql(`UPDATE chats SET data = '${JSON.stringify(items).replace(/'/g, "''")}' WHERE id = '${chatId}'`)
    sql("DELETE FROM kv WHERE key = 'migrated.chat_data'")
    sql('DELETE FROM chat_data')

    // Started again: moved, and shown as it was.
    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    await expect(page.locator('.easy-msg.easy-assistant:visible').last()).toContainText(
      'The nav wraps below 400 points.'
    )
    await app.close()
    expect(sql(`SELECT length(data) FROM chats WHERE id = '${chatId}'`)).toBe('0')
    expect(sql(`SELECT data FROM chat_data WHERE id = '${chatId}'`)).toContain('The nav wraps')

    // And saved to the new place from then on.
    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.evaluate(async (id) => {
      const saved = JSON.parse((await window.cove.chatLoad(id)) ?? '[]') as unknown[]
      saved.push({ kind: 'msg', msg: { id: 'u2', role: 'user', text: 'and the footer?', at: 3 } })
      window.cove.chatSave(id, JSON.stringify(saved))
    }, chatId)
    await expect
      .poll(() => sql(`SELECT data FROM chat_data WHERE id = '${chatId}'`))
      .toContain('and the footer?')
    expect(sql(`SELECT length(data) FROM chats WHERE id = '${chatId}'`)).toBe('0')
    await app.close()
  } finally {
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
