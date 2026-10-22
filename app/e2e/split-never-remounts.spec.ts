import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 2026-10-22: opening or leaving a split stopped every other running session.
 * The project view returned its chats in two different shapes for the two
 * modes, so React rebuilt every chat — and a chat's agent lives inside it.
 * Drafts are saved, so a rebuilt chat looked the same; this test holds the
 * chat's actual element and fails if it is ever replaced, for the chat on
 * screen AND for a hidden one kept running in the background.
 */
test('entering, leaving and switching splits never rebuilds a chat', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-split-mount-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-split-mountp-'))
  const projB = mkdtempSync(join(tmpdir(), 'cove-split-mountb-'))
  for (const p of [proj, projB]) writeFileSync(join(p, 'README.md'), '# e2e\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window: Page = await app.firstWindow()
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    const ids = await window.evaluate(async (projB) => {
      const tree = await window.cove.storeTree()
      const a = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const b = (await window.cove.createWorkspace(tree[0].id, 'other', projB)).workspaceId
      const make = async (ws: string, title: string): Promise<string> => {
        const id = await window.cove.chatCreate(ws)
        await window.cove.chatUpdate(id, { title })
        return id
      }
      return {
        a,
        b,
        bg: await make(a, 'Background chat'),
        one: await make(a, 'On screen'),
        other: await make(b, 'Other project'),
        third: await make(b, 'Third')
      }
    }, projB)
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    type St = { getState: () => Record<string, (...a: string[]) => unknown> }
    const store = (fn: string, ...args: string[]): Promise<unknown> =>
      window.evaluate(
        ({ fn, args }) =>
          (
            (window as unknown as { __store: St }).__store.getState()[fn] as (
              ...a: string[]
            ) => unknown
          )(...args),
        { fn, args }
      )
    // The background chat first, then the one on screen: the first stays mounted, hidden.
    await store('setActive', ids.a)
    await store('selectChat', ids.a, ids.bg)
    await expect(window.locator(`[data-desk="${ids.bg}"] .chat-mount`)).toBeVisible()
    await store('selectChat', ids.a, ids.one)
    await expect(window.locator(`[data-desk="${ids.one}"] .chat-mount`)).toBeVisible()
    // Hold on to both chats' elements.
    await window.evaluate(({ bg, one }) => {
      const w = window as unknown as { held: Element[] }
      w.held = [bg, one].map((id) => document.querySelector(`[data-desk="${id}"] .chat-mount`)!)
    }, ids)
    const intact = (): Promise<boolean[]> =>
      window.evaluate(() =>
        (window as unknown as { held: Element[] }).held.map((el) => el.isConnected)
      )
    expect(await intact()).toEqual([true, true])

    // Into a split with a chat of another project.
    await store('openBeside', ids.b, ids.other)
    await expect(window.locator('.workspace-view.in-tile:visible')).toHaveCount(2)
    expect(await intact()).toEqual([true, true])
    // Out of it, by opening a chat that is not in it.
    await store('setActive', ids.b)
    await store('selectChat', ids.b, ids.third)
    await expect(window.locator('.workspace-view.in-tile:visible')).toHaveCount(0)
    expect(await intact()).toEqual([true, true])
    // Back into it from the Splits row.
    await window.locator('.split-row').click()
    await expect(window.locator('.workspace-view.in-tile:visible')).toHaveCount(2)
    expect(await intact()).toEqual([true, true])
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, proj, projB]) rmSync(dir, { recursive: true, force: true })
  }
})
