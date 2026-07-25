import { chromium } from 'playwright-core'

const out = process.argv[2] || 'cove-shot.png'
const browser = await chromium.connectOverCDP('http://localhost:9222')
const contexts = browser.contexts()
let target
for (const ctx of contexts) {
  for (const page of ctx.pages()) {
    const url = page.url()
    if (url.includes('localhost:517') || url.includes('index.html')) target = page
  }
}
if (!target) {
  console.error(
    'No app page found. Pages:',
    contexts.flatMap((c) => c.pages().map((p) => p.url()))
  )
  process.exit(1)
}
await target.screenshot({ path: out })
console.log('saved', out, target.url())
await browser.close()
