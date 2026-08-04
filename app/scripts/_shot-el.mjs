// Screenshot a single element of the running app (sidebar, settings panel, …).
// Same vibrancy caveat as the full-window shot: the window paints its sidebar
// material natively, so stand in a solid tone first or the capture comes back
// black where the DOM is transparent.
import { chromium } from 'playwright-core'

const out = process.argv[2] || 'el.png'
const selector = process.argv[3]
if (!selector) throw new Error('usage: _shot-el.mjs <out> <selector>')
const padding = Number(process.argv[4] || 0)
// Optional: trim the capture to the top N CSS px of the element (a tall sidebar is
// mostly empty space below the last project).
const maxHeight = Number(process.argv[5] || 0)

const browser = await chromium.connectOverCDP('http://localhost:9222')
// Identify the renderer by its preload bridge, not by URL: a previewed local file
// is itself an index.html, so a URL match can pick the page being previewed.
const allPages = browser.contexts().flatMap((c) => c.pages())
const page = (
  await Promise.all(
    allPages.map(async (p) => ((await p.evaluate(() => !!window.cove).catch(() => false)) ? p : null))
  )
).find(Boolean)
if (!page) throw new Error('app page not found')

const box = await page.evaluate(
  ({ selector, padding }) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    document.body.style.background = dark ? '#1c1c1e' : '#eceaef'
    // Only ever the copy that's actually on screen — hidden workspaces stay mounted.
    // offsetParent is null for position:fixed elements, so measure instead.
    const shown = (n) => {
      const r = n.getBoundingClientRect()
      const cs = getComputedStyle(n)
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    const el = [...document.querySelectorAll(selector)].find(shown)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.max(0, r.x - padding),
      y: Math.max(0, r.y - padding),
      width: r.width + padding * 2,
      height: r.height + padding * 2
    }
  },
  { selector, padding }
)
if (!box) throw new Error(`no visible element for ${selector}`)

if (maxHeight) box.height = Math.min(box.height, maxHeight)
await page.waitForTimeout(300)
await page.screenshot({ path: out, clip: box })
await page.evaluate(() => {
  document.body.style.background = ''
})
console.log('saved', out, JSON.stringify(box))
await browser.close()
