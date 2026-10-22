import {
  test,
  expect,
  _electron as electron,
  type Page,
  type ElectronApplication
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Split view, end to end, the way a person uses it: ⌘-click a chat to open it
 * beside, move between windows with the keys, leave the split by opening any
 * other chat and come back to it from the Splits row, two chats of one project
 * side by side, four at most, ⌘W, and the split surviving a restart. And the
 * one thing that must never happen: a chat remounting (its agent would stop)
 * because it moved on screen.
 */

const shots = process.env.SHOT ? (name: string): string => `/tmp/sa-split-${name}.png` : null

async function launch(
  data: string,
  proj: string
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  const window = await app.firstWindow()
  await window.setViewportSize({ width: 1440, height: 900 })
  return { app, window }
}

type Store = {
  getState: () => Record<string, (...args: unknown[]) => unknown> & {
    split: { tiles: { chat: string }[] }
  }
}
const desks = (w: Page): Locator =>
  w.locator('.workspace-host.in-split > .workspace-view.in-tile:visible')
const desk = (w: Page, chatId: string): Locator =>
  w.locator(`.workspace-view[data-desk="${chatId}"]`)
const focused = (w: Page): Locator => w.locator('.workspace-view.tile-focused')
const row = (w: Page, chatId: string): Locator =>
  w.locator(`.sidebar [data-chat-id="${chatId}"], .sidebar [data-root-chat-id="${chatId}"]`).first()
/** Windows glide to their places (0.2s); read them once they are there. */
const settled = (w: Page): Promise<void> => w.waitForTimeout(350)

test('split view: open beside, move between windows, leave and come back, restart', async () => {
  test.setTimeout(180_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-split-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-split-a-'))
  const projB = mkdtempSync(join(tmpdir(), 'cove-split-b-'))
  const projC = mkdtempSync(join(tmpdir(), 'cove-split-c-'))
  for (const p of [proj, projB, projC]) writeFileSync(join(p, 'README.md'), '# e2e\n')
  let { app, window } = await launch(data, proj)
  try {
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    const ids = await window.evaluate(
      async ({ projB, projC }) => {
        const tree = await window.cove.storeTree()
        const groupId = tree[0].id
        const a = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
        const b = (await window.cove.createWorkspace(groupId, 'portal', projB)).workspaceId
        const c = (await window.cove.createWorkspace(groupId, 'api', projC)).workspaceId
        const make = async (ws: string, title: string, said: string): Promise<string> => {
          const id = await window.cove.chatCreate(ws)
          await window.cove.chatUpdate(id, { title })
          window.cove.chatSave(
            id,
            JSON.stringify([
              { kind: 'msg', msg: { id: `u-${id}`, role: 'user', text: said } },
              { kind: 'msg', msg: { id: `a-${id}`, role: 'assistant', text: `Reply in ${title}.` } }
            ])
          )
          return id
        }
        return {
          a,
          b,
          c,
          a1: await make(a, 'Fix the header', 'The header collapses'),
          a2: await make(a, 'Pricing copy', 'Tighten pricing'),
          b1: await make(b, 'Onboarding copy', 'Plain words'),
          c1: await make(c, 'Rerun e2e', 'Rerun the suite'),
          c2: await make(c, 'Login flow', 'Check login')
        }
      },
      { projB, projC }
    )
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    // Start on chat a1, alone.
    await window.evaluate(({ a, a1 }) => {
      const st = (window as unknown as { __store: Store }).__store.getState()
      st.setActive(a)
      st.selectChat(a, a1)
    }, ids)
    await expect(desk(window, ids.a1).locator('.easy-assistant').first()).toContainText('Reply in')
    await expect(desks(window)).toHaveCount(0)

    // A draft in a1's composer: if a1 ever remounts, it is gone.
    const composerA1 = desk(window, ids.a1).locator('textarea').first()
    await composerA1.fill('a draft that must survive')

    // ⌘-click Onboarding copy in the sidebar: it opens beside, focused.
    await row(window, ids.b1).click({ modifiers: ['Meta'] })
    await expect(desks(window)).toHaveCount(2)
    await expect(focused(window)).toHaveAttribute('data-desk', ids.b1)
    await settled(window)
    const [r1, r2] = await Promise.all([
      desk(window, ids.a1).boundingBox(),
      desk(window, ids.b1).boundingBox()
    ])
    expect(r1!.x).toBeLessThan(r2!.x)
    expect(Math.abs(r1!.width - r2!.width)).toBeLessThan(4)
    expect(Math.abs(r1!.y - r2!.y)).toBeLessThan(2)
    await expect(desk(window, ids.a1).locator('.tile-num')).toHaveText('1')
    await expect(desk(window, ids.b1).locator('.tile-num')).toHaveText('2')
    await expect(composerA1).toHaveValue('a draft that must survive')
    // The sidebar has the split as one row.
    await expect(window.locator('.split-row')).toHaveCount(1)
    await expect(window.locator('.split-row')).toContainText('e2e-project · portal')
    await expect(window.locator('.split-row')).toHaveClass(/on/)
    if (shots) await window.screenshot({ path: shots('1-two') })

    // Keys: ⌘1, ⌃Tab, ⌘⌥→.
    await window.keyboard.press('Meta+1')
    await expect(focused(window)).toHaveAttribute('data-desk', ids.a1)
    await window.keyboard.press('Control+Tab')
    await expect(focused(window)).toHaveAttribute('data-desk', ids.b1)
    await window.keyboard.press('Meta+Alt+ArrowLeft')
    await expect(focused(window)).toHaveAttribute('data-desk', ids.a1)
    // A click in a window focuses it.
    await desk(window, ids.b1).locator('.easy-assistant').first().click()
    await expect(focused(window)).toHaveAttribute('data-desk', ids.b1)

    // Two chats of ONE project side by side.
    await row(window, ids.a2).click({ modifiers: ['Meta'] })
    await expect(desks(window)).toHaveCount(3)
    await expect(desk(window, ids.a1)).toBeVisible()
    await expect(desk(window, ids.a2)).toBeVisible()
    await expect(desk(window, ids.a2).locator('.easy-assistant').first()).toContainText(
      'Reply in Pricing copy'
    )
    await expect(composerA1).toHaveValue('a draft that must survive')

    // Stack them, then side by side again.
    await focused(window).getByRole('button', { name: 'Stack the windows' }).click()
    await settled(window)
    const [s1, s2] = await Promise.all([
      desk(window, ids.a1).boundingBox(),
      desk(window, ids.b1).boundingBox()
    ])
    expect(s1!.y).toBeLessThan(s2!.y)
    expect(Math.abs(s1!.x - s2!.x)).toBeLessThan(2)
    await focused(window).getByRole('button', { name: 'Put the windows side by side' }).click()

    // Full size for a moment, and back.
    await window.keyboard.press('Meta+Shift+Enter')
    await expect(desks(window)).toHaveCount(1)
    await window.keyboard.press('Meta+Shift+Enter')
    await expect(desks(window)).toHaveCount(3)

    // Four, then five: two rows, the extra window on top (eight is the most).
    await row(window, ids.c1).click({ modifiers: ['Meta'] })
    await expect(desks(window)).toHaveCount(4)
    await settled(window)
    if (shots) await window.screenshot({ path: shots('2-four') })
    await row(window, ids.c2).click({ modifiers: ['Meta'] })
    await expect(desks(window)).toHaveCount(5)
    await settled(window)
    if (shots) await window.screenshot({ path: shots('2b-five') })

    // ⌘W (the menu's Close Tab) takes the focused window off screen.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed() && w.webContents.getURL().indexOf('#dot') < 0)
        ?.webContents.send('menu:close-tab')
    })
    await expect(desks(window)).toHaveCount(4)
    // The × on a window does the same.
    await focused(window).getByRole('button', { name: 'Take this window off screen' }).click()
    await expect(desks(window)).toHaveCount(3)

    // Opening any other chat leaves the split; the split waits in the sidebar.
    const kept = await window.evaluate(() =>
      (window as unknown as { __store: Store }).__store.getState().split.tiles.map((t) => t.chat)
    )
    await row(window, ids.c2).click()
    await expect(desks(window)).toHaveCount(0)
    await expect(desk(window, ids.c2)).toBeVisible()
    await expect(window.locator('.split-row')).toHaveCount(1)
    await expect(window.locator('.split-row')).not.toHaveClass(/on/)
    // …and the Splits row brings it back, as it was.
    await window.locator('.split-row').click()
    await expect(desks(window)).toHaveCount(3)
    for (const id of kept) await expect(desk(window, id)).toBeVisible()
    await expect(composerA1).toHaveValue('a draft that must survive')

    // Name it: double-click the row, type, Enter. The name replaces the list.
    await window.locator('.split-row').dblclick()
    await window.getByLabel('Split name').fill('Launch week')
    await window.getByLabel('Split name').press('Enter')
    await expect(window.locator('.split-row-name')).toHaveText('Launch week')

    // The split comes back after a restart.
    await app.close()
    ;({ app, window } = await launch(data, proj))
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect(desks(window)).toHaveCount(3, { timeout: 15_000 })
    for (const id of kept) await expect(desk(window, id)).toBeVisible()
    await expect(window.locator('.split-row-name')).toHaveText('Launch week')

    // Separate: each chat on its own again, the row gone.
    await window.locator('.split-row').hover()
    await window.locator('.split-row-x').click()
    await expect(window.locator('.split-row')).toHaveCount(0)
    await expect(desks(window)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, proj, projB, projC]) rmSync(dir, { recursive: true, force: true })
  }
})

test('split view: drag a chat from the sidebar onto the window, and a window by its handle', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-split-drag-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-split-dragp-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const { app, window } = await launch(data, proj)
  try {
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    const ids = await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const a = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const one = await window.cove.chatCreate(a)
      const two = await window.cove.chatCreate(a)
      await window.cove.chatUpdate(one, { title: 'First chat' })
      await window.cove.chatUpdate(two, { title: 'Second chat' })
      return { a, one, two }
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(({ a, one }) => {
      const st = (window as unknown as { __store: Store }).__store.getState()
      st.setActive(a)
      st.selectChat(a, one)
    }, ids)
    await expect(desk(window, ids.one)).toBeVisible()

    // Drag "Second chat" out of the sidebar onto the right half of the window.
    const from = await row(window, ids.two).boundingBox()
    const canvas = await desk(window, ids.one).boundingBox()
    await window.mouse.move(from!.x + 30, from!.y + from!.height / 2)
    await window.mouse.down()
    await window.mouse.move(from!.x + 60, from!.y + from!.height / 2, { steps: 4 })
    const tx = canvas!.x + canvas!.width * 0.85
    const ty = canvas!.y + canvas!.height / 2
    await window.mouse.move(tx, ty, { steps: 12 })
    await expect(window.locator('.split-ghost.new')).toBeVisible()
    // The preview covers the whole window area, from just below the top strip.
    const drop = await window.locator('.split-drop').boundingBox()
    expect(Math.abs(drop!.y - canvas!.y)).toBeLessThan(2)
    // The sidebar's list stays where it was (it used to scroll away under the drag).
    await expect(row(window, ids.one)).toBeInViewport()
    await settled(window)
    if (shots) await window.screenshot({ path: shots('3-dragging') })
    await window.mouse.up()
    await expect(desks(window)).toHaveCount(2)
    await settled(window)
    const [l, r] = await Promise.all([
      desk(window, ids.one).boundingBox(),
      desk(window, ids.two).boundingBox()
    ])
    expect(l!.x).toBeLessThan(r!.x)

    // Carry window 1 by its handle to the right of window 2: the order swaps.
    const grip = await desk(window, ids.one).locator('.tile-grip').boundingBox()
    const right = await desk(window, ids.two).boundingBox()
    await window.mouse.move(grip!.x + 4, grip!.y + 8)
    await window.mouse.down()
    await window.mouse.move(grip!.x + 40, grip!.y + 40, { steps: 4 })
    await window.mouse.move(right!.x + right!.width * 0.9, right!.y + right!.height / 2, {
      steps: 12
    })
    await window.mouse.up()
    await settled(window)
    const [l2, r2] = await Promise.all([
      desk(window, ids.two).boundingBox(),
      desk(window, ids.one).boundingBox()
    ])
    expect(l2!.x).toBeLessThan(r2!.x)

    // Drag the gap between them: the left window grows.
    await settled(window)
    const before = (await desk(window, ids.two).boundingBox())!.width
    const gap = await window.locator('.split-gap').first().boundingBox()
    await window.mouse.move(gap!.x + gap!.width / 2, gap!.y + gap!.height / 2)
    await window.mouse.down()
    await window.mouse.move(gap!.x + 160, gap!.y + gap!.height / 2, { steps: 8 })
    await window.mouse.up()
    await settled(window)
    expect((await desk(window, ids.two).boundingBox())!.width).toBeGreaterThan(before + 100)
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})

test('split view: a narrow window shows its browser as a mini, and big docks it', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-split-mini-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-split-minip-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const { app, window } = await launch(data, proj)
  try {
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    const ids = await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const a = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const one = await window.cove.chatCreate(a)
      const two = await window.cove.chatCreate(a)
      await window.cove.chatUpdate(one, { title: 'Web chat' })
      await window.cove.chatUpdate(two, { title: 'Other chat' })
      return { a, one, two }
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(({ a, one, two }) => {
      const st = (window as unknown as { __store: Store }).__store.getState()
      st.setActive(a)
      st.selectChat(a, one)
      st.openBeside(a, two)
      st.focusTile(0)
    }, ids)
    await expect(desks(window)).toHaveCount(2)
    // Open the browser in window 1 (590px wide): it is a mini inside that window.
    await desk(window, ids.one)
      .locator('.workspace-toolbar')
      .getByTitle('Browser', { exact: true })
      .click()
    const miniPane = desk(window, ids.one).locator('.mini-pane')
    await expect(miniPane).toBeVisible()
    await expect(desk(window, ids.one).locator('.split-side.desk')).toHaveCount(0)
    const box = await miniPane.boundingBox()
    const win = await desk(window, ids.one).boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(win!.x + win!.width)
    expect(box!.x).toBeGreaterThanOrEqual(win!.x)
    // The page inside is the desktop layout scaled down, not squeezed: it lays
    // out about 1280px wide and is zoomed to the mini's width.
    writeFileSync(
      join(proj, 'wide.html'),
      '<title>wide</title><body style="margin:0">desktop</body>'
    )
    await window.evaluate(({ a, one, url }) => window.cove.browserNavigate(`${a}::${one}`, url), {
      ...ids,
      url: `file://${join(proj, 'wide.html')}`
    })
    await expect
      .poll(
        () =>
          app.evaluate(async ({ webContents }) => {
            const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('wide.html'))
            if (!wc) return null
            const inner = await wc.executeJavaScript('innerWidth')
            return { inner, zoom: wc.getZoomFactor() }
          }),
        { timeout: 10_000 }
      )
      .toMatchObject({ inner: expect.any(Number) })
    const page = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('wide.html'))!
      return {
        inner: (await wc.executeJavaScript('innerWidth')) as number,
        zoom: wc.getZoomFactor()
      }
    })
    expect(page.inner).toBeGreaterThan(1100)
    expect(page.zoom).toBeLessThan(0.4)
    await settled(window)
    if (shots) await window.screenshot({ path: shots('4-mini') })
    // Small: a chip; the chip brings it back.
    await miniPane.getByRole('button', { name: 'Make it small' }).click()
    await expect(desk(window, ids.one).locator('.mini-chip')).toBeVisible()
    await desk(window, ids.one).locator('.mini-chip').click()
    await expect(miniPane).toBeVisible()
    // Big: the window goes full size and the browser docks beside the chat.
    await miniPane.getByRole('button', { name: 'See it big' }).click()
    await expect(desks(window)).toHaveCount(1)
    await expect(desk(window, ids.one).locator('.mini-pane')).toHaveCount(0)
    await expect(desk(window, ids.one).locator('.split-side.desk')).toBeVisible()
    await settled(window)
    if (shots) await window.screenshot({ path: shots('5-big') })
    // Back to the split: a mini again.
    await desk(window, ids.one).getByRole('button', { name: 'Back to the split' }).click()
    await expect(desks(window)).toHaveCount(2)
    await expect(miniPane).toBeVisible()
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
