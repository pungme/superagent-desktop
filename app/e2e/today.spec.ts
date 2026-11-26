import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Today, where Computer was: the day's calendar, every project's open to-dos,
 * and the agents, one row at the top of the sidebar.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

const pad = (n: number): string => String(n).padStart(2, '0')
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-e2e-today-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-e2e-today-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
})

test('Today replaces Computer at the top of the sidebar', async () => {
  const rows = window.locator('.sidebar-dash-row')
  await expect(rows.first()).toContainText('Today')
  await expect(window.locator('.sidebar-dash-row', { hasText: 'Computer' })).toHaveCount(0)
})

test("it shows today's events, every project's open to-dos, and can tick one off", async () => {
  const day = today()
  await window.evaluate(
    async ({ day }) => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      await window.cove.calendarAdd({
        title: 'Dashboard review',
        start: `${day}T15:00`,
        end: `${day}T15:45`,
        allDay: false,
        notes: 'Google Meet',
        color: null
      })
      await window.cove.calendarAdd({
        title: 'Festival jury call',
        start: `${day}T23:00`,
        end: `${day}T23:50`,
        allDay: false,
        notes: '',
        color: '#c084fc'
      })
      await window.cove.boardAdd(ws.id, 'Fix the header below 400px')
      await window.cove.boardAdd(ws.id, 'Reply to Helloprint')
    },
    { day }
  )
  await window.locator('.sidebar-dash-row', { hasText: 'Today' }).click()
  const view = window.locator('.today')
  await expect(view.locator('h1')).toHaveText('Today')
  const cal = view.locator('.today-col[aria-label="Calendar"]')
  await expect(cal).toContainText('Dashboard review')
  await expect(cal).toContainText('Festival jury call')
  const todo = view.locator('.today-col[aria-label="To-do"]')
  await expect(todo.locator('.today-td')).toHaveCount(2)
  await expect(todo).toContainText('e2e-project')
  await expect(todo.getByRole('button', { name: 'Hand to agent' })).toHaveCount(2)
  await expect(view.locator('.today-col[aria-label="Agents"]')).toContainText(
    'No agent is working right now.'
  )
  await window.screenshot({ path: 'test-results/today.png' })

  // Ticked off: done on its project's board, and gone from Today.
  await todo.getByRole('button', { name: 'Done: Reply to Helloprint' }).click()
  await expect(todo.locator('.today-td')).toHaveCount(1)

  // A new to-do goes to a project.
  await todo.getByLabel('New to-do').fill('Book the train to Berlin')
  await todo.getByLabel('New to-do').press('Enter')
  await expect(todo.locator('.today-td')).toHaveCount(2)
  await expect(todo).toContainText('Book the train to Berlin')

  // Deleted: gone from Today and from its project's board.
  window.once('dialog', (d) => void d.accept())
  await todo.locator('.today-td', { hasText: 'Book the train to Berlin' }).hover()
  await todo.getByRole('button', { name: 'Delete: Book the train to Berlin' }).click()
  await expect(todo.locator('.today-td')).toHaveCount(1)
  await expect(todo).not.toContainText('Book the train to Berlin')
})

test('the ask box waits for words', async () => {
  const ask = window.locator('.today-ask')
  await expect(ask.getByRole('button', { name: 'Send' })).toBeDisabled()
  await ask.getByLabel('Ask').fill("what's left today?")
  await expect(ask.getByRole('button', { name: 'Send' })).toBeEnabled()
})

test('a long to-do list shows the few that matter, with Show all for the rest', async () => {
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    for (let i = 0; i < 14; i++) await window.cove.boardAdd(ws.id, `Backlog item ${i}`)
  })
  await window.locator('.sidebar-dash-row', { hasText: 'Today' }).click()
  const todo = window.locator('.today-col[aria-label="To-do"]')
  await expect(todo.locator('.today-td')).toHaveCount(10)
  const more = todo.getByRole('button', { name: /^Show all/ })
  await expect(more).toBeVisible()
  await more.click()
  await expect(todo.locator('.today-td').first()).toBeVisible()
  expect(await todo.locator('.today-td').count()).toBeGreaterThan(10)
  await todo.getByRole('button', { name: 'Show fewer' }).click()
  await expect(todo.locator('.today-td')).toHaveCount(10)
})
