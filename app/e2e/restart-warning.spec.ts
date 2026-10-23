import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Restarting to update while work is running: the warning says what would be
 * stopped, chat by chat, not only how many things.
 */
test('the restart warning names what is running', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-rw-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-rw-proj-'))
  const other = mkdtempSync(join(tmpdir(), 'lab-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  writeFileSync(join(other, 'README.md'), '# other\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const w = await app.firstWindow()
    await w.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
    })
    await w.reload()
    await w.waitForSelector('.sidebar', { timeout: 20_000 })
    // A chat in a project that is never opened here, so nothing draws it: a
    // chat with a view of its own reports its real, idle state over ours.
    const chatId = await w.evaluate(async (path) => {
      const tree = await window.cove.storeTree()
      const group = tree.find((g) => g.workspaces.some((x) => x.name === 'e2e-project'))!
      const { workspaceId } = await window.cove.createWorkspace(group.id, 'lab', path)
      const id = await window.cove.chatCreate(workspaceId)
      await window.cove.chatUpdate(id, { title: 'Lab helper' })
      return id
    }, other)
    await w.reload()
    await w.waitForSelector('.sidebar', { timeout: 20_000 })
    await w.waitForTimeout(1000)
    await w.evaluate((id) => {
      type Store = { getState: () => { setBusy: (id: string, s: unknown) => void } }
      ;(window as unknown as { __store: Store }).__store.getState().setBusy(id, {
        generating: true,
        // What the agent is at, as the chat's own view reports it.
        doing: 'Editing · src/server.ts',
        background: 1,
        what: ['Run the lab helper server on port 4010']
      })
    }, chatId)
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:ready', '9.9.9')
    })
    await w.getByRole('button', { name: 'Restart to update' }).click()

    const warn = w.locator('.update-banner-warn')
    await expect(warn).toContainText('Restarting stops them')
    // The warning counts as an overlay: the native browser pane, which paints
    // above all HTML, gets out of its way (it sat behind a PDF before).
    const overlays = (): Promise<number> =>
      w.evaluate(
        () =>
          (
            window as unknown as { __store: { getState: () => { overlayCount: number } } }
          ).__store.getState().overlayCount
      )
    expect(await overlays()).toBeGreaterThan(0)
    const rows = warn.locator('.update-banner-running li')
    await expect(rows).toHaveCount(1)
    // Which chat, in which project, and what it is doing.
    await expect(rows.first().locator('.update-banner-running-chat')).toHaveText('lab · Lab helper')
    // Its real step, not "the agent is replying".
    await expect(rows.first()).toContainText('Editing · src/server.ts')
    await expect(rows.first()).not.toContainText('The agent is replying')
    await expect(rows.first()).toContainText('Run the lab helper server on port 4010')
    if (process.env.SHOT) await warn.screenshot({ path: '/tmp/sa-restart-warn.png' })
    // A row opens its conversation, and the question steps back to the pill.
    await rows.first().click()
    await expect
      .poll(() =>
        w.evaluate(
          (id) =>
            Object.values(
              (
                window as unknown as {
                  __store: { getState: () => { activeChatId: Record<string, string> } }
                }
              ).__store.getState().activeChatId
            ).includes(id),
          chatId
        )
      )
      .toBe(true)
    await expect(w.locator('.update-banner-warn')).toHaveCount(0)
    await expect.poll(overlays).toBe(0)
    // Opened, the chat's own view reports its real, idle state over the one
    // put in above; put it back so the question comes up again.
    await w.waitForTimeout(500)
    await w.evaluate((id) => {
      type Store = { getState: () => { setBusy: (id: string, s: unknown) => void } }
      ;(window as unknown as { __store: Store }).__store.getState().setBusy(id, {
        generating: true,
        background: 1,
        what: ['Run the lab helper server on port 4010']
      })
    }, chatId)
    await w.getByRole('button', { name: 'Restart to update' }).click()
    await expect(warn).toContainText('Restarting stops them')
    // Waiting for the work to finish is a small chip, not a bar over the
    // header: it can sit there for an hour.
    await warn.getByRole('button', { name: 'Restart when finished' }).click()
    const chip = w.locator('.update-waiting')
    await expect(chip).toContainText('Update after 2 tasks')
    await expect(chip).toHaveAttribute('title', /Waiting for 1 active chat and 1 background task/)
    const box = (await chip.boundingBox())!
    expect(box.height).toBeLessThanOrEqual(24)
    expect(box.width).toBeLessThan(200)
    if (process.env.SHOT) await w.screenshot({ path: '/tmp/sa-restart-chip.png' })
    await chip.getByRole('button', { name: 'Cancel automatic restart' }).click()
    await expect(chip).toHaveCount(0)
    await w.getByRole('button', { name: 'Restart to update' }).click()
    await expect(warn).toContainText('Restarting stops them')
    // Keep working leaves everything running.
    await warn.getByRole('button', { name: 'Keep working' }).click()
    await expect(w.locator('.update-banner')).toHaveCount(0)
    // And gives the pane back.
    await expect.poll(overlays).toBe(0)
  } finally {
    await app.close()
    for (const d of [data, proj, other]) rmSync(d, { recursive: true, force: true })
  }
})
