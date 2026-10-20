import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The project's header names the conversation on screen, not only the project. */
test('the header names the project and the conversation on screen', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-crumb-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-crumb-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const a = await window.cove.chatCreate(wsId)
      await window.cove.chatUpdate(a, { title: 'Fix the onboarding flow for Codex sign-in' })
      const b = await window.cove.chatCreate(wsId)
      await window.cove.chatUpdate(b, { title: 'Image viewer arrows' })
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.click('.sidebar-item:has-text("e2e-project")')
    const bar = window.locator('.workspace-toolbar:visible')
    await expect(bar.locator('.workspace-title')).toHaveText('e2e-project')
    const name = bar.locator('.workspace-chat')
    await expect(name).toBeVisible()
    const first = await name.textContent()
    expect(['Fix the onboarding flow for Codex sign-in', 'Image viewer arrows']).toContain(first)
    if (process.env.SHOT) await bar.screenshot({ path: '/tmp/sa-toolbar-chat.png' })
    // Switching conversation changes the name with it.
    const other = first === 'Image viewer arrows' ? 'Fix the onboarding' : 'Image viewer arrows'
    await window.locator('.sidebar').getByText(other).first().click()
    await expect(name).toContainText(other)
    if (process.env.SHOT) await bar.screenshot({ path: '/tmp/sa-toolbar-chat-2.png' })
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
