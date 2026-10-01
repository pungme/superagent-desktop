// Plays the reel live, as Superagent's first-run intro: the opening, the
// mark, then the tour of what the app does.
//
// reel.js is deterministic — renderAt(t) draws any moment exactly — so this
// only keeps the clock: every cut, pop and camera bump lands where it was
// written to, however the frames happen to fall. It plays silently, and ends
// where the tour does — the cut to black at 22.5 s, before the reel's montage
// and its download card, which belong to the ad — and tells the app.

const END = 22.5 // T(13): the tour's last zoom goes to black
const stage = document.getElementById('stage')
const skip = document.getElementById('skip')
let done = false

// The 1920×1080 stage, scaled to cover the window like a video would.
function fit() {
  const s = Math.max(innerWidth / 1920, innerHeight / 1080)
  const x = (innerWidth - 1920 * s) / 2
  const y = (innerHeight - 1080 * s) / 2
  stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`
}
// reel.js lays itself out from measurements of the stage, in stage pixels, so
// the stage stays unscaled (and out of sight) until it has built.
stage.style.visibility = 'hidden'

function finish(skipped) {
  if (done) return
  done = true
  parent.postMessage({ type: 'superagent-intro', done: true, skipped }, '*')
}
skip.addEventListener('click', () => finish(true))
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish(true)
})

async function waitReady() {
  while (!window.ready) await new Promise((r) => setTimeout(r, 16))
}

await waitReady()
addEventListener('resize', fit)
fit()
stage.style.visibility = ''
parent.postMessage({ type: 'superagent-intro', ready: true }, '*')
const clockStart = performance.now()
const now = () => (performance.now() - clockStart) / 1000
function frame() {
  if (done) return
  const t = Math.min(now(), END)
  window.renderAt(t)
  if (t >= END) {
    finish(false)
    return
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
