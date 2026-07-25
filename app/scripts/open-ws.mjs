import { chromium } from 'playwright-core'

const out = process.argv[2]
const clickText = process.argv[3]
const browser = await chromium.connectOverCDP('http://localhost:9222')
let app
for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517')) app = p
if (!app) throw new Error('app not found')
await app.reload()
await new Promise((r) => setTimeout(r, 2500))
if (clickText) {
  await app.click(`text=${clickText}`).catch((e) => console.error('click failed', e.message))
  await new Promise((r) => setTimeout(r, 4500))
}
await app.screenshot({ path: out })
console.log('saved', out)
await browser.close()
