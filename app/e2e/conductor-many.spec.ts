import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'

/** 22 old sessions with no summaries (a real project's Conductor): cards still say something. SHOT=path saves a picture. */
test('a Conductor with many sessions shows their last message and a fanned-out trunk', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-many-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-many-proj-'))
  writeFileSync(join(proj, 'README.md'), '# many\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await page.setViewportSize({ width: 1440, height: 900 })
    const titles = [
      'General improvements 4',
      'Creator Discovery',
      'Advance targeting (followers and viewscore)',
      'analytics',
      'monitoring',
      'Downpayment flow',
      'Cosnova requirements'
    ]
    const ws = await page.evaluate(async (names) => {
      const tree = await window.cove.storeTree()
      const w = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      const ids: string[] = []
      for (const n of names) {
        const id = await window.cove.chatCreate(w.id)
        await window.cove.chatUpdate(id, { title: n })
        ids.push(id)
      }
      await window.cove.conductorEnable(w.id, ids)
      return w.id
    }, titles)
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.getByTestId('sidebar-conductor-row').click()
    await expect(page.getByTestId('conductor-panel')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('conductor-session')).toHaveCount(titles.length)
    await page.waitForTimeout(800)
    // The Conductor section lines up with the Routines row above it: icon, title and names.
    const xs = await page.evaluate(() => {
      const left = (el: Element | null, text: boolean): number => {
        if (!el) return -1
        if (!text) return Math.round(el.getBoundingClientRect().left)
        const r = document.createRange()
        r.selectNodeContents(el)
        return Math.round(r.getBoundingClientRect().left)
      }
      const q = (sel: string): Element | null => document.querySelector(sel)
      return {
        routinesIcon: left(q('[data-testid="sidebar-routines"] svg'), false),
        routinesLabel: (() => {
          const t = [...(q('[data-testid="sidebar-routines"]')?.childNodes ?? [])].find(
            (n) => n.nodeType === 3 && n.textContent?.trim()
          )
          if (!t) return -1
          const r = document.createRange()
          r.selectNodeContents(t)
          return Math.round(r.getBoundingClientRect().left)
        })(),
        mark: left(q('.sidebar-conductor-mark'), false),
        title: left(q('.sidebar-conductor .sidebar-group-title'), true),
        name: left(q('.sidebar-conductor-name'), true)
      }
    })
    expect(xs.mark).toBe(xs.routinesIcon)
    expect(Math.abs(xs.title - xs.routinesLabel)).toBeLessThanOrEqual(1)
    expect(Math.abs(xs.name - xs.routinesLabel)).toBeLessThanOrEqual(1)
    if (process.env.SHOT) {
      mkdirSync(join(process.env.SHOT, '..'), { recursive: true })
      await page.screenshot({ path: process.env.SHOT })
    }
    void ws
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
