// Dev helper: drive the running app over CDP — click the terminal, run a command, screenshot.
import { chromium } from 'playwright-core'

const out = process.argv[2] || 'claude-tui.png'
const command = process.argv[3] || 'claude'
const waitMs = Number(process.argv[4] || 15000)

const browser = await chromium.connectOverCDP('http://localhost:9222')
let target
for (const ctx of browser.contexts()) {
  for (const page of ctx.pages()) {
    if (page.url().includes('localhost:517')) target = page
  }
}
if (!target) throw new Error('app page not found')

await target.click('.terminal-pane')
await target.keyboard.type(command, { delay: 30 })
await target.keyboard.press('Enter')
await new Promise((r) => setTimeout(r, waitMs))
await target.screenshot({ path: out })
console.log('saved', out)
await browser.close()
