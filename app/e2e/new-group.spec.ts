import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * New group asks for a name first, and the group it makes goes to the top:
 * above the groups already there, and above the ungrouped projects.
 */
test('New group asks for a name and puts the group first', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-grp-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-grp-p-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const w = await app.firstWindow()
    await w.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await w.reload()
    await w.waitForSelector('.sidebar', { timeout: 20_000 })

    const make = async (name: string): Promise<void> => {
      await w.click('.group-add[title="New group"]')
      const dialog = w.getByRole('dialog', { name: 'New group' })
      await expect(dialog).toBeVisible()
      // Nothing is made until it has a name.
      await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
      await dialog.getByPlaceholder('Group name').fill(name)
      await dialog.getByPlaceholder('Group name').press('Enter')
      await expect(dialog).toBeHidden()
    }
    await make('Clients')
    await make('Side projects')

    const titles = w.locator('.sidebar-group-title')
    await expect(titles).toHaveText(['Chats', 'Projects', 'Side projects', 'Clients'])
    // And above the project that sits in no group.
    const group = await w
      .locator('.sidebar-group-title', { hasText: 'Side projects' })
      .boundingBox()
    const loose = await w.locator('.sidebar-loose').boundingBox()
    expect(group!.y).toBeLessThan(loose!.y)

    // Cancel and Escape make nothing.
    await w.click('.group-add[title="New group"]')
    await w.getByPlaceholder('Group name').fill('Nope')
    await w.getByPlaceholder('Group name').press('Escape')
    await expect(w.getByRole('dialog', { name: 'New group' })).toBeHidden()
    await expect(titles).toHaveCount(4)
    if (process.env.SHOT) {
      await w.click('.group-add[title="New group"]')
      await w.getByPlaceholder('Group name').fill('Wepush')
      await w.waitForTimeout(600)
      await w.screenshot({ path: '/tmp/sa-newgroup.png' })
    }
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
