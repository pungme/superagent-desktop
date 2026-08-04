import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://localhost:9222')
const p = b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('index.html'))
await p.bringToFront()
await p.screenshot({ path: process.argv[2] })
console.log('front+shot done')
await b.close()
