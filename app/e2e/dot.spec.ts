import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The dot: Superagent as a tile in the corner of the screen, with a panel to
 * ask from. The agent is stood in for (a request would start a real one): the
 * chat's events are sent to the dot as main would send them, and what it shows
 * for each is checked.
 */
let app: ElectronApplication
let dot: Page
let main: Page
let data: string
let proj: string
const SHOT = process.env.SHOT ? (name: string): string => `/tmp/sa-dot-${name}.png` : null

async function shoot(name: string): Promise<void> {
  if (!SHOT) return
  // Past the entrance and colour transitions.
  await dot.waitForTimeout(500)
  await dot.screenshot({ path: SHOT(name)!, omitBackground: true })
}
/** A chat event, as main forwards it. */
const event = (data: Record<string, unknown>): Promise<void> =>
  app.evaluate(
    ({ BrowserWindow }, p) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('dot:event', p)
    },
    { chatId: 'chat-1', data }
  )

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-dot-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-dot-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_DOT: '1',
      NODE_ENV: 'production'
    }
  })
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  const pages = app.windows()
  dot = pages.find((p) => p.url().endsWith('#dot'))!
  main = pages.find((p) => !p.url().endsWith('#dot'))!
  await dot.waitForSelector('.dot-tile', { timeout: 20_000 })
  // Requests are recorded, not sent to an agent.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { asked: unknown[]; answered: unknown[]; stopped: string[] }
    g.asked = []
    g.answered = []
    g.stopped = []
    ipcMain.removeHandler('dot:ask')
    ipcMain.handle('dot:ask', (_e, workspaceId: string, text: string) => {
      g.asked.push({ workspaceId, text })
      return { ok: true, chatId: 'chat-1', workspaceId }
    })
    ipcMain.removeHandler('dot:answer')
    ipcMain.handle('dot:answer', (_e, id: string, approve: boolean) => {
      g.answered.push({ id, approve })
      return true
    })
    ipcMain.removeHandler('dot:stop')
    ipcMain.handle('dot:stop', (_e, chatId: string) => {
      g.stopped.push(chatId)
      return true
    })
  })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) if (d) rmSync(d, { recursive: true, force: true })
})

test('it is a tile until asked, and the main window is still the app', async () => {
  await expect(dot.locator('.dot-tile')).toBeVisible()
  await expect(dot.locator('.dot-panel')).toHaveCount(0)
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-idle/)
  // The app's own window is untouched by there being a second one.
  await main.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await main.reload()
  await expect(main.locator('.sidebar')).toBeVisible({ timeout: 20_000 })
  await expect(main.locator('.dot-tile')).toHaveCount(0)
  await shoot('1-idle')
})

test('a click opens the panel on the Computer, with things to ask', async () => {
  await dot.locator('.dot-tile').click()
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.dot-chip-name')).toHaveText('Computer')
  await expect(panel.locator('.dot-input')).toBeFocused()
  await expect(panel.locator('.dot-suggestion').first()).toBeVisible()
  await expect(panel).toContainText('Tidy my Downloads folder')
  await shoot('2-ask')
})

test('the project can be picked by name, and is where the request goes', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await panel.locator('.dot-chip').click()
  const list = dot.getByRole('listbox', { name: 'Projects' })
  await expect(list.locator('.dot-item').first()).toContainText('Computer')
  await expect(list).toContainText('e2e-project')
  await shoot('3-projects')
  // Typing narrows it; Enter takes the first match.
  await list.locator('.dot-find').fill('e2e')
  await expect(list.locator('.dot-item')).toHaveCount(1)
  await list.locator('.dot-find').press('Enter')
  await expect(panel.locator('.dot-chip-name')).toHaveText('e2e-project')
  // A project gets questions about a project, not about the Mac.
  await expect(panel).toContainText('What changed here this week?')
  await expect(panel).not.toContainText('Tidy my Downloads folder')

  await panel.locator('.dot-input').fill('Why is the deploy failing?')
  await panel.locator('.dot-input').press('Enter')
  const asked = await app.evaluate(
    () => (globalThis as unknown as { asked: { workspaceId: string; text: string }[] }).asked
  )
  expect(asked).toHaveLength(1)
  expect(asked[0].text).toBe('Why is the deploy failing?')
  expect(asked[0].workspaceId).not.toBe('__desktop_chat__')
  await expect(panel.locator('.dot-you')).toHaveText('Why is the deploy failing?')
  await expect(panel.locator('.dot-input')).toHaveValue('')
})

test('while it works it shows the steps, and can be stopped', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-working/)
  await expect(panel.locator('.dot-step.now')).toHaveText('Starting…')
  await event({ kind: 'tool', id: 't1', name: 'Bash', detail: 'gh run list --limit 3' })
  await event({
    kind: 'tool',
    id: 't2',
    name: 'Read',
    detail: '/repo/.github/workflows/deploy.yml'
  })
  await expect(panel.locator('.dot-step')).toHaveText([
    'Running a command · gh run list --limit 3',
    'Reading · deploy.yml'
  ])
  await expect(panel.locator('.dot-step.now')).toHaveText('Reading · deploy.yml')
  await shoot('4-working')
  await panel.getByRole('button', { name: 'Stop' }).click()
  expect(
    await app.evaluate(() => (globalThis as unknown as { stopped: string[] }).stopped)
  ).toEqual(['chat-1'])
})

test('it goes amber and asks before anything risky, and passes the answer on', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await event({
    kind: 'approval',
    id: 'gate-1',
    toolName: 'mcp__cove-browser__mail_send',
    preview: 'Send email to caspar@example.com\nSubject: Deploy is fixed',
    approvalKind: 'permission',
    expiresAt: Date.now() + 60_000
  })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-needs/)
  await expect(panel.locator('.dot-approval')).toContainText('caspar@example.com')
  await shoot('5-needs-you')
  await panel.getByRole('button', { name: 'Allow' }).click()
  expect(
    await app.evaluate(() => (globalThis as unknown as { answered: unknown[] }).answered)
  ).toEqual([{ id: 'gate-1', approve: true }])
  await event({ kind: 'approval_end', id: 'gate-1', outcome: 'approved', by: 'desktop' })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-working/)
})

test('the answer lands by the dot, with a way to the whole conversation', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await event({
    kind: 'assistant',
    id: 'a1',
    text: 'The **migration step** fails: `users.email` already exists on dev.'
  })
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
  await expect(panel.locator('.dot-answer')).toContainText('migration step')
  await expect(panel.locator('.dot-answer strong')).toHaveText('migration step')
  await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible()
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-idle/)
  await shoot('6-done')
  // Escape closes it; the tile stays.
  await panel.locator('.dot-input').press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(dot.locator('.dot-tile')).toBeVisible()
})

test('an answer that arrives while it is closed shows on the tile until looked at', async () => {
  await dot.locator('.dot-tile').click()
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await panel.getByRole('button', { name: 'Clear' }).click()
  await panel.locator('.dot-input').fill('And the staging one?')
  await panel.locator('.dot-input').press('Enter')
  await panel.locator('.dot-input').press('Escape')
  await expect(panel).toHaveCount(0)
  // Working, closed: the tile says whose work it is.
  await expect(dot.locator('.dot-tag')).toContainText('e2e-project')
  await event({ kind: 'assistant', id: 'a2', text: 'Staging is healthy.' })
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-done/)
  await expect(dot.locator('.dot-badge')).toHaveText('1')
  await expect(dot.locator('.dot-tag')).toHaveCount(0)
  await shoot('7-unseen')
  await dot.locator('.dot-tile').click()
  await expect(dot.locator('.dot-badge')).toHaveCount(0)
  await expect(panel.locator('.dot-answer')).toContainText('Staging is healthy.')
})

test('it can be turned off in Settings, and back on', async () => {
  await main.click('.sidebar-settings[title="Settings"]')
  const row = main.locator('.settings-row', { hasText: 'Show Superagent as a floating dot' })
  await expect(row.locator('input[type="checkbox"]')).toBeChecked()
  await row.locator('.switch').click()
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked()
  await expect.poll(() => app.windows().length).toBe(1)
  await row.locator('.switch').click()
  await expect(row.locator('input[type="checkbox"]')).toBeChecked()
  await expect.poll(() => app.windows().length).toBe(2)
})
