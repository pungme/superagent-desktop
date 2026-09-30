// Plays the opening of the reel live, as Superagent's first-run intro.
//
// reel.js is deterministic — renderAt(t) draws any moment exactly — so the
// clock here is the soundtrack's own: every cut, pop and camera bump lands on
// the beat it was written to, however the frames happen to fall. It ends on
// the reel's zoom into the mark (the flash at 7.5 s) and tells the app.

const END = 7.5 // T(5): the flash as the camera flies into the mark
const stage = document.getElementById('stage')
const music = document.getElementById('music')
const skip = document.getElementById('skip')
let done = false

// The 1920×1080 stage, scaled to cover the window like a video would.
function fit() {
  const s = Math.max(innerWidth / 1920, innerHeight / 1080)
  const x = (innerWidth - 1920 * s) / 2
  const y = (innerHeight - 1080 * s) / 2
  stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`
}
addEventListener('resize', fit)
fit()

function finish(skipped) {
  if (done) return
  done = true
  // The music trails off rather than stopping dead.
  const v0 = music.volume
  const t0 = performance.now()
  const fade = () => {
    const k = Math.min(1, (performance.now() - t0) / 700)
    music.volume = v0 * (1 - k)
    if (k < 1) requestAnimationFrame(fade)
    else music.pause()
  }
  fade()
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
parent.postMessage({ type: 'superagent-intro', ready: true }, '*')
music.volume = 0.8
let clockStart = null
try {
  await music.play()
} catch {
  // No sound allowed: run on the wall clock instead.
  clockStart = performance.now()
}
const now = () => (clockStart === null ? music.currentTime : (performance.now() - clockStart) / 1000)
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
