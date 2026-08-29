// Driver for the simulator's in-place snip: launches the built app (npm run
// build first) against a throwaway userData dir with a seeded project, opens
// the simulator pane on a booted device, and exercises ✂ Snip — the layer must
// sit exactly on the picture, Esc must cancel, and a drag must land a native-
// resolution crop in the composer. Screenshots go to $SNIP_OUT.
//   SNIP_OUT=/tmp node scripts/_snip-e2e.mjs snip
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
const S = process.env.SNIP_OUT
const step = process.argv[2] || 'explore'
const udid = process.env.SNIP_UDID || 'F50E11A4-75A9-4F60-90F1-5C0E2317702A' // a booted device
const userData = mkdtempSync(join(tmpdir(), 'snip-e2e-data-'))
const proj = mkdtempSync(join(tmpdir(), 'snip-e2e-proj-'))
writeFileSync(join(proj, 'README.md'), '# snip e2e\n')
const app = await electron.launch({
  args: [join(__dirname, '..', 'out', 'main', 'index.js')],
  env: { ...process.env, COVE_USER_DATA: userData, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
await win.reload()
await win.waitForSelector('.sidebar', { timeout: 20000 })
await win.click('.sidebar-item:has-text("e2e-project")')
await win.waitForSelector('.workspace-toolbar', { timeout: 10000 })
const info = await win.evaluate(() => ({
  ls: Object.keys(localStorage),
  cove: Object.keys(window.cove).filter((k) => /workspace|group|chat|sim/i.test(k))
}))
console.log(JSON.stringify(info, null, 1))
if (step === 'explore') {
  await win.screenshot({ path: join(S, 'snip-0.png') })
  await app.close()
  process.exit(0)
}
// --- snip step: open the sim pane on the booted device, snip in place
const wsId = await win.evaluate(() => localStorage.getItem('activeWorkspace'))
await win.evaluate(
  ([ws, u]) => {
    localStorage.setItem(`simOpen:${ws}`, '1')
    localStorage.setItem(`cove.simDevice:${ws}`, u)
    localStorage.setItem('cove.simDevice', u)
  },
  [wsId, udid]
)
await win.reload()
await win.waitForSelector('.sidebar', { timeout: 20000 })
await win.click('.sidebar-item:has-text("e2e-project")')
await win.waitForSelector('img.sim-screen', { timeout: 30000 })
await win.waitForTimeout(1500)
await win.screenshot({ path: join(S, 'snip-1-pane.png') })
await win.click('.pane-dock-btn:has-text("Snip")')
await win.waitForSelector('.sim-snip', { timeout: 5000 })
await win.waitForTimeout(900) // let the native-res still swap in
const box = await win.locator('.sim-snip').boundingBox()
const shot = await win.locator('img.sim-screen').boundingBox()
console.log('layer', JSON.stringify(box), 'picture', JSON.stringify(shot))
await win.screenshot({ path: join(S, 'snip-2-overlay.png') })
// Esc cancels
await win.keyboard.press('Escape')
await win.waitForSelector('.sim-snip', { state: 'detached', timeout: 3000 })
console.log('esc: overlay gone, picture live again:', !!(await win.locator('img.sim-screen').count()))
// Snip again and drag a region over the top of the phone
await win.click('.pane-dock-btn:has-text("Snip")')
await win.waitForSelector('.sim-snip', { timeout: 5000 })
await win.waitForTimeout(900)
const b = await win.locator('.sim-snip').boundingBox()
await win.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.08)
await win.mouse.down()
await win.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.2, { steps: 6 })
await win.mouse.move(b.x + b.width * 0.9, b.y + b.height * 0.3, { steps: 6 })
await win.screenshot({ path: join(S, 'snip-3-drag.png') })
await win.mouse.up()
await win.waitForSelector('.easy-attachment', { timeout: 5000 })
await win.waitForSelector('.sim-snip', { state: 'detached', timeout: 3000 })
const att = await win.evaluate(() => {
  const img = document.querySelector('.easy-attachment img')
  return img ? { w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 30) } : null
})
console.log('attachment', JSON.stringify(att))
await win.screenshot({ path: join(S, 'snip-4-attached.png') })
await app.close()
