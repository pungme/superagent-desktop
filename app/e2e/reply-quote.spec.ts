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
 * A reply that answers one message in particular shows that message quoted
 * above it, the way a messaging app shows a reply.
 */
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-reply-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-reply-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

test('the agent answering an earlier message shows it quoted above the answer', async () => {
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  // A saved conversation: two messages from the user, then a reply to each.
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
    const chatId = await window.cove.chatCreate(wsId)
    const msg = (id: string, role: string, text: string): unknown => ({
      kind: 'msg',
      msg: { id, role, text }
    })
    window.cove.chatSave(
      chatId,
      JSON.stringify([
        msg('u1', 'user', 'make the header sticky'),
        msg('u2', 'user', 'also why is the build so slow?'),
        msg(
          'a1',
          'assistant',
          '> also why is the build so slow?\n\nIt rebuilds the image every time.'
        ),
        msg('a2', 'assistant', '> make the header sticky\n\nDone, it stays put now.'),
        msg('a3', 'assistant', '> error: ENOENT\n\nThat line is the cause.'),
        msg('a4', 'assistant', 'A plain answer to the last thing said.')
      ])
    )
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')

  const replies = window.locator('.easy-assistant:visible')
  await expect(replies).toHaveCount(4, { timeout: 15_000 })
  // Each answer carries the message it answers, and no longer repeats it as a quote.
  const first = replies.nth(0)
  await expect(first.locator('.easy-reply-quote-who')).toHaveText('You')
  await expect(first.locator('.easy-reply-quote-text')).toHaveText('also why is the build so slow?')
  await expect(first.locator('blockquote')).toHaveCount(0)
  await expect(first).toContainText('It rebuilds the image every time.')
  await expect(replies.nth(1).locator('.easy-reply-quote-text')).toHaveText(
    'make the header sticky'
  )
  // A quote of something the user never said stays an ordinary quote.
  await expect(replies.nth(2).locator('.easy-reply-quote')).toHaveCount(0)
  await expect(replies.nth(2).locator('blockquote')).toContainText('error: ENOENT')
  await expect(replies.nth(3).locator('.easy-reply-quote')).toHaveCount(0)
  await window.screenshot({ path: '/tmp/reply-quote.png' })
})
