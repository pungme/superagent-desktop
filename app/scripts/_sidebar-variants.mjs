// Sidebar grouping mockups: seeds three groups of projects in a throwaway
// instance and screenshots the sidebar under each CSS variant (or the shipped
// CSS as-is with SNIP_PLAIN=1). Screenshots go to $SNIP_OUT.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
const S = process.env.SNIP_OUT
const userData = mkdtempSync(join(tmpdir(), 'sb-data-'))
const proj = mkdtempSync(join(tmpdir(), 'sb-proj-'))
writeFileSync(join(proj, 'README.md'), '# x\n')
const app = await electron.launch({
  args: [join(__dirname, '..', 'out', 'main', 'index.js')],
  env: { ...process.env, COVE_USER_DATA: userData, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
await win.reload()
await win.waitForSelector('.sidebar', { timeout: 20000 })
const groups = {
  Moff: ['mff-landingpage'],
  Levantto: ['levantto-shop', 'levantto'],
  Wepush: ['wepush', 'wepush-ios', 'wepush-advertiser', 'wepush-development', 'wepush-portal']
}
const dirs = {}
for (const [g, names] of Object.entries(groups))
  for (const n of names) {
    const d = join(proj, g, n)
    mkdirSync(d, { recursive: true })
    dirs[n] = d
  }
await win.evaluate(
  async ({ groups, dirs }) => {
    for (const [g, names] of Object.entries(groups)) {
      const tree = await window.cove.createGroup(g)
      const grp = tree.find((x) => x.name === g)
      for (const n of names) await window.cove.createWorkspace(grp.id, n, dirs[n])
    }
  },
  { groups, dirs }
)
const reset = `.sidebar-group + .sidebar-group { border-top: none; padding-top: 0; margin-top: 14px; }`
const variants = {
  'A-card': `${reset}
    .sidebar-group + .sidebar-group { margin-top: 8px }
    .sidebar-group:not(:has(.tabs-head)) { background: rgba(0,0,0,0.04); padding: 6px 6px 6px 4px; }
    .sidebar-group-title { color: var(--text-secondary) }`,
  'B-bold-name': `${reset}
    .sidebar-group + .sidebar-group { margin-top: 18px }
    .sidebar-group-header { margin-bottom: 4px }
    .sidebar-group-title { text-transform: none; letter-spacing: 0; font-size: 13px; font-weight: 700; color: var(--text-primary); }`,
  'C-rail': `${reset}
    .sidebar-group + .sidebar-group { margin-top: 16px }
    .sidebar-group:not(:has(.tabs-head)) .sidebar-group-items { margin-left: 9px; padding-left: 8px; border-left: 2px solid var(--border-strong); }
    .sidebar-group-title { color: var(--text-secondary) }`,
  'D-header-bar': `${reset}
    .sidebar-group + .sidebar-group { margin-top: 12px }
    .sidebar-group:not(:has(.tabs-head)) .sidebar-group-header { background: rgba(0,0,0,0.055); border-radius: 7px; padding: 4px 6px; margin-bottom: 4px; }
    .sidebar-group-title { color: var(--text-secondary) }`
}
for (const [name, css] of Object.entries(process.env.SNIP_PLAIN ? { final: '' } : variants)) {
  await win.reload()
  await win.waitForSelector('.sidebar-item:has-text("wepush-portal")', { timeout: 20000 })
  if (css) await win.addStyleTag({ content: css })
  await win.waitForTimeout(400)
  if (process.env.SNIP_PLAIN) await win.locator('.sidebar-group:has-text("Levantto")').hover()
  const b = await win.locator('.sidebar').boundingBox()
  await win.screenshot({
    path: join(S, `sb-${name}.png`),
    clip: { x: b.x, y: b.y + 90, width: b.width, height: 620 }
  })
}
await app.close()
console.log('variants ok')
