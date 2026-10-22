import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 2026-10-22: split view did nothing on the owner's Mac. Their sidebar is
 * mostly Pinned, and only the project tree's rows were wired: ⌘-click and drag
 * on a Pinned or Activity row did nothing at all. Every kind of row now opens
 * beside, and the project header always shows the project's icon.
 */
const desks = (w: Page): Locator =>
  w.locator('.workspace-host.in-split > .workspace-view.in-tile:visible')
const desk = (w: Page, id: string): Locator => w.locator(`.workspace-view[data-desk="${id}"]`)

test('split view opens from Pinned and Activity rows too', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-split-pin-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-split-pinp-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
  let app = await launch()
  try {
    let window = await app.firstWindow()
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
    })
    const ids = await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const a = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const make = async (title: string): Promise<string> => {
        const id = await window.cove.chatCreate(a)
        await window.cove.chatUpdate(id, { title })
        return id
      }
      return {
        a,
        one: await make('First chat'),
        two: await make('Pinned chat'),
        three: await make('Third chat'),
        four: await make('Fourth chat')
      }
    })
    // Pinning is the chat menu's, which is native; this is what it writes.
    for (const id of [ids.two, ids.three])
      execFileSync('sqlite3', [
        join(data, 'cove.db'),
        `UPDATE chats SET pinned = 1, pinnedAt = ${Date.now()} WHERE id = '${id}'`
      ])
    await app.close()
    app = await launch()
    window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    // Open the first chat from the project tree.
    await window.locator(`.sidebar [data-chat-id="${ids.one}"]`).first().click()
    await expect(desk(window, ids.one)).toBeVisible()
    // The header shows the project's icon, split or not.
    await expect(
      desk(window, ids.one).locator('.workspace-toolbar .tile-project-icon')
    ).toBeVisible()

    // ⌘-click the PINNED row: it opens beside.
    const pinnedRow = window
      .locator('.sidebar-pinned-shortcuts .activity-row', { hasText: 'Pinned chat' })
      .first()
    await pinnedRow.click({ modifiers: ['Meta'] })
    await expect(desks(window)).toHaveCount(2)
    await expect(desk(window, ids.two)).toBeVisible()

    // Drag the other PINNED row out onto the window.
    const from = await window
      .locator('.sidebar-pinned-shortcuts .activity-row', { hasText: 'Third chat' })
      .first()
      .boundingBox()
    const target = await desk(window, ids.two).boundingBox()
    await window.mouse.move(from!.x + 30, from!.y + from!.height / 2)
    await window.mouse.down()
    await window.mouse.move(from!.x + 60, from!.y + from!.height / 2, { steps: 4 })
    await window.mouse.move(target!.x + target!.width * 0.9, target!.y + target!.height / 2, {
      steps: 12
    })
    await expect(window.locator('.split-ghost.new')).toBeVisible()
    await window.mouse.up()
    await expect(desks(window)).toHaveCount(3)
    await expect(desk(window, ids.three)).toBeVisible()

    // Activity rows carry the same marker, so ⌘/⌥-click and drag work there too.
    await window.getByRole('tab', { name: 'Activity' }).click()
    const activity = window.locator('.activity-row[data-split-chat]')
    await expect(activity.first()).toBeVisible()
    await activity.filter({ hasNotText: 'Pinned chat' }).first().click({ modifiers: ['Alt'] })
    await expect(desks(window)).not.toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
