// Screenshot the app *including* the browser pane.
//
// The pane is a native WebContentsView, not part of the renderer's DOM, so a CDP
// screenshot of the app page comes back with a blank hole where the web page is.
// A native window capture would solve it, but that needs Screen Recording rights.
// Instead: capture the pane's own CDP target, drop it into the app's DOM as an
// <img> positioned exactly over the hole, screenshot, then take the img back out.
import { chromium } from 'playwright-core'

const out = process.argv[2] || 'shot.png'
// Match a specific pane target by URL fragment when more than one is open.
const paneMatch = process.argv[3] || ''

const browser = await chromium.connectOverCDP('http://localhost:9222')
const pages = browser.contexts().flatMap((c) => c.pages())
// Identify the renderer by its preload bridge, not by URL: a previewed local file
// is itself an index.html, so a URL match can pick the page being previewed.
const app = (
  await Promise.all(
    pages.map(async (p) => ((await p.evaluate(() => !!window.cove).catch(() => false)) ? p : null))
  )
).find(Boolean)
if (!app) throw new Error('app page not found')

// Several workspaces can have a pane open at once, and every one of them is a
// separate CDP target. The right one is whichever matches the address bar of the
// workspace currently on screen — matching on a URL fragment picks the wrong pane
// as soon as two are open.
const activeUrl = await app.evaluate(() => {
  const input = [...document.querySelectorAll('.browser-address')].find(
    (el) => el.offsetParent !== null
  )
  return input ? input.value : null
})
const pane = pages.find((p) => {
  if (p === app || p.url().startsWith('devtools://')) return false
  if (paneMatch) return p.url().includes(paneMatch)
  if (!activeUrl) return false
  const norm = (u) => u.replace(/\/$/, '')
  return norm(p.url()) === norm(activeUrl) || p.url().startsWith(activeUrl)
})

let shot = null
// The pane renders zoomed (the app scales a simulated 1440-wide screen down to
// fit), so the compositor fills only the top-left fraction of the framebuffer that
// a CDP capture hands back — the rest is blank. That fraction is the pane's own
// devicePixelRatio over the capture scale, and the painted part holds the WHOLE
// viewport, just drawn smaller. Scale the image back up by it and clip.
let paintedFraction = 1
if (pane) {
  shot = (await pane.screenshot({ type: 'png' })).toString('base64')
  const paneDpr = await pane.evaluate(() => window.devicePixelRatio).catch(() => 1)
  const appDpr = await app.evaluate(() => window.devicePixelRatio).catch(() => 1)
  paintedFraction = Math.min(1, paneDpr / appDpr)
  console.log('captured pane:', pane.url().slice(0, 60), '| painted', paintedFraction.toFixed(3))
} else {
  console.log('no pane target — capturing app only')
}

// The card the native view floats on; its top strip is the docked omnibar, so the
// page itself starts CARD_OMNIBAR_H below the card's top edge.
const CARD_OMNIBAR_H = 40

await app.evaluate(
  ({ shot, CARD_OMNIBAR_H, paintedFraction }) => {
    document.querySelectorAll('.__shot_overlay').forEach((n) => n.remove())
    // A focused composer draws a focus ring, which reads as "mid-typing" in a still.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()

    // The window is `vibrancy: 'sidebar'` over a transparent body, so the sidebar's
    // material is painted natively — a CDP capture sees straight through it to
    // nothing and renders it black. Stand in the tone the material resolves to, and
    // draw the traffic lights the (hiddenInset) titlebar really shows, so the still
    // matches what's actually on screen.
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    document.body.style.background = dark ? '#1c1c1e' : '#eceaef'
    const lights = document.createElement('div')
    lights.className = '__shot_overlay'
    Object.assign(lights.style, {
      position: 'fixed',
      left: '20px',
      top: '14px',
      display: 'flex',
      gap: '8px',
      zIndex: '9999',
      pointerEvents: 'none'
    })
    for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
      const dot = document.createElement('span')
      Object.assign(dot.style, {
        width: '12px',
        height: '12px',
        borderRadius: '50%',
        background: color,
        boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.12)'
      })
      lights.appendChild(dot)
    }
    document.body.appendChild(lights)
    if (!shot) return 'no-shot'
    // Every opened workspace stays mounted (hidden ones are display:none), so a
    // plain querySelector can hand back the pane of a workspace that isn't on
    // screen — the image then lands somewhere invisible and the shot looks blank.
    const visible = (el) => el && el.offsetParent !== null
    const host = [...document.querySelectorAll('.browser-host')].find(visible)
    if (!host) return 'no-target'
    const card = [...host.querySelectorAll('.browser-sim-frame')].find(visible)
    // Anchored inside the pane rather than fixed over the window: a full-window
    // overlay makes the compositor re-render the whole surface, and the sidebar's
    // translucent material has nothing behind it in a CDP capture, so it comes out
    // black. Keeping the new layer local to the pane leaves the rest untouched.
    const hostRect = host.getBoundingClientRect()
    const r = card ? card.getBoundingClientRect() : hostRect
    const w = r.width
    const h = r.height - (card ? CARD_OMNIBAR_H : 0)
    // Window clipped to the pane's rect; the image inside is blown up by 1/fraction
    // so its painted corner lands exactly on the rect and the blank rest is cut off.
    const clip = document.createElement('div')
    clip.className = '__shot_overlay'
    Object.assign(clip.style, {
      position: 'absolute',
      left: `${r.left - hostRect.left}px`,
      top: `${r.top - hostRect.top + (card ? CARD_OMNIBAR_H : 0)}px`,
      width: `${w}px`,
      height: `${h}px`,
      overflow: 'hidden',
      pointerEvents: 'none'
    })
    const img = document.createElement('img')
    img.src = `data:image/png;base64,${shot}`
    Object.assign(img.style, {
      display: 'block',
      width: `${w / paintedFraction}px`,
      height: `${h / paintedFraction}px`,
      objectFit: 'fill'
    })
    clip.appendChild(img)
    host.appendChild(clip)
    return 'placed'
  },
  { shot, CARD_OMNIBAR_H, paintedFraction }
)

// Let the data: URL decode and paint before capturing. A full-page capture can be
// a megabyte of base64, and screenshotting before it decodes yields a blank pane.
await app
  .waitForFunction(
    () => {
      const img = document.querySelector('.__shot_overlay img')
      return !img || (img.complete && img.naturalWidth > 0)
    },
    { timeout: 20000 }
  )
  .catch(() => console.error('overlay image did not decode in time'))
await app.waitForTimeout(400)
await app.screenshot({ path: out })
await app.evaluate(() => {
  document.querySelectorAll('.__shot_overlay').forEach((n) => n.remove())
  document.body.style.background = ''
})
console.log('saved', out)
await browser.close()
