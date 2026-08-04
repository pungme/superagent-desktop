import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://localhost:9222')
const p = b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('index.html'))
// Open the preview if it's hidden
await p.click('text=Show preview').catch(e=>console.error('show-preview click:', e.message))
await p.waitForTimeout(4500)
await p.bringToFront()
await p.screenshot({ path: process.argv[2] })
console.log('done')
await b.close()
