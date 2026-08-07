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

// Pane pixels come from main's capturePage (full display resolution, exactly
// what the compositor shows) — a debugger screenshot of the zoomed page captures
// at the page's shrunken pixel scale and has to be blown back up, which is why
// earlier shots were soft.
const shot = await app.evaluate(async () => {
  const host = [...document.querySelectorAll('.browser-host')].find(
    (h) => h.getBoundingClientRect().width > 0
  )
  const id = host && host.dataset.paneId
  if (!id) return null
  const bytes = await window.cove.browserShoot(id)
  if (!bytes || !bytes.length) return null
  const arr = new Uint8Array(bytes)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < arr.length; i += CH) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CH))
  }
  return btoa(bin)
})
if (shot) console.log('captured pane via main, bytes:', Math.round((shot.length * 3) / 4))
else console.log('no pane capture — app only')

// Side-by-side mode runs the phone in a second WebContentsView, invisible to the
// pane capture above — without this the phone comes out an empty white slab.
const twinShot = await app.evaluate(async () => {
  const bytes = await window.cove.browserShootTwin?.()
  if (!bytes || !bytes.length) return null
  const arr = new Uint8Array(bytes)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < arr.length; i += CH) bin += String.fromCharCode.apply(null, arr.subarray(i, i + CH))
  return btoa(bin)
})
if (twinShot) console.log('captured phone twin')

// The card the native view floats on; its top strip is the docked omnibar, so the
// page itself starts CARD_OMNIBAR_H below the card's top edge.
const CARD_OMNIBAR_H = 40

await app.evaluate(
  ({ shot, twinShot, CARD_OMNIBAR_H }) => {
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
    const frames = [...host.querySelectorAll('.browser-sim-frame')].filter(visible)
    const card = frames[0]
    // In "both" mode the second frame is the phone: its own engine, its own
    // capture, and no omnibar docked on it.
    const phone = frames[1]
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
      // Matches the live look: flush square top under the omnibar, rounded bottom
      // (the page's real corners since 1.0.9).
      borderRadius: card ? '0 0 10px 10px' : '0',
      pointerEvents: 'none'
    })
    const img = document.createElement('img')
    img.src = `data:image/png;base64,${shot}`
    Object.assign(img.style, {
      display: 'block',
      width: `${w}px`,
      height: `${h}px`,
      objectFit: 'fill'
    })
    clip.appendChild(img)
    host.appendChild(clip)

    if (phone && twinShot) {
      const pr = phone.getBoundingClientRect()
      const pclip = document.createElement('div')
      pclip.className = '__shot_overlay'
      Object.assign(pclip.style, {
        position: 'absolute',
        left: `${pr.left - hostRect.left}px`,
        top: `${pr.top - hostRect.top}px`,
        width: `${pr.width}px`,
        height: `${pr.height}px`,
        overflow: 'hidden',
        borderRadius: '14px',
        pointerEvents: 'none'
      })
      const pimg = document.createElement('img')
      pimg.src = `data:image/png;base64,${twinShot}`
      Object.assign(pimg.style, {
        display: 'block',
        width: `${pr.width}px`,
        height: `${pr.height}px`,
        objectFit: 'fill'
      })
      pclip.appendChild(pimg)
      host.appendChild(pclip)
    }
    return 'placed'
  },
  { shot, twinShot, CARD_OMNIBAR_H }
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
