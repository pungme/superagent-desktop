import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The Splits rows: a thumbnail of each split's windows as they sit, its name,
 * the chats in it, and a dot while one of them works.
 */
test('a split row shows its layout, its chats and whether one is working', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-split-rowv-'))
  const projs = ['wepush', 'portal', 'api'].map((n) => {
    const d = mkdtempSync(join(tmpdir(), `cove-${n}-`))
    writeFileSync(join(d, 'README.md'), '# e2e\n')
    return d
  })
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: projs[0],
      NODE_ENV: 'production'
    }
  })
  try {
    const window: Page = await app.firstWindow()
    await window.evaluate((dark) => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
      localStorage.setItem('cove.theme', dark ? 'dark' : 'light')
    }, !!process.env.DARK)
    const ids = await window.evaluate(
      async ([p1, p2]) => {
        const tree = await window.cove.storeTree()
        const a = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
        const b = (await window.cove.createWorkspace(tree[0].id, 'portal', p1)).workspaceId
        const c = (await window.cove.createWorkspace(tree[0].id, 'api', p2)).workspaceId
        const make = async (ws: string, title: string): Promise<string> => {
          const id = await window.cove.chatCreate(ws)
          await window.cove.chatUpdate(id, { title })
          return id
        }
        return {
          a,
          b,
          c,
          a1: await make(a, 'Campaign'),
          a2: await make(a, 'Downpayment'),
          b1: await make(b, 'Onboarding copy'),
          c1: await make(c, 'Rerun e2e'),
          c2: await make(c, 'Login flow'),
          lone: await make(c, 'Somewhere else')
        }
      },
      [projs[1], projs[2]]
    )
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.setViewportSize({ width: 1440, height: 900 })
    type St = { getState: () => Record<string, (...a: unknown[]) => unknown> }
    const store = (fn: string, ...args: unknown[]): Promise<unknown> =>
      window.evaluate(
        ({ fn, args }) => (window as unknown as { __store: St }).__store.getState()[fn](...args),
        { fn, args }
      )
    // Two windows, then four, each saved as a split.
    await store('setActive', ids.a)
    await store('selectChat', ids.a, ids.a1)
    await store('openBeside', ids.b, ids.b1)
    await expect(window.locator('.split-row')).toHaveCount(1)
    await store('setActive', ids.c)
    await store('selectChat', ids.c, ids.lone)
    await store('selectChat', ids.c, ids.c1)
    await store('openBeside', ids.c, ids.c2)
    await store('openBeside', ids.a, ids.a2)
    await store('openBeside', ids.b, ids.b1)
    await expect(window.locator('.split-row')).toHaveCount(2)
    const rows = window.locator('.split-row')
    // The newest split first. Each window is a cell of the thumbnail, laid out as on screen.
    await expect(rows.nth(1).locator('.split-thumb-cell')).toHaveCount(2)
    await expect(rows.nth(0).locator('.split-thumb-cell')).toHaveCount(4)
    // The chats are named under the split.
    await expect(rows.nth(1).locator('.split-row-chats')).toHaveText('Campaign · Onboarding copy')
    // A chat that works lights its split's dot.
    await window.evaluate((id) => {
      const s = (
        window as unknown as {
          __store: {
            setState: (p: unknown) => void
            getState: () => { busy: Record<string, unknown> }
          }
        }
      ).__store
      s.setState({ busy: { ...s.getState().busy, [id]: { generating: true } } })
    }, ids.b1)
    await expect(rows.nth(1).locator('.split-row-status.working')).toBeVisible()
    if (process.env.SHOT) {
      // The short splash plays over a fresh load.
      await window.waitForTimeout(3500)
      const box = (await window.locator('.sidebar-splits').boundingBox())!
      await window.screenshot({
        path: process.env.SHOT,
        clip: { x: 0, y: Math.max(0, box.y - 10), width: 300, height: box.height + 120 }
      })
    }
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, ...projs]) rmSync(dir, { recursive: true, force: true })
  }
})
