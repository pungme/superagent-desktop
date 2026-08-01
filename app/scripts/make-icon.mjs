// Render the Cove app icon SVG to a 1024px PNG using headless Chromium,
// then macOS iconutil turns it into icon.icns. No image libraries needed.
import { chromium } from 'playwright-core'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const out = join(__dirname, '..', 'build', 'icon.png')

// A square dot, centered: one white squircle on near-black. The only depth cues
// are a top-lit background gradient and a soft glow, so it stays crisp at 16px.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2b31"/>
      <stop offset="1" stop-color="#121317"/>
    </linearGradient>
    <linearGradient id="dot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e6e6ea"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="10" stdDeviation="26" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="230" fill="url(#bg)"/>
  <!-- Hairline top highlight, the way macOS icons catch light. -->
  <rect x="1" y="1" width="1022" height="1022" rx="229" fill="none"
        stroke="#ffffff" stroke-opacity="0.09" stroke-width="2"/>
  <rect x="362" y="362" width="300" height="300" rx="82"
        fill="url(#dot)" filter="url(#glow)"/>
</svg>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(`<style>*{margin:0}body{width:1024px;height:1024px}</style>${svg}`, {
  waitUntil: 'networkidle'
})
const png = await page.locator('svg').screenshot({ omitBackground: true })
writeFileSync(out, png)
console.log('wrote', out)
await browser.close()
