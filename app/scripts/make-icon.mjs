// Render the Cove app icon SVG to a 1024px PNG using headless Chromium,
// then macOS iconutil turns it into icon.icns. No image libraries needed.
import { chromium } from 'playwright-core'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const out = join(__dirname, '..', 'build', 'icon.png')

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3d8f"/>
      <stop offset="1" stop-color="#1e1f4a"/>
    </linearGradient>
    <linearGradient id="wave" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a5a9ff"/>
      <stop offset="1" stop-color="#8b8ff8"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="230" fill="url(#bg)"/>
  <path d="M170 640
    C 300 540, 380 760, 512 660
    C 644 560, 724 780, 854 660
    L 854 860 L 170 860 Z" fill="url(#wave)" opacity="0.95"/>
  <path d="M170 720
    C 300 630, 380 840, 512 740
    C 644 640, 724 850, 854 740
    L 854 880 L 170 880 Z" fill="#ffffff" opacity="0.25"/>
  <circle cx="720" cy="330" r="86" fill="#ffffff" opacity="0.9"/>
</svg>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(
  `<style>*{margin:0}body{width:1024px;height:1024px}</style>${svg}`,
  { waitUntil: 'networkidle' }
)
const png = await page.locator('svg').screenshot({ omitBackground: true })
writeFileSync(out, png)
console.log('wrote', out)
await browser.close()
