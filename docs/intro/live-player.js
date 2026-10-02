// Plays the reel live inside the landing page's film overlay (index.html,
// ?live), instead of as a video: drawn at the screen's own resolution, in
// the wide staging or, with ?portrait, the upright one.
//
// reel.js is deterministic — renderAt(t) draws any moment exactly — so this
// only keeps the clock, fits the picture to the frame, and tells the page
// when it has started and when it is over.

const END = window.DURATION || 30
const portrait = new URLSearchParams(location.search).has('portrait')
const W = portrait ? 1080 : 1920, H = portrait ? 1920 : 1080
const tell = (msg) => parent.postMessage({ type: 'superagent-reel', ...msg }, location.origin)

// reel.js lays itself out from measurements of the stage, in stage pixels, so
// nothing is scaled (and nothing shows) until it has built.
document.documentElement.style.visibility = 'hidden'
while (!window.ready) await new Promise((r) => setTimeout(r, 16))

// The picture is fitted whole, as large as it goes, and then the frame around
// it is filled: the backdrops (and the vignette, grain and flash over them)
// are enlarged to cover whatever the screen has left over, above and below or
// to the sides, and the scenes are let run past their 16:9 or 9:16 edge. So it
// fills any screen without cropping what the film says.
//
// It is sized with zoom, not a transform. A transform leaves every layer its
// full 1920×1080 behind the scenes, and a phone's 3× screen multiplies that by
// nine: dozens of such layers ran an iPhone out of memory and Safari closed the
// page. Zoomed, a layer is only as large as it is shown.
const frame = document.getElementById(portrait ? 'pstage' : 'stage')
frame.style.overflow = 'visible'
const scope = portrait ? '#pstage >' : '#stage >'
const backdrops = [...document.querySelectorAll(`${scope} .full, ${scope} #grain, ${scope} #introGlow, #warp`)]
const capfade = document.getElementById('capfade')
const capfadeH = capfade.getBoundingClientRect().height
function fit() {
  const s = Math.min(innerWidth / W, innerHeight / H)
  frame.style.zoom = s
  // lengths on the frame are zoomed too, so its offset is given in its own pixels
  frame.style.left = (innerWidth - W * s) / 2 / s + 'px'
  frame.style.top = (innerHeight - H * s) / 2 / s + 'px'
  const cover = Math.max(innerWidth / (W * s), innerHeight / (H * s)) * 1.02
  for (const el of backdrops) el.style.scale = cover
  // the veil behind the captions reaches the bottom of the screen
  capfade.style.height = capfadeH + (innerHeight / s - H) / 2 + 2 + 'px'
  const side = (innerWidth / s - W) / 2 + 2
  capfade.style.left = -side + 'px'; capfade.style.width = W + side * 2 + 'px'
}
addEventListener('resize', fit)
fit()
window.renderAt(0)
document.documentElement.style.visibility = ''
tell({ started: true })

// The clock only runs while frames are being drawn, so a hidden tab pauses
// the film rather than skipping ahead.
let t = 0, last = performance.now(), done = false
function tick(now) {
  if (done) return
  // the first frame's timestamp can predate `last`; time never runs backwards
  t = Math.min(END, t + Math.max(0, Math.min(0.1, (now - last) / 1000))); last = now
  window.renderAt(t)
  tell({ t })
  if (t >= END) { done = true; tell({ done: true }); return }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
