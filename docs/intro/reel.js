import { T, BEAT, BAR, FPS, DURATION, kickTimes } from './timing.js'

gsap.registerPlugin(CustomEase, MotionPathPlugin, DrawSVGPlugin)
gsap.ticker.lagSmoothing(0)
gsap.config({ force3D: 'auto' })

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const h = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild }
const cam = $('#cam')

// ---------------------------------------------------------------- portrait
// ?portrait re-stages the reel for a phone held upright, 1080×1920. The scenes
// keep their 1920×1080 coordinates; what changes is the frame around them: the
// backdrops turn a quarter to fill it, a second camera (pcam, at the end)
// frames each scene for the narrow screen, and the few things that cannot be
// framed — the lockups, the toggle, the captions — are stacked instead.
const PORTRAIT = new URLSearchParams(location.search).has('portrait')
const stageEl = $('#stage')
if (PORTRAIT) {
  const p = h(`<div id="pstage"></div>`)
  stageEl.before(p)
  for (const sel of ['#bgDark', '#dotsDark', '#introGlow', '#wipeA', '#wipeB', '#paper', '#blobs', '#dots']) p.append($(sel))
  p.append(stageEl)
  for (const sel of ['#capfade', '#caps', '#flash', '#vig', '#grain']) p.append($(sel))
  document.head.append(h(`<style>
    html, body { width: 1080px; height: 1920px; }
    #pstage { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; overflow: hidden; background: var(--dark); }
    #pstage > .full, #pstage > #grain, #pstage > #introGlow, #pstage > #warp { translate: -420px 420px; rotate: 90deg; }
    #pstage > #warp { visibility: hidden; }
    #stage { overflow: visible; background: none; transform-origin: 0 0; }
    #capfade { top: 1260px; width: 1080px; height: 660px; }
    .cap { left: 540px; top: 1500px; }
    .cap .eb { font-size: 21px; margin-bottom: 22px; }
    .cap { font-size: 76px; }
    .cap .hd { font-size: 1em; line-height: 1.12; }
    .cap .hd .g { display: block; }
    .tagline, .slam { text-align: center; }
    .tagline { line-height: 1.2; font-size: 94px; }
    .slam { line-height: 0.98; font-size: 210px; }
    .toggle { width: 450px; height: 470px; margin: -235px 0 0 -225px; }
  </style>`))
}
const CUES = []
const cue = (type, t, o = {}) => CUES.push({ type, t, ...o })
const procs = []
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x))
const lerp = (a, b, k) => a + (b - a) * k
const eio3 = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
const eo3 = (x) => 1 - Math.pow(1 - x, 3)
const ei3 = (x) => x * x * x
const ramp = (t, a, b) => clamp((t - a) / (b - a))
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
const pitch = { C: [72, 76, 79, 84, 88, 91], Am: [69, 72, 76, 81, 84, 88], F: [65, 69, 72, 77, 81, 84], G: [67, 71, 74, 79, 83, 86], Em: [64, 67, 71, 76, 79, 83] }
const charSpans = (s, cls = 'c') => [...s].map((c) => `<span class="${cls}">${c === ' ' ? '&nbsp;' : c}</span>`).join('')
const maskWords = (s) => s.split(' ').map((w) => `<span class="mask"><span class="wi">${w}</span></span>`).join(' ')

const tl = gsap.timeline({ paused: true, defaults: { ease: 'expo.out', duration: 0.6 } })
const show = (el, t) => tl.set(el, { visibility: 'visible' }, t)
const hide = (el, t) => tl.set(el, { visibility: 'hidden' }, t)

CustomEase.create('snap', 'M0,0 C0.14,0 0.14,1 1,1')
CustomEase.create('whip', 'M0,0 C0.6,0 0.8,0.2 1,1')
CustomEase.create('land', 'M0,0 C0.25,0.1 0.3,1.28 0.55,1.02 0.7,0.96 0.84,1 1,1')

// ---------------------------------------------------------------- icons
const P = {
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M11 18h2"/>',
  max: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  reload: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  out: '<path d="M7 17 17 7M7 7h10v10"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  spark: '<path d="M12 3l1.9 5.8L20 10.5l-6.1 1.4L12 18l-1.9-6.1L4 10.5l6.1-1.7z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  todo: '<rect x="3" y="4" width="6" height="6" rx="1"/><rect x="3" y="14" width="6" height="6" rx="1"/><path d="M13 7h8M13 17h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  term: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  wifi: '<path d="M2 8.8a15 15 0 0 1 20 0M5 12.9a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>'
}
const I = (n, st = '') => `<svg class="i" viewBox="0 0 24 24" style="${st}">${P[n]}</svg>`
const CLAUDE = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
const CODEX = 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z'
const APPLE = 'M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z'
const claudeSvg = (s, st = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}"><path fill="#D97757" d="${CLAUDE}"/></svg>`
const codexSvg = (s, col = 'currentColor', st = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}"><path fill="${col}" fill-rule="evenodd" clip-rule="evenodd" d="${CODEX}"/></svg>`
const GEMINI = 'M12 0C12 6.63 17.37 12 24 12 17.37 12 12 17.37 12 24 12 17.37 6.63 12 0 12 6.63 12 12 6.63 12 0Z'
let gemN = 0
const geminiSvg = (s, st = '') => { const id = `gem${gemN++}`; return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}"><defs><linearGradient id="${id}" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4285F4"/><stop offset=".55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs><path fill="url(#${id})" d="${GEMINI}"/></svg>` }
const appleSvg = (s, col = '#fff') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path fill="${col}" d="${APPLE}"/></svg>`
const pointer = `<svg class="ptr" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.3 3 6.6 3-1.4-3-6.4h6.3z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`
const agentEl = (label = 'Claude') => h(`<div class="agent">${pointer}<div class="tag">${claudeSvg(13, 'filter:brightness(0) invert(1)')}${label}</div></div>`)

// ---------------------------------------------------------------- nimbus page (em-based)
function nimbusDesktop() {
  const cards = [['📍', 'Hyper-local forecasts', 'Street-level precision, updated every five minutes.'], ['⚡', 'Instant rain alerts', 'A heads-up before the first drop, so you are never caught out.'], ['🧥', 'What-to-wear advice', 'Plain language: light jacket, sunscreen, or stay in.']]
  return h(`<div class="nim">
    <div class="hero"></div>
    <div class="brand">☁ NIMBUS</div>
    <div class="h1"><span class="w">Weather</span> <span class="w">that</span> <span class="w">gets</span><br><span class="w">to</span> <span class="w">the</span> <span class="w">point.</span></div>
    <div class="sub">Hyper-local forecasts, minute-by-minute rain alerts, and a clean design that tells you what to wear.</div>
    <div class="btn">Download Nimbus — Free</div>
    ${cards.map((c, i) => `<div class="card" style="left:${9.5 + i * 17.2}em"><span class="em">${c[0]}</span><h4>${c[1]}</h4><p>${c[2]}</p></div>`).join('')}
  </div>`)
}
function nimbusMobile() {
  const cards = [['📍', 'Hyper-local forecasts', 'Street-level precision, every five minutes.'], ['⚡', 'Instant rain alerts', 'A heads-up before the first drop.'], ['🧥', 'What-to-wear advice', 'Light jacket, sunscreen, or cocoa.']]
  const n = h(`<div class="nim" style="font-size:9px">
    <div class="hero" style="height:47em"></div>
    <div class="brand" style="top:7.5em">☁ NIMBUS</div>
    <div class="h1" style="top:4.2em;font-size:3.2em;padding:0 .6em">Weather that gets to the point.</div>
    <div class="sub" style="top:27.5em;left:9%;width:82%">Hyper-local forecasts, rain alerts, and what to wear.</div>
    <div class="btn" style="top:35em">Download Nimbus — Free</div>
    ${cards.map((c, i) => `<div class="card" style="left:2.2em;width:31.6em;height:10.4em;top:${43 + i * 11.8}em;padding:1.3em 1.5em"><span class="em">${c[0]}</span><h4 style="margin-top:.5em">${c[1]}</h4><p style="margin-top:.35em">${c[2]}</p></div>`).join('')}
  </div>`)
  return n
}

// ================================================================= BUILD
// Everything below is laid out from measured text, so the fonts have to be in
// first. fonts.ready alone is not enough: nothing has asked for them yet, so it
// resolves at once and the measuring is done in the fallback face.
await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})))
await document.fonts.ready
await Promise.all([...document.images].map((i) => i.decode().catch(() => {})))

// ---------------------------------------------------------------- SCENE 1: intro
const sIntro = h(`<div class="scene" id="sIntro"></div>`); cam.append(sIntro)
const text1 = 'Hello.'
const words2List = ['Welcome', 'home.']
// upright, the line breaks after "lives" and is set larger
// a long line is set smaller, and upright it breaks in two at the space nearest its middle
const longLine = text1.length > 20
const breakAt = longLine ? text1.indexOf(' ', Math.floor(text1.length / 2)) + 1 : 0
const rowsDef = PORTRAIT && breakAt ? [[0, breakAt, -72], [breakAt, text1.length, 72]] : [[0, text1.length, 0]]
const typeRows = rowsDef.map(([a, b]) => h(`<div class="type-line" style="font-size:${PORTRAIT ? (longLine ? 116 : 190) : longLine ? 94 : 132}px">${charSpans(text1.slice(a, b))}</div>`))
const line1 = typeRows[0]
// upright, two words stand one over the other, set large
const stack2 = PORTRAIT && words2List.length === 2
const line2 = h(`<div class="type-line" style="font-weight:680;${stack2 ? 'font-size:196px;text-align:center;line-height:1.04' : 'font-size:132px'}">${words2List.map((w) => `<span class="w">${charSpans(w)}</span>`).join(stack2 ? '<br>' : '<span class="c">&nbsp;</span>')}</div>`)
const cursorSq = h(`<div id="cursorSq"></div>`)
sIntro.append(...typeRows, line2, cursorSq)
gsap.set([...typeRows, line2], { yPercent: -50 })
// measure
const c1 = typeRows.flatMap((r) => $$('.c', r))
const w1 = c1.map((c) => c.getBoundingClientRect().width)
if (rowsDef.length > 1) w1[breakAt - 1] = 0 // the space the line breaks on
// a long line rattles out; a short one is typed a key at a time
const tc = c1.map((_, i) => T(1, 1.5) + i * BEAT / (longLine ? 12 : 4))
const l2w = line2.getBoundingClientRect().width
gsap.set(line2, { x: -l2w / 2 })
const words2 = $$('.w', line2)
const wRight = words2.map((w) => w.getBoundingClientRect().right)
const wMid = words2.map((w) => { const r = w.getBoundingClientRect(); return stack2 ? r.top + r.height / 2 : 540 })
const c2rects = $$('.c', line2).map((c) => c.getBoundingClientRect())
const nW = words2List.length
const tw2 = nW <= 2 ? [T(2, 1), T(2, 2)].slice(0, nW) : [T(2, 1), T(2, 1.5), T(2, 2), T(2, 2.5)].slice(0, nW)
gsap.set(c1, { opacity: 0 })
c1.forEach((c, i) => {
  tl.fromTo(c, { opacity: 0, y: 26, scale: 0.7 }, { opacity: 1, y: 0, scale: 1, duration: 0.22, ease: 'back.out(3)' }, tc[i])
  if (text1[i] !== ' ') cue('tick', tc[i], { vel: 0.55 })
})
// line 1 leaves on the bar line
tl.to(c1, { yPercent: -130, opacity: 0, rotationX: -70, duration: 0.2, ease: 'power3.in', stagger: 0.004, immediateRender: false }, T(2) - 0.24)
gsap.set(words2, { opacity: 0 })
words2.forEach((w, i) => {
  tl.fromTo(w, { opacity: 0, scale: 2.1, filter: 'blur(14px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.24, ease: 'expo.out' }, tw2[i])
})
// the words get sucked into the cursor
const c2 = $$('.c', line2)
const suckT = T(2, 3.75)
c2.forEach((c, i) => {
  const r = c2rects[i]
  const cx = r.left + r.width / 2, cy = stack2 ? r.top + r.height / 2 : 540
  const d = Math.abs(cx - 960)
  tl.to(c, { x: 960 - cx, y: 540 - cy - 10, scale: 0.05, rotation: (hash(i) - 0.5) * 120, opacity: 0, duration: 0.3, ease: 'power3.in' }, suckT + (1 - d / 900) * 0.1 + hash(i + 9) * 0.04)
})
hide(sIntro, T(3))
show(sIntro, 0)
// cursor + centring are procedural
const sPulse = (t, times, amp, tau = 0.08) => { let v = 0; for (const b of times) if (t >= b) v = Math.max(v, amp * Math.exp(-(t - b) / tau)); return v }
const beatTimes = []; for (let b = 0; b < 8; b++) beatTimes.push(b * BEAT)
const roll16 = []; for (let i = 0; i < 6; i++) roll16.push(T(2, 3) + i * BEAT / 4)
procs.push((t) => {
  if (t >= T(3)) return
  // line 1 centring: smooth width, a row at a time; the cursor sits on the row being typed
  const gap = 26, cw = 52
  let typedX = 0, typedY = 540 - 26 - 4
  rowsDef.forEach(([a, b, dy], r) => {
    let W = 0, Wd = 0
    for (let i = a; i < b; i++) { if (t >= tc[i]) { W += w1[i] * (1 - Math.exp(-(t - tc[i]) / 0.07)); Wd += w1[i] * (1 - Math.exp(-(t - tc[i]) / 0.012)) } }
    const last = r === rowsDef.length - 1
    // a row gives up the cursor's room as the next one starts
    const share = last ? 1 : 1 - eo3(ramp(t, tc[b], tc[b] + 0.14))
    const left = 960 - (W + (gap + cw) * share) / 2
    typeRows[r].style.transform = `translate(${left - 960}px, calc(-50% + ${dy}px))`
    if (last || t < tc[b]) { if (r === 0 || t >= tc[a]) { typedX = left + Wd + gap; typedY = 540 + dy - 26 - 4 } }
  })
  let x, y = typedY, s = 1, sx = 1, sy = 1, rot = 0
  if (t < T(2) - 0.1) {
    x = typedX
    s = t < 0.25 ? gsap.parseEase('back.out(3)')(clamp(t / 0.25)) : 1
    s += sPulse(t, beatTimes, 0.14)
  } else if (t < T(2, 3.75)) {
    let k = 0; for (let i = 0; i < nW; i++) if (t >= tw2[i]) k = i
    const tx = wRight[k] + 22
    const kk = t < tw2[0] ? eo3(ramp(t, T(2) - 0.1, T(2))) : 1
    x = lerp(typedX, tx, kk)
    y = lerp(typedY, wMid[k] - 26 - 8, kk)
    s = 1.12 + sPulse(t, tw2, 0.3, 0.07) + sPulse(t, roll16, 0.12, 0.05) + ramp(t, T(2, 3), T(2, 3.75)) * 0.25
    if (t > T(2, 3)) { const a = ramp(t, T(2, 3), T(2, 3.75)) * 5; x += (hash(Math.floor(t * 60)) - 0.5) * a; y += (hash(Math.floor(t * 60) + 3) - 0.5) * a }
  } else {
    const x0 = wRight[nW - 1] + 22
    const k = eio3(ramp(t, T(2, 3.75), T(2, 4.5)))
    x = lerp(x0, 960 - 26, k); y = lerp(wMid[nW - 1] - 34, 540 - 26, k)
    s = lerp(1.37, 1.6, k) + sPulse(t, roll16, 0.12, 0.05)
    const a = ramp(t, T(2, 4.5), T(3))
    if (a > 0) {
      const e = eo3(a)
      sx = 1 + 0.32 * e; sy = 1 - 0.28 * e; s = lerp(1.6, 1.25, e)
      const j = 2 + 6 * a; x += (hash(Math.floor(t * 120)) - 0.5) * j; y += (hash(Math.floor(t * 120) + 5) - 0.5) * j
    }
  }
  cursorSq.style.transform = `translate(${x}px, ${y}px) scale(${s * sx}, ${s * sy}) rotate(${rot}deg)`
  // line 2 tension shake
  if (t > T(2, 3) && t < T(3)) {
    const a = ramp(t, T(2, 3), T(2, 4)) * 7
    line2.style.translate = `${(hash(Math.floor(t * 60) + 11) - 0.5) * a}px ${(hash(Math.floor(t * 60) + 17) - 0.5) * a}px`
  } else line2.style.translate = '0px 0px'
  $('#introGlow').style.opacity = 0.5 + 0.5 * sPulse(t, beatTimes, 1, 0.2)
})
tl.set('#introGlow', { opacity: 0.6 }, 0)
tl.to('#dotsDark', { backgroundPosition: '0px -68px', duration: T(3), ease: 'none' }, 0)

// ---------------------------------------------------------------- logo builder
function makeLogo() {
  return h(`<div class="logo"><div class="tile"><div class="sheen"></div></div><div class="inner"></div></div>`)
}

// ---------------------------------------------------------------- SCENE 2: logo reveal
const sLogo = h(`<div class="scene" id="sLogo"></div>`); cam.append(sLogo)
const ring1 = h(`<div class="ring"></div>`), ring2 = h(`<div class="ring"></div>`)
const logo = makeLogo()
const word = h(`<div class="wordmark">${[...'Superagent'].map((c) => `<span class="mask"><span class="c">${c}</span></span>`).join('')}</div>`)
const kanaStr = 'スーパーエージェント'
const kana = h(`<div class="kana">${charSpans(kanaStr)}</div>`)
const tagline = h(`<div class="tagline"><span class="mask"><span class="wi">A</span></span> <span class="mask"><span class="wi">beautiful</span></span> <span style="position:relative;display:inline-block"><span class="mask"><span class="wi g">home</span></span><span class="uline" style="bottom:-0.02em"></span></span>${PORTRAIT ? '<br>' : ' '}<span class="mask"><span class="wi">for</span></span> <span class="mask"><span class="wi">your</span></span> <span class="mask"><span class="wi">agent.</span></span></div>`)
sLogo.append(ring1, ring2, logo, word, kana, tagline)
const wordW = word.getBoundingClientRect().width
const lockW = 300 + 64 + wordW
const lockL = 960 - lockW / 2
// upright, the lockup stacks: mark, name, kana, tagline on two lines
const LX = PORTRAIT ? 960 : lockL + 150, LY = PORTRAIT ? 300 : 440
const kanaW = kana.getBoundingClientRect().width
if (PORTRAIT) {
  gsap.set(word, { x: 960 - wordW / 2, y: 490 })
  gsap.set(kana, { x: 960 - kanaW / 2 + 10, y: 690 })
  gsap.set(tagline, { x: 960, xPercent: -50, y: 800 })
} else {
  gsap.set(word, { x: lockL + 364, y: LY - 96 })
  gsap.set(kana, { x: lockL + 372, y: LY + 88 })
  gsap.set(tagline, { x: 960, xPercent: -50, y: 690 })
}
gsap.set([logo, ring1, ring2], { xPercent: -50, yPercent: -50, x: 960, y: 540 })
show(sLogo, T(3)); hide(sLogo, T(5))
const t3 = T(3)
// colour wipes (dark → blush → gold → paper)
tl.fromTo('#wipeA', { clipPath: 'circle(0px at 960px 540px)' }, { clipPath: 'circle(1200px at 960px 540px)', duration: 0.7, ease: 'expo.out' }, t3)
tl.fromTo('#wipeB', { clipPath: 'circle(0px at 960px 540px)' }, { clipPath: 'circle(1200px at 960px 540px)', duration: 0.7, ease: 'expo.out' }, t3 + 0.05)
tl.fromTo('#paper', { clipPath: 'circle(0px at 960px 540px)' }, { clipPath: 'circle(1200px at 960px 540px)', duration: 0.75, ease: 'expo.out' }, t3 + 0.1)
tl.set(['#bgDark', '#dotsDark', '#introGlow', '#wipeA', '#wipeB'], { visibility: 'hidden' }, t3 + 0.9)
tl.to('#blobs', { opacity: 0.9, duration: 1.2, ease: 'power2.out' }, t3 + 0.2)
tl.to('#dots', { opacity: 0.55, duration: 1.0, ease: 'power2.out' }, t3 + 0.3)
tl.fromTo($('.tile', logo), { scale: 0, rotation: -35 }, { scale: 1, rotation: 0, duration: 1.1, ease: 'elastic.out(1.1, 0.42)' }, t3)
tl.fromTo($('.inner', logo), { scale: 0.8, borderRadius: 13 }, { scale: 1, borderRadius: 25, duration: 0.6, ease: 'back.out(4)' }, t3)
tl.fromTo(ring1, { scale: 0.95, opacity: 0.9 }, { scale: 2.8, opacity: 0, duration: 1.1, ease: 'expo.out' }, t3)
tl.fromTo(ring2, { scale: 0.95, opacity: 0.6, borderWidth: 8 }, { scale: 4.2, opacity: 0, borderWidth: 1, duration: 1.4, ease: 'expo.out' }, t3 + 0.08)
// logo slides left, wordmark types up
tl.to(logo, { x: LX, y: LY, duration: 0.7, ease: 'expo.inOut' }, T(3, 1.8))
tl.fromTo($$('.c', word), { yPercent: 118, rotation: 14 }, { yPercent: 0, rotation: 0, duration: 0.75, ease: 'expo.out', stagger: 0.032 }, T(3, 2.35))
$$('.c', word).forEach((_, i) => cue('tick', T(3, 2.35) + i * 0.032, { vel: 0.35 }))
tl.fromTo($('.sheen', logo), { xPercent: 0 }, { xPercent: 520, duration: 0.8, ease: 'power2.inOut' }, T(3, 3))
cue('shine', T(3, 3))
// kana scramble (procedural)
const kanaCh = $$('.c', kana)
const KSET = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン'
const scramble = (els, str, t0, stepIn, stepSettle) => procs.push((t) => {
  els.forEach((el, i) => {
    const a = t0 + i * stepIn, s = t0 + 0.14 + i * stepSettle
    if (t < a) { el.style.opacity = 0; return }
    el.style.opacity = 1
    el.textContent = t >= s ? str[i] : KSET[Math.floor(hash(i * 31 + Math.floor(t * 30)) * KSET.length)]
    el.style.color = t >= s ? '' : '#c2c4bc'
  })
})
scramble(kanaCh, kanaStr, T(3, 3.2), 0.02, 0.045)
kanaCh.forEach((_, i) => cue('tick', T(3, 3.2) + 0.14 + i * 0.045, { vel: 0.3 }))
// tagline
const tagW = $$('.wi', tagline)
tagW.forEach((w, i) => {
  tl.fromTo(w, { yPercent: 110 }, { yPercent: 0, duration: 0.6, ease: 'expo.out' }, T(4, i * 0.5))
  cue('pop', T(4, i * 0.5), { midi: pitch.F[i % 6], vel: 0.5, pan: (i - 2) * 0.2 })
})
tl.to($('.uline', tagline), { scaleX: 1, duration: 0.45, ease: 'expo.out' }, T(4, 3.5))
cue('shine', T(4, 3.5), { vel: 0.6 })
// zoom into the mark (match cut into the app)
tl.to([...$$('.c', word)].reverse(), { yPercent: -120, duration: 0.3, ease: 'power3.in', stagger: 0.015 }, T(4, 3.5))
tl.to(kana, { opacity: 0, y: '-=20', duration: 0.25, ease: 'power2.in' }, T(4, 3.6))
tl.to(tagW, { yPercent: 110, duration: 0.28, ease: 'power3.in', stagger: 0.03 }, T(4, 3.6))
tl.to($('.uline', tagline), { scaleX: 0, transformOrigin: '100% 50%', duration: 0.25, ease: 'power3.in' }, T(4, 3.6))
tl.to(logo, { x: 960, y: 540, duration: 0.45, ease: 'power3.inOut' }, T(4, 3.75))
tl.to(logo, { scale: 30, duration: 0.62, ease: 'expo.in' }, T(5) - 0.62)
tl.to($('.tile', logo), { rotation: 6, duration: 0.62, ease: 'power2.in' }, T(5) - 0.62)
cue('whoosh', T(5) - 0.02, { len: 0.9, vel: 1 })
tl.fromTo('#flash', { opacity: 0 }, { opacity: 1, duration: 0.08, ease: 'none' }, T(5) - 0.08)
tl.to('#flash', { opacity: 0, duration: 0.45, ease: 'power2.out' }, T(5))

// ---------------------------------------------------------------- SCENE 3: app window
const sApp = h(`<div class="scene" id="sApp"></div>`); cam.append(sApp)
const win = h(`<div class="win">
  <div class="base"></div>
  <div class="layer side">
    <div class="lights"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span></div>
  </div>
  <div class="layer topbar"></div>
  <div class="layer pane"></div>
  <div class="layer chat"></div>
</div>`)
sApp.append(win)
const side = $('.side', win), topbar = $('.topbar', win), pane = $('.pane', win), chat = $('.chat', win)
const rows = [
  ['sec', 70, 'MY PROJECTS'],
  ['row', 92, 'whitescreen.online', `<div class="fav" style="background:#e5484d">${I('monitor', 'font-size:12px;color:#fff')}</div>`],
  ['sec', 152, 'BROWSING'],
  ['row', 174, 'en.wikipedia.org', `<div class="fav" style="background:#fff;color:#111;font-family:Georgia,serif;font-weight:400;font-size:15px;box-shadow:0 0 0 1px rgba(0,0,0,.12)">W</div>`],
  ['row', 214, 'news.ycombinator.com', `<div class="fav" style="background:#f26522">Y</div>`],
  ['sec', 274, 'WORK'],
  ['row', 296, 'mobile-app', null, true],
  ['row', 336, 'landing-page', null, true],
  ['sub', 376, 'Nimbus weather app landing…', 'dot'],
  ['sub', 406, 'Tighten the hero copy', 'spin'],
  ['row', 440, 'design-system', null, true],
  ['row', 480, 'notes-app', null, true],
  ['sec', 540, 'PERSONAL'],
  ['row', 562, 'shop-web', null, true]
]
const activeBg = h(`<div class="activebg" style="top:336px"></div>`)
side.append(activeBg)
const rowEls = rows.map(([k, y, label, icon, branch]) => {
  let el
  if (k === 'sec') el = h(`<div class="sec" style="top:${y}px">${I('down')}<span>${label}</span></div>`)
  else if (k === 'row') el = h(`<div class="row" style="top:${y}px"><span class="dot"></span><span class="ic">${icon || I('folder', 'font-size:19px')}</span><span class="lbl">${label}</span>${branch ? `<span class="pill">${I('branch', 'font-size:11px')}main</span>` : ''}</div>`)
  else el = h(`<div class="row sub" style="top:${y}px"><span class="lbl">${label}</span>${icon === 'spin' ? '<span class="spinner" style="margin-left:auto;width:13px;height:13px"></span>' : '<span style="margin-left:auto;width:8px;height:8px;border-radius:50%;background:#5b8ff0"></span>'}</div>`)
  side.append(el); return el
})
side.append(h(`<div class="sec" style="top:786px;letter-spacing:0;font-size:15px;font-weight:500;color:#8e8f95">+ New group</div>`))
topbar.innerHTML = `<span class="tpill">${I('file')}Files</span><b style="font-size:17px;font-weight:650">landing-page</b><span style="color:#9a9ba1;font-size:14px" class="path">~/work/landing-page</span><span class="tpill">${I('branch')}main</span><span style="flex:1"></span><span class="tpill">${I('clock')}Routines</span><span class="tpill">${I('spark')}Skills</span>`
const tbItems = [...topbar.children].filter((e) => !(e.style.flex))
// browser card inside pane
const bcard = h(`<div class="bcard">
  <div class="chrome"><span>${I('left')}</span><span>${I('right')}</span><span>${I('reload')}</span>
    <div class="url"><span class="urltext"></span></div>
    <span class="ico-desk" style="color:#333">${I('monitor')}</span><span class="ico-phone">${I('phone')}</span><span>${I('max')}</span><span>${I('out')}</span><span>${I('x')}</span></div>
  <div class="vp"></div>
</div>`)
pane.append(bcard)
const vp = $('.vp', bcard)
const skels = [[40, 40, 300, 22], [40, 80, 520, 14], [40, 104, 460, 14], [40, 150, 180, 40], [40, 230, 180, 150], [250, 230, 180, 150], [460, 230, 180, 150]].map(([x, y, w, hh]) => { const s = h(`<div class="skel" style="left:${x}px;top:${y}px;width:${w}px;height:${hh}px"></div>`); vp.append(s); return s })
const nimD = nimbusDesktop(); nimD.style.fontSize = '10px'; vp.append(nimD)
const agent1 = agentEl(); bcard.append(agent1)
const ripple1 = h(`<div class="ripple"></div>`); bcard.append(ripple1)
// chat column
chat.append(h(`<div class="tpill" style="position:absolute;right:18px;top:16px">${I('pencil')}New chat</div>`))
const ub = h(`<div class="bub user" style="top:66px">Build a landing page for Nimbus, a weather app, then open it in the preview.</div>`)
const bb1 = h(`<div class="bub bot" style="top:180px">I'll build Nimbus, then open it in the browser.</div>`)
const typing = h(`<div class="bub bot" style="top:180px;width:74px;height:44px;display:flex;gap:6px;align-items:center;justify-content:center">${'<i style="width:7px;height:7px;border-radius:50%;background:#9a9ba0;display:block"></i>'.repeat(3)}</div>`)
const steps = h(`<div class="steps" style="top:262px">${['›', '3 steps', '·', '1 edit', '', 'navigate', '·', 'screenshot'].map((s, i) => `<span class="k" style="${i >= 5 ? 'font-family:SFMono;font-size:12px;color:#9a9ba0' : ''}">${s}</span>`).join('')}</div>`)
const bb2 = h(`<div class="bub bot" style="top:298px">Done — a blue hero, three feature cards and a footer. It's open in the preview.</div>`)
const composer = h(`<div class="composer">Message Claude…<span style="margin-left:auto;color:#9a9ba0">${I('mic')}</span><span class="sendb" style="margin-left:0">${I('up')}</span></div>`)
const cpills = h(`<div class="cpills"><span class="cpill">Model <b>Opus</b>${I('down', 'font-size:11px')}</span><span class="cpill">Mode <b>Full</b>${I('down', 'font-size:11px')}</span></div>`)
chat.append(ub, typing, bb1, steps, bb2, composer, cpills)

show(sApp, T(5)); hide(sApp, T(9))
gsap.set([sApp, side, chat], { filter: 'blur(0px)' })
const t5 = T(5)
gsap.set(win, { transformOrigin: '50% 50%', transformPerspective: 0 })
// pull back out of the white, into an exploded 3-D view
tl.fromTo(win, { scale: 2.7, rotationX: 0, rotationY: 0, rotationZ: 0, x: 0, y: 30 }, { scale: 1.08, rotationX: 20, rotationY: -24, rotationZ: 4, x: 230, y: 40, duration: 1.0, ease: 'expo.out' }, t5)
tl.to(win, { scale: 1.75, rotationX: 14, rotationY: -17, rotationZ: 2.5, x: 700, y: 300, duration: T(6, 1) - (t5 + 1.0) + 0.1, ease: 'sine.inOut' }, t5 + 1.0)
// sweep across to the chat
tl.to(win, { scale: 1.4, rotationX: 9, rotationY: 13, rotationZ: -1.5, x: -470, y: 150, duration: BEAT * 1.8, ease: 'expo.inOut' }, T(6, 1) - 0.25)
tl.to(win, { scale: 1.3, rotationY: 9, x: -420, y: 120, duration: BEAT * 1.5, ease: 'sine.inOut' }, T(6, 1) - 0.25 + BEAT * 1.8)
cue('whoosh', T(6, 1) + 0.25, { len: 0.7, vel: 0.5, pan: 0.6 })
const lift = '0 40px 60px -24px rgba(30,40,60,.42)'
tl.fromTo([side, chat, bcard], { boxShadow: '0 0px 0px 0px rgba(30,40,60,0)' }, { boxShadow: lift, duration: 1.0, ease: 'expo.out' }, t5 + 0.1)
tl.to([side, chat], { boxShadow: '0 0px 0px 0px rgba(30,40,60,0)', duration: 0.6, ease: 'power2.inOut' }, T(7) - 0.5)
tl.fromTo(side, { z: 0 }, { z: 90, duration: 1.1, ease: 'expo.out' }, t5 + 0.1)
tl.fromTo(chat, { z: 0 }, { z: 150, duration: 1.1, ease: 'expo.out' }, t5 + 0.15)
tl.fromTo(topbar, { z: 0 }, { z: 45, duration: 1.1, ease: 'expo.out' }, t5 + 0.1)
tl.fromTo(bcard, { z: 0 }, { z: 70, duration: 1.1, ease: 'expo.out' }, t5 + 0.1)
// traffic lights
$$('.lights span', win).forEach((l, i) => {
  tl.fromTo(l, { scale: 0 }, { scale: 1, duration: 0.5, ease: 'elastic.out(1.2,0.4)' }, T(5, 1.5 + i * 0.25))
  cue('pop', T(5, 1.5 + i * 0.25), { midi: pitch.C[i], vel: 0.55, pan: -0.5 })
})
// sidebar cascade
rowEls.forEach((el, i) => {
  const t = T(5, 2) + i * (BEAT / 4) * 0.72
  tl.fromTo(el, { x: -50, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: 'expo.out' }, t)
  const ic = $('.ic', el) || $('.dot', el)
  if (ic) tl.fromTo(ic, { scale: 0, rotation: -40 }, { scale: 1, rotation: 0, duration: 0.55, ease: 'back.out(3.5)' }, t + 0.04)
  const pl = $('.pill', el); if (pl) tl.fromTo(pl, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(3)' }, t + 0.1)
  if (el.classList.contains('row')) cue('pop', t, { midi: pitch.C[(i % 5) + 1], vel: 0.35, pan: -0.4 })
})
tl.fromTo(activeBg, { scaleX: 0, opacity: 0, transformOrigin: '0% 50%' }, { scaleX: 1, opacity: 1, duration: 0.5, ease: 'expo.out' }, T(5, 4.5))
cue('click', T(5, 4.5), { vel: 0.5 })
// topbar
tbItems.forEach((el, i) => {
  tl.fromTo(el, { y: -18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'back.out(2.5)' }, T(5, 3) + i * 0.06)
})
// browser chrome + skeletons
tl.fromTo(bcard, { opacity: 0, scale: 0.9, y: 30 }, { opacity: 1, scale: 1, y: 0, duration: 0.7, ease: 'expo.out' }, T(5, 3.5))
tl.fromTo(skels, { scaleX: 0, transformOrigin: '0% 50%' }, { scaleX: 1, duration: 0.5, stagger: 0.05, ease: 'expo.out' }, T(5, 4))
procs.push((t) => { const k = 0.55 + 0.45 * Math.sin(t * 7); skels.forEach((s, i) => (s.style.background = `hsl(240,8%,${90 + 3 * Math.sin(t * 6 - i * 0.6)}%)`)) })
// url types
const urlTxt = $('.urltext', bcard)
const URL1 = 'localhost:5173'
procs.push((t) => {
  const a = T(6, 3.5), n = clamp(Math.floor((t - a) / (BEAT / 8)), 0, URL1.length)
  urlTxt.textContent = t < a ? '' : URL1.slice(0, n)
})
for (let i = 0; i < URL1.length; i++) cue('tick', T(6, 3.5) + i * BEAT / 8, { vel: 0.3 })
// chat bubbles
tl.fromTo(ub, { scale: 0.5, opacity: 0, y: 40 }, { scale: 1, opacity: 1, y: 0, duration: 0.7, ease: 'back.out(1.8)' }, T(6, 1))
cue('whoosh', T(6, 1), { len: 0.3, vel: 0.4, pan: 0.5 }); cue('pop', T(6, 1), { midi: 79, vel: 0.6, pan: 0.4 })
tl.fromTo(typing, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(3)' }, T(6, 1.75))
$$('i', typing).forEach((d, i) => tl.fromTo(d, { y: 0 }, { y: -6, duration: 0.12, ease: 'sine.out', yoyo: true, repeat: 3 }, T(6, 1.8) + i * 0.07))
tl.to(typing, { scale: 0, opacity: 0, duration: 0.15, ease: 'power2.in' }, T(6, 2.5) - 0.15)
tl.fromTo(bb1, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: 'back.out(2)' }, T(6, 2.5))
cue('pop', T(6, 2.5), { midi: 83, vel: 0.5, pan: 0.4 })
$$('.k', steps).forEach((k, i) => {
  tl.fromTo(k, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: 'back.out(3)' }, T(6, 3) + i * BEAT / 8)
  if (k.textContent.trim().length > 1) cue('tick', T(6, 3) + i * BEAT / 8, { vel: 0.35 })
})
tl.fromTo(composer, { y: 70, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: 'expo.out' }, T(6, 3.5))
tl.fromTo($$('.cpill', cpills), { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'back.out(2.5)', stagger: 0.07 }, T(6, 3.75))
gsap.set(bb2, { opacity: 0 })
// flatten + push into the browser (lands on bar 7)
tl.to(win, { scale: 1.42, rotationX: 0, rotationY: 0, rotationZ: 0, x: 78, y: 24, duration: 0.85, ease: 'expo.inOut' }, T(7) - 0.62)
tl.to([side, chat, topbar, bcard], { z: 0, duration: 0.85, ease: 'expo.inOut' }, T(7) - 0.62)
tl.to([side, chat], { filter: 'blur(3px)', duration: 0.6, ease: 'power2.out' }, T(7))
cue('whoosh', T(7) - 0.05, { len: 0.6, vel: 0.7 })

// ---------------------------------------------------------------- SCENE 4: the agent builds Nimbus
const t7 = T(7)
tl.to(skels, { opacity: 0, duration: 0.2, ease: 'none' }, t7)
const nh = $('.hero', nimD), nbrand = $('.brand', nimD), nwords = $$('.h1 .w', nimD), nsub = $('.sub', nimD), nbtn = $('.btn', nimD), ncards = $$('.card', nimD)
gsap.set(nimD, { opacity: 0 })
tl.set(nimD, { opacity: 1 }, t7)
tl.fromTo(nh, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.5, ease: 'expo.out' }, t7)
cue('whoosh', t7 + 0.05, { len: 0.3, vel: 0.35 })
tl.fromTo(nbrand, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(3)' }, T(7, 1.5))
cue('pop', T(7, 1.5), { midi: 81, vel: 0.5 })
nwords.forEach((w, i) => {
  const t = T(7, 2 + i * 0.25)
  tl.fromTo(w, { y: -60, opacity: 0, rotation: (i % 2 ? 8 : -8), scale: 1.4 }, { y: 0, opacity: 1, rotation: 0, scale: 1, duration: 0.5, ease: 'back.out(2.2)' }, t)
  cue('pop', t, { midi: pitch.Am[i % 6] - 12 + 12, vel: 0.4, pan: (i - 2.5) * 0.15 })
})
tl.fromTo(nsub, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'expo.out' }, T(7, 3.5))
tl.fromTo(nbtn, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.7, ease: 'elastic.out(1.1,0.45)' }, T(7, 4))
cue('pop', T(7, 4), { midi: 84, vel: 0.6 })
ncards.forEach((c, i) => {
  const t = T(8, 1 + i * 0.5)
  tl.fromTo(c, { y: 120, opacity: 0, rotation: (i - 1) * 10, scale: 0.85 }, { y: 0, opacity: 1, rotation: 0, scale: 1, duration: 0.65, ease: 'back.out(1.7)' }, t)
  tl.fromTo($('.em', c), { scale: 0, rotation: -50 }, { scale: 1, rotation: 0, duration: 0.5, ease: 'back.out(4)' }, t + 0.1)
  cue('pop', t, { midi: pitch.F[i + 1], vel: 0.55, pan: (i - 1) * 0.5 })
})
// agent cursor path (card-local coordinates)
gsap.set(agent1, { x: 760, y: 330, opacity: 0 })
tl.to(agent1, { opacity: 1, duration: 0.2, ease: 'none' }, t7)
tl.to(agent1, { motionPath: { path: [{ x: 760, y: 330 }, { x: 520, y: 130 }, { x: 250, y: 115 }], curviness: 1.4 }, duration: BEAT * 1.8, ease: 'power2.inOut' }, t7)
tl.to(agent1, { motionPath: { path: [{ x: 250, y: 115 }, { x: 420, y: 170 }, { x: 350, y: 244 }], curviness: 1.2 }, duration: BEAT * 1.5, ease: 'power3.inOut' }, T(7, 2.9))
// press the button
tl.to(agent1, { scale: 0.82, duration: 0.07, ease: 'power2.in' }, T(8, 2) - 0.07)
tl.to(agent1, { scale: 1, duration: 0.3, ease: 'back.out(3)' }, T(8, 2))
tl.to(nbtn, { scale: 0.9, duration: 0.07, ease: 'power2.in' }, T(8, 2) - 0.07)
tl.to(nbtn, { scale: 1, duration: 0.5, ease: 'elastic.out(1.2,0.35)' }, T(8, 2))
tl.fromTo(ripple1, { x: 345, y: 238, scale: 0.2, opacity: 1 }, { scale: 2.6, opacity: 0, duration: 0.6, ease: 'expo.out' }, T(8, 2))
cue('click', T(8, 2), { vel: 0.9 })
// chat reply lands on the click
tl.fromTo(bb2, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: 'back.out(2)' }, T(8, 2.5))
// go for the phone toggle
tl.to(agent1, { motionPath: { path: [{ x: 350, y: 244 }, { x: 520, y: 120 }, { x: 600, y: 24 }], curviness: 1.3 }, duration: BEAT * 1.2, ease: 'power3.inOut' }, T(8, 2.3))
tl.to(agent1, { scale: 0.82, duration: 0.07, ease: 'power2.in' }, T(8, 3.5) - 0.07)
tl.to(agent1, { scale: 1, duration: 0.3, ease: 'back.out(3)' }, T(8, 3.5))
tl.fromTo(ripple1, { x: 601, y: 20, scale: 0.1, opacity: 1 }, { scale: 1.3, opacity: 0, duration: 0.45, ease: 'expo.out', immediateRender: false }, T(8, 3.5))
tl.to($('.ico-phone', bcard), { color: '#111', scale: 1.3, duration: 0.3, ease: 'back.out(3)' }, T(8, 3.5))
cue('click', T(8, 3.5), { vel: 0.9 })
// sheen across the finished page
const sheen = h(`<div style="position:absolute;top:-20%;left:-30%;width:25%;height:140%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg);pointer-events:none"></div>`)
vp.append(sheen)
tl.fromTo(sheen, { x: 0 }, { x: 1300, duration: 0.8, ease: 'power2.inOut' }, T(8, 1.5))
// whip-zoom out of the scene
tl.to(win, { scale: 4.2, x: 160, y: 120, duration: BEAT * 0.9, ease: 'whip' }, T(9) - BEAT * 0.9)
tl.to(sApp, { filter: 'blur(18px)', opacity: 0.2, duration: BEAT * 0.9, ease: 'power2.in' }, T(9) - BEAT * 0.9)
cue('whoosh', T(9) - 0.03, { len: 0.7, vel: 0.9, pan: 0.3 })

// ---------------------------------------------------------------- SCENE 5: dual view + phone
const sDual = h(`<div class="scene" id="sDual"></div>`); cam.append(sDual)
const big = h(`<div class="bigcard"><div class="chrome"><span>${I('left')}</span><span>${I('right')}</span><span>${I('reload')}</span><div class="url">${I('lock', 'font-size:13px;margin-right:6px;color:#8a8b90')}localhost:5173</div><span style="color:#333">${I('monitor')}</span><span style="color:#333">${I('phone')}</span><span>${I('max')}</span></div><div class="vp"></div></div>`)
const nimB = nimbusDesktop(); nimB.style.fontSize = (1060 / 69) + 'px'; $('.vp', big).append(nimB)
const phone = h(`<div class="phone"><div class="face front"><div class="scr"></div><div class="island"></div></div><div class="face back"><div class="scr"></div><div class="island"></div></div></div>`)
const nimM = nimbusMobile(); $('.front .scr', phone).append(nimM)
const livepill = h(`<div class="livepill"><i></i>same session · desktop 1440 · iPhone 390 · both live</div>`)
const agent2 = agentEl(); const agent3 = agentEl()
const rip2 = h(`<div class="ripple"></div>`), rip3 = h(`<div class="ripple"></div>`)
$('.vp', big).append(rip2); $('.front .scr', phone).append(rip3)
big.append(agent2)
sDual.append(big, phone, livepill)
// companion app on the back
const appS = $('.back .scr', phone)
const app = h(`<div class="app">
  <div class="status"><span>12:50</span><span style="display:flex;gap:5px;align-items:center">${I('wifi', 'font-size:15px')}<i style="width:24px;height:11px;border-radius:3px;background:#111;display:block"></i></span></div>
  <div class="hdr"><div class="bk">${I('left')}</div><b>Tighten the hero copy</b><span>landing-page</span></div>
  <div class="chips"><span class="chip">${I('file')}Files</span><span class="chip">${I('todo')}Todo</span><span class="chip">${I('clock')}Routines</span><span class="chip g">${I('branch')}main</span></div>
  <div class="urlf">${I('globe', 'color:#888')}localhost:5173</div>
  <div class="prev"></div>
  <div class="abub bot" style="top:344px">Two lines instead of three. It lands harder without "for teams of any size".</div>
  <div class="abub me" style="top:430px">Better. Now check it on a phone.</div>
  <div class="from" style="top:470px">from this phone</div>
  <div class="abub bot" style="top:492px">Narrow, the headline holds at two lines and the buttons stack.</div>
  <div class="work" style="top:568px"><span class="spinner"></span>Working · 24s</div>
  <div class="comp"><span class="circ">${I('plus')}</span><span class="f">Message Claude…</span><span class="circ" style="background:#16171a;color:#fff">${I('stop', 'font-size:14px')}</span></div>
  <div class="mpills"><span class="chip">Model <b style="margin-left:3px">Opus</b></span><span class="chip">Mode <b style="margin-left:3px">Full</b></span></div>
  <div class="notif"><div class="ni"></div><div><b>Claude wants to run npm test</b><span>landing-page · Allow or deny</span></div></div>
</div>`)
appS.append(app)
const prevN = nimbusMobile(); prevN.style.fontSize = '5.2px'; $('.prev', app).append(prevN)
show(sDual, T(9)); hide(sDual, T(11))
const t9 = T(9)
tl.fromTo(sDual, { scale: 1.6, filter: 'blur(16px)', opacity: 0 }, { scale: 1, filter: 'blur(0px)', opacity: 1, duration: 0.8, ease: 'expo.out' }, t9)
tl.fromTo(big, { x: -160, rotationY: 28, z: -200 }, { x: 0, rotationY: 0, z: 0, duration: 1.0, ease: 'expo.out' }, t9)
tl.fromTo(phone, { x: 260, rotationY: -40, rotationZ: 8, z: -300 }, { x: 0, rotationY: 0, rotationZ: 0, z: 0, duration: 1.1, ease: 'expo.out' }, t9 + 0.06)
tl.fromTo(livepill, { y: 40, opacity: 0, scale: 0.8 }, { y: 0, opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(2.5)' }, T(9, 2.5))
cue('pop', T(9, 2.5), { midi: 84, vel: 0.5 })
// agent taps the phone, both views respond
gsap.set(agent2, { x: 820, y: 560, opacity: 0 })
tl.to(agent2, { opacity: 1, duration: 0.2 }, T(9, 1.5))
tl.to(agent2, { motionPath: { path: [{ x: 820, y: 560 }, { x: 640, y: 420 }, { x: 540, y: 362 }], curviness: 1.3 }, duration: BEAT * 1.3, ease: 'power3.inOut' }, T(9, 1.5))
tl.to(agent2, { scale: 0.8, duration: 0.07, ease: 'power2.in' }, T(9, 3) - 0.07)
tl.to(agent2, { scale: 1, duration: 0.3, ease: 'back.out(3)' }, T(9, 3))
const bB = $('.btn', nimB), bM = $('.btn', nimM)
tl.to([bB, bM], { scale: 0.9, duration: 0.07, ease: 'power2.in' }, T(9, 3) - 0.07)
tl.to([bB, bM], { scale: 1, duration: 0.5, ease: 'elastic.out(1.2,0.35)' }, T(9, 3))
tl.fromTo(rip2, { x: 530, y: 305, scale: 0.2, opacity: 1 }, { scale: 3, opacity: 0, duration: 0.7, ease: 'expo.out', immediateRender: false }, T(9, 3))
tl.fromTo(rip3, { x: 162, y: 330, scale: 0.2, opacity: 1 }, { scale: 3, opacity: 0, duration: 0.7, ease: 'expo.out', immediateRender: false }, T(9, 3.04))
cue('click', T(9, 3), { vel: 0.9 }); cue('pop', T(9, 3.1), { midi: 88, vel: 0.4, pan: 0.6 })
// both scroll together
tl.to([nimB, nimM], { y: (i) => (i === 0 ? -150 : -260), duration: 0.7, ease: 'expo.inOut' }, T(9, 3.5))
// desktop leaves, phone takes centre and flips to the companion app
tl.to(big, { x: -1500, rotationY: 35, duration: 0.6, ease: 'power3.in' }, T(10) - 0.5)
tl.to(livepill, { y: 60, opacity: 0, duration: 0.3, ease: 'power2.in' }, T(10) - 0.4)
tl.to(phone, { x: 960 - 175 - 1320, y: 10, scale: 1.16, duration: 0.9, ease: 'expo.inOut' }, T(10) - 0.6)
tl.to(phone, { rotationY: 180, duration: 0.8, ease: 'back.inOut(1.4)' }, T(10) - 0.45)
cue('whoosh', T(10) - 0.02, { len: 0.5, vel: 0.7, pan: -0.3 })
const appBits = [$('.status', app), $('.hdr', app), ...$$('.chip', $('.chips', app)), $('.urlf', app), $('.prev', app)]
tl.fromTo(appBits, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'back.out(2)', stagger: BEAT / 10 }, T(10) - 0.08)
const abubs = [...$$('.abub', app), $('.from', app), $('.work', app)]
const abT = [T(10, 1.75), T(10, 2.5), T(10, 3.5), T(10, 2.75), T(10, 3.75)]
abubs.forEach((b, i) => {
  tl.fromTo(b, { scale: 0.5, opacity: 0, transformOrigin: b.classList.contains('me') ? '100% 100%' : '0% 0%' }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2.2)' }, abT[i])
  if (i < 3) cue('pop', abT[i], { midi: [76, 79, 81][i], vel: 0.5, pan: 0.2 })
})
tl.fromTo([$('.comp', app), $('.mpills', app)], { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'expo.out', stagger: 0.05 }, T(10) + 0.05)
const notif = $('.notif', app)
tl.fromTo(notif, { y: -110, scale: 0.9 }, { y: 0, scale: 1, duration: 0.6, ease: 'back.out(1.8)' }, T(10, 3))
cue('bell', T(10, 3), { midi: 88, vel: 0.35, len: 0.6 })
// phone collapses into the first branch node
tl.to(phone, { scale: 0.05, x: 240 - 175 - 1320, y: 520 - 470, duration: 0.5, ease: 'power4.in' }, T(11) - 0.5)
tl.to($('.back', phone), { borderRadius: 400, duration: 0.5, ease: 'power2.in' }, T(11) - 0.5)
cue('whoosh', T(11) - 0.05, { len: 0.4, vel: 0.5, pan: -0.6 })

// ---------------------------------------------------------------- SCENE 6: branches + agents
const sBr = h(`<div class="scene" id="sBranch"></div>`); cam.append(sBr)
const MY = 520, bx = [420, 820, 1220], by = [300, 740, 300]
const brPaths = bx.map((x, i) => `M${x},${MY} C${x + 110},${MY} ${x + 70},${by[i]} ${x + 190},${by[i]}`)
const svg = h(`<svg id="branchSvg" viewBox="0 0 1920 1080"><path id="mainLine" d="M240,${MY} H1760" stroke="#23241f" stroke-width="5" stroke-linecap="round" fill="none"/>${brPaths.map((d, i) => `<path class="brl" d="${d}" stroke="${['#93b087', '#86a6c6', '#b8a3d2'][i]}" stroke-width="5" stroke-linecap="round" fill="none"/>`).join('')}</svg>`)
const brGroup = h(`<div class="full" style="transform-style:preserve-3d"></div>`)
brGroup.append(svg)
sBr.append(brGroup)
const node0 = h(`<div class="bnode" style="left:240px;top:${MY}px;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:9px"></div>`)
const mainPill = h(`<div class="mainpill" style="left:206px;top:${MY - 74}px">${I('branch')}main</div>`)
brGroup.append(node0, mainPill)
const brNodes = bx.map((x, i) => { const n = h(`<div class="bnode" style="left:${x}px;top:${MY}px;background:${['#93b087', '#86a6c6', '#b8a3d2'][i]}"></div>`); brGroup.append(n); return n })
const cardsData = [['Tighten the hero copy', 'chat/tighten-hero', 'claude', 'spin'], ['Fix the flaky auth test', 'chat/fix-auth-test', 'codex', 'dot'], ['Migrate to pnpm', 'chat/migrate-pnpm', 'claude', 'check']]
const brCards = cardsData.map(([title, br, prov, st], i) => {
  const c = h(`<div class="bcard2" style="left:${bx[i] + 190}px;top:${by[i] - 58}px">
    <div class="pl"><span class="pc">${claudeSvg(24)}</span><span class="px" style="position:absolute;display:flex">${codexSvg(24, '#23241f')}</span><span class="pg" style="position:absolute;display:flex">${geminiSvg(24)}</span></div>
    <div><h5>${title}</h5><div class="br mono">${I('branch', 'font-size:13px')}${br}</div></div>
    <div class="st">${st === 'spin' ? '<div class="spinner" style="width:20px;height:20px;border-width:2.5px"></div>' : st === 'dot' ? '<div style="width:12px;height:12px;border-radius:50%;background:#5b8ff0;margin:4px"></div>' : `<div style="width:24px;height:24px;border-radius:50%;background:#93b087;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px">${I('check')}</div>`}</div>
  </div>`)
  gsap.set($('.px', c), { opacity: prov === 'codex' ? 1 : 0, scale: prov === 'codex' ? 1 : 0 })
  gsap.set($('.pc', c), { opacity: prov === 'codex' ? 0 : 1, scale: prov === 'codex' ? 0 : 1 })
  gsap.set($('.pg', c), { opacity: 0, scale: 0 })
  brGroup.append(c); return c
})
// commit dots riding the branches
const commits = []
brPaths.forEach((d, i) => { for (let k = 0; k < 2; k++) { const dot = h(`<div style="position:absolute;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#fff;border:3px solid ${['#93b087', '#86a6c6', '#b8a3d2'][i]}"></div>`); brGroup.append(dot); commits.push([dot, d, i, k]) } })
show(sBr, T(11) - 0.02); hide(sBr, T(13))
gsap.set(brGroup, { filter: 'blur(0px)' })
const t11 = T(11)
tl.fromTo(node0, { scale: 0 }, { scale: 1, duration: 0.5, ease: 'back.out(4)' }, t11 - 0.02)
tl.fromTo('#mainLine', { drawSVG: '0% 0%' }, { drawSVG: '0% 100%', duration: 0.9, ease: 'expo.out' }, t11)
tl.fromTo(mainPill, { y: 20, scale: 0.5, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(3)' }, t11 + 0.08)
cue('whoosh', t11 + 0.1, { len: 0.35, vel: 0.45, pan: 0.6 })
$$('.brl', svg).forEach((p, i) => {
  const t = T(11, 2 + i * 0.75)
  tl.fromTo(brNodes[i], { scale: 0 }, { scale: 1, duration: 0.45, ease: 'back.out(4)' }, t - 0.06)
  tl.fromTo(p, { drawSVG: '0% 0%' }, { drawSVG: '0% 100%', duration: 0.45, ease: 'power3.out' }, t)
  tl.fromTo(brCards[i], { scale: 0.4, opacity: 0, rotation: i === 1 ? 6 : -6, y: i === 1 ? 50 : -50 }, { scale: 1, opacity: 1, rotation: 0, y: 0, duration: 0.7, ease: 'back.out(1.8)', transformOrigin: '0% 50%' }, t + 0.18)
  cue('pop', t - 0.06, { midi: pitch.Am[i + 1], vel: 0.5, pan: -0.4 + i * 0.4 })
  cue('pop', t + 0.18, { midi: pitch.Am[i + 2] + 12, vel: 0.35, pan: -0.4 + i * 0.4 })
  commits.filter((c) => c[2] === i).forEach(([dot, d, , k]) => {
    gsap.set(dot, { opacity: 0 })
    tl.set(dot, { opacity: 1 }, t + 0.3 + k * 0.2)
    tl.fromTo(dot, { motionPath: { path: d, start: 0, end: 0 } }, { motionPath: { path: d, start: 0, end: 0.35 + k * 0.35 }, duration: 0.8, ease: 'power2.out' }, t + 0.3 + k * 0.2)
    tl.fromTo(dot, { scale: 0 }, { scale: 1, duration: 0.4, ease: 'back.out(4)' }, t + 0.3 + k * 0.2)
  })
})
tl.fromTo(brGroup, { x: 60 }, { x: -40, duration: BAR * 2, ease: 'none' }, t11)
// agents: the toggle
const segAt = (i) => (PORTRAIT ? `left:10px;top:${i * 150}px` : `left:${[10, 435, 860][i]}px`)
const toggle = h(`<div class="toggle" style="${PORTRAIT ? '' : 'width:1300px;margin-left:-650px'}"><div class="knob"></div>
  <div class="seg" style="${segAt(0)}"><span class="lg">${claudeSvg(62)}</span><span class="t1">Claude Code</span></div>
  <div class="seg" style="${segAt(1)}"><span class="lg lx">${codexSvg(62, 'currentColor')}</span><span class="t2">Codex</span></div>
  <div class="seg" style="${segAt(2)}"><span class="lg">${geminiSvg(62)}</span><span class="t3">Gemini</span></div></div>`)
sBr.append(toggle)
const knob = $('.knob', toggle), segs = $$('.seg', toggle), seg1 = segs[0]
const knobAt = (i) => (PORTRAIT ? { y: i * 150 } : { x: [0, 425, 850][i] })
const squash = PORTRAIT ? { scaleX: 0.84, scaleY: 1.35 } : { scaleX: 1.35, scaleY: 0.84 }
const t12 = T(12)
tl.to(brGroup, { scale: 0.82, opacity: 0.28, filter: 'blur(5px)', duration: 0.6, ease: 'expo.out' }, t12 - 0.05)
tl.fromTo(toggle, { scale: 0.3, opacity: 0, rotationX: 60 }, { scale: 1, opacity: 1, rotationX: 0, duration: 0.8, ease: 'back.out(1.6)' }, t12 - 0.05)
tl.set(seg1, { color: '#fff' }, 0); tl.set(segs.slice(1), { color: '#23241f' }, 0)
tl.fromTo($('.lg', seg1), { rotation: -180, scale: 0 }, { rotation: 0, scale: 1, duration: 0.8, ease: 'back.out(2.5)' }, t12)
cue('pop', t12, { midi: 81, vel: 0.6 })
const cardLogo = { claude: '.pc', codex: '.px', gemini: '.pg' }
const flipTo = (t, to, from, cards) => {
  // squash-and-stretch knob travel
  tl.to(knob, { ...knobAt(to), duration: 0.42, ease: 'expo.inOut' }, t - 0.2)
  tl.to(knob, { ...squash, duration: 0.2, ease: 'power2.in' }, t - 0.2)
  tl.to(knob, { scaleX: 1, scaleY: 1, duration: 0.6, ease: 'elastic.out(1.2,0.35)' }, t)
  tl.to(segs[to], { color: '#ffffff', duration: 0.15, ease: 'none' }, t - 0.05)
  tl.to(segs[from], { color: '#23241f', duration: 0.15, ease: 'none' }, t - 0.05)
  tl.fromTo($('.lg', segs[to]), { scale: 0.6, rotation: to > from ? 90 : -90 }, { scale: 1, rotation: 0, duration: 0.6, ease: 'back.out(3)' }, t)
  cue('click', t - 0.02, { vel: 0.8 }); cue('pop', t, { midi: to ? 76 : 81, vel: 0.55 })
  // background cards swap agents in sync
  brCards.forEach((c, i) => {
    for (const [prov, sel] of Object.entries(cardLogo)) {
      const on = cards[i] === prov
      tl.to($(sel, c), { opacity: on ? 1 : 0, scale: on ? 1 : 0, rotation: on ? 0 : 90, duration: 0.4, ease: 'back.out(3)' }, t + i * 0.04)
    }
  })
}
flipTo(T(12, 2), 1, 0, ['codex', 'codex', 'claude'])
flipTo(T(12, 3), 2, 1, ['gemini', 'codex', 'gemini'])
flipTo(T(12, 3.75), 1, 2, ['claude', 'gemini', 'codex'])
// the knob swallows the screen → dark montage
tl.to(toggle, { opacity: 1, duration: 0.01 }, T(12, 4))
tl.to(knob, { scale: 26, duration: 0.5, ease: 'expo.in' }, T(13) - 0.5)
tl.to(segs, { opacity: 0, duration: 0.2, ease: 'none' }, T(13) - 0.45)
cue('whoosh', T(13) - 0.03, { len: 0.8, vel: 0.9 })

// ---------------------------------------------------------------- SCENE 7: montage
const sMon = h(`<div class="scene" id="sMon" style="background:${PORTRAIT ? 'none' : '#0c0d10'}"></div>`); cam.append(sMon)
const warp = h(`<canvas id="warp" width="1920" height="1080"></canvas>`)
const bigk = h(`<div class="bigkana">コードは、二番目。コードは、二番目。</div>`)
sMon.append(warp, bigk)
// upright, the stars are a backdrop like the others: behind the scenes, filling the frame
if (PORTRAIT) { stageEl.before(warp); show(warp, T(13)); hide(warp, T(14, 4.5)) }
const shotsDef = ['shot-build.jpg', 'shot-hero.jpg', 'shot-browser-view.jpg', 'shot-phone.jpg', 'shot-chat.jpg', 'shot-2-sidebar-and-phone.jpg', 'shot-3-cmdk.jpg', 'shot-5-iphone.jpg', 'shot-4b-agent-mobile-fixed.jpg', 'shot-build.jpg', 'shot-hero.jpg', 'shot-browser-view.jpg']
const shotLayer = h(`<div class="full" style="transform-style:preserve-3d"></div>`); sMon.append(shotLayer)
const shotEls = shotsDef.map((f, i) => { const tall = /phone|iphone/.test(f); const s = h(`<div class="shot" style="width:${tall ? 300 : 620}px"><img src="assets/${f}"></div>`); shotLayer.append(s); return s })
await Promise.all($$('img', sMon).map((i) => i.decode().catch(() => {})))
const slams = ['Open source.', 'No API key.', 'No telemetry.', 'Just your Mac.'].map((s) => { const e = h(`<div class="slam">${PORTRAIT ? s.replace(/ (?=\S+$)/, '<br>') : s}</div>`); sMon.append(e); return e })
const strobeIcons = [claudeSvg(170), codexSvg(170, '#23241f'), I('globe', 'font-size:170px;stroke-width:1.6'), I('phone', 'font-size:170px;stroke-width:1.6'), I('branch', 'font-size:170px;stroke-width:1.6'), I('term', 'font-size:170px;stroke-width:1.8')]
const strobes = strobeIcons.map((s) => { const e = h(`<div class="strobe">${s}</div>`); sMon.append(e); return e })
show(sMon, T(13)); hide(sMon, T(14, 4.5))
const t13 = T(13)
gsap.set(slams, { xPercent: -50, yPercent: -50, opacity: 0 })
gsap.set(bigk, { yPercent: -50 })
tl.fromTo(bigk, { x: 0 }, { x: -1800, duration: BAR * 2, ease: 'power1.in' }, t13)
const slamT = [T(13, 1), T(13, 3), T(14, 1), T(14, 2)]
slams.forEach((s, i) => {
  tl.fromTo(s, { scale: 1.9, opacity: 0, filter: 'blur(24px)' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 0.3, ease: 'expo.out' }, slamT[i])
  const end = i < 3 ? slamT[i + 1] : T(14, 3)
  tl.to(s, { scale: 0.92, duration: end - slamT[i] - 0.08, ease: 'none' }, slamT[i] + 0.3)
  tl.to(s, { opacity: 0, scale: 0.7, filter: 'blur(10px)', duration: 0.08, ease: 'power2.in' }, end - 0.08)
})
// screenshots fly through a tunnel
const R = mulberry(7)
const shotT = [T(13, 1), T(13, 1.5), T(13, 2), T(13, 2.5), T(13, 3), T(13, 3.5), T(13, 4), T(13, 4.5), T(14, 1), T(14, 1.5), T(14, 2), T(14, 2.5)]
shotEls.forEach((s, i) => {
  const ang = i * 2.4 + R() * 0.6
  const ra = 780 + R() * 140, rb = 390 + R() * 60 // the tunnel is wide, or tall when upright
  // upright they pass above and below the words, never across them
  const x = Math.cos(ang) * (PORTRAIT ? rb * 0.9 : ra), y = PORTRAIT ? (Math.sin(ang) < 0 ? -1 : 1) * (540 + Math.abs(Math.sin(ang)) * (ra - 540)) : Math.sin(ang) * rb
  gsap.set(s, { xPercent: -50, yPercent: -50, opacity: 0 })
  const dur = 1.1, t0 = shotT[i] - dur * 0.45
  tl.fromTo(s, { x: x * 0.35, y: y * 0.35, z: -2600, rotationY: -x / 30, rotationX: y / 30, rotationZ: (R() - 0.5) * 24 }, { x: x * 1.1, y: y * 1.1, z: 700, rotationY: -x / 18, rotationX: y / 18, duration: dur, ease: 'power1.in', immediateRender: false }, t0)
  // a shot shows once it is through the stars' plane (z = 0), flying past the camera. Chromium's depth
  // sorting hid it behind the star canvas until then; Safari's does not, and upright the stars sit behind
  // the scenes anyway, so it is switched on at that moment rather than left to the canvas.
  tl.fromTo(s, { opacity: 0 }, { opacity: 1, duration: 0.02, ease: 'none', immediateRender: false }, t0 + dur * 0.888)
  tl.to(s, { opacity: 0, duration: 0.1, ease: 'none' }, t0 + dur - 0.1)
})
// icon strobe on the roll
const strobeT = []; for (let i = 0; i < 6; i++) strobeT.push(T(14, 3) + i * BEAT / 4)
strobes.forEach((s, i) => {
  tl.set(s, { opacity: 1 }, strobeT[i])
  tl.fromTo(s, { scale: 1.4, rotation: (i % 2 ? 12 : -12) }, { scale: 1, rotation: 0, duration: 0.11, ease: 'expo.out', immediateRender: false }, strobeT[i])
  if (i < 5) tl.set(s, { opacity: 0 }, strobeT[i] + BEAT / 4)
  cue('pop', strobeT[i], { midi: pitch.G[i % 6] + 12, vel: 0.45, pan: (i % 2 ? 0.5 : -0.5) })
})

// ---------------------------------------------------------------- SCENE 8: end card
const sEnd = h(`<div class="scene" id="sEnd"></div>`); cam.append(sEnd)
const logo2 = makeLogo()
const word2 = h(`<div class="wordmark" style="font-size:150px">${[...'Superagent'].map((c) => `<span class="mask"><span class="c">${c}</span></span>`).join('')}</div>`)
const kana2 = h(`<div class="kana" style="font-size:28px">${charSpans(kanaStr)}</div>`)
const tag2 = h(`<div class="tagline" style="font-size:${PORTRAIT ? 78 : 60}px">${PORTRAIT ? maskWords('A beautiful home') + '<br>' + maskWords('for your agent.') : maskWords('A beautiful home for your agent.')}</div>`)
const dl = h(`<div class="dl">${appleSvg(30)}<span>Download for Mac</span><div class="shine2"></div></div>`)
const urlT = 'superagent.computer'
const url2 = h(`<div class="urltxt">${charSpans(urlT)}<span class="uline" style="height:4px;bottom:-6px"></span></div>`)
const small = h(`<div class="smallrow"><span>Free</span><span class="sep"></span><span>Open source</span><span class="sep"></span><span style="display:flex;gap:8px;align-items:center">Works with ${claudeSvg(24)} Claude Code, ${codexSvg(24, '#23241f')} Codex &amp; ${geminiSvg(24)} Gemini</span></div>`)
const ring3 = h(`<div class="ring"></div>`), ring4 = h(`<div class="ring"></div>`)
sEnd.append(ring3, ring4, logo2, word2, kana2, tag2, dl, url2, small)
const w2W = word2.getBoundingClientRect().width
gsap.set(logo2, { scale: 0.8 })
const lock2W = 240 + 52 + w2W, lock2L = 960 - lock2W / 2
const L2X = PORTRAIT ? 960 : lock2L + 120, L2Y = PORTRAIT ? 250 : 380
gsap.set([logo2, ring3, ring4], { xPercent: -50, yPercent: -50 })
gsap.set([ring3, ring4], { x: 960, y: L2Y })
const dlW = dl.getBoundingClientRect().width, urlW = url2.getBoundingClientRect().width
const rowW = dlW + 40 + urlW, rowL = 960 - rowW / 2
// upright, the card stacks like the lockup, with the button over the address
const DLY = PORTRAIT ? 940 : 690, SMY = PORTRAIT ? 1170 : 842
if (PORTRAIT) {
  gsap.set(word2, { x: 960 - w2W / 2, y: 410 })
  gsap.set(kana2, { x: 960 - kana2.getBoundingClientRect().width / 2 + 8, y: 590 })
  gsap.set(tag2, { x: 960, xPercent: -50, y: 680 })
  gsap.set(dl, { x: 960 - dlW / 2, y: DLY })
  gsap.set(url2, { x: 960 - urlW / 2, y: 1060 })
} else {
  gsap.set(word2, { x: lock2L + 292, y: L2Y - 88 })
  gsap.set(kana2, { x: lock2L + 298, y: L2Y + 72 })
  gsap.set(tag2, { x: 960, xPercent: -50, y: 548 })
  gsap.set(dl, { x: rowL, y: DLY })
  gsap.set(url2, { x: rowL + dlW + 40, y: 712 })
}
gsap.set(small, { x: 960, xPercent: -50, y: SMY })
show(sEnd, T(14, 4.5))
const t15 = T(15)
// hard cut to paper in the silence; the mark falls in and lands on the drop
tl.set('#flash', { opacity: 0 }, T(14, 4.5))
tl.fromTo(logo2, { x: 960, y: PORTRAIT ? -760 : -300, scaleX: 0.62, scaleY: 1.05 }, { y: L2Y, duration: T(15) - T(14, 4.5), ease: 'power3.in' }, T(14, 4.5))
tl.to(logo2, { scaleX: 0.98, scaleY: 0.6, duration: 0.07, ease: 'power2.out' }, t15)
tl.to(logo2, { scaleX: 0.8, scaleY: 0.8, duration: 0.8, ease: 'elastic.out(1.3,0.35)' }, t15 + 0.07)
gsap.set([ring3, ring4], { opacity: 0 })
tl.fromTo(ring3, { scale: 0.8, opacity: 0.9 }, { scale: 2.6, opacity: 0, duration: 1.1, ease: 'expo.out', immediateRender: false }, t15)
tl.fromTo(ring4, { scale: 0.8, opacity: 0.6, borderWidth: 8 }, { scale: 4, opacity: 0, borderWidth: 1, duration: 1.4, ease: 'expo.out', immediateRender: false }, t15 + 0.08)
tl.to(logo2, { x: L2X, duration: 0.7, ease: 'expo.inOut' }, T(15, 1.6))
tl.fromTo($$('.c', word2), { yPercent: 118, rotation: 14 }, { yPercent: 0, rotation: 0, duration: 0.7, ease: 'expo.out', stagger: 0.03 }, T(15, 2.1))
$$('.c', word2).forEach((_, i) => cue('tick', T(15, 2.1) + i * 0.03, { vel: 0.35 }))
scramble($$('.c', kana2), kanaStr, T(15, 2.8), 0.02, 0.04)
tl.fromTo($$('.wi', tag2), { yPercent: 110 }, { yPercent: 0, duration: 0.6, ease: 'expo.out', stagger: 0.07 }, T(15, 3))
tl.fromTo(dl, { scale: 0.4, opacity: 0, y: DLY + 30 }, { scale: 1, opacity: 1, y: DLY, duration: 0.7, ease: 'back.out(2)' }, T(15, 4))
cue('pop', T(15, 4), { midi: 84, vel: 0.6 })
const urlC = $$('.c', url2)
gsap.set(urlC, { opacity: 0 })
urlC.forEach((c, i) => { const t = T(15, 4.25) + i * (BEAT / 8) * 0.8; tl.fromTo(c, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.25, ease: 'back.out(3)' }, t); cue('tick', t, { vel: 0.35 }) })
tl.to($('.uline', url2), { scaleX: 1, duration: 0.5, ease: 'expo.out' }, T(16))
tl.fromTo($('.shine2', dl), { x: 0 }, { x: 520, duration: 0.8, ease: 'power2.inOut' }, T(16))
tl.fromTo($('.sheen', logo2), { xPercent: 0 }, { xPercent: 520, duration: 0.9, ease: 'power2.inOut' }, T(16) + 0.05)
tl.to(dl, { scale: 1.06, duration: 0.08, ease: 'power2.out' }, T(16))
tl.to(dl, { scale: 1, duration: 0.6, ease: 'elastic.out(1.2,0.4)' }, T(16) + 0.08)
tl.to($('.inner', logo2), { scale: 1.18, duration: 0.08, ease: 'power2.out' }, T(16))
tl.to($('.inner', logo2), { scale: 1, duration: 0.7, ease: 'elastic.out(1.3,0.35)' }, T(16) + 0.08)
cue('shine', T(16) + 0.05)
tl.fromTo(small, { y: SMY + 20, opacity: 0 }, { y: SMY, opacity: 1, duration: 0.6, ease: 'expo.out' }, T(16, 1.5))
// slow push to the end
tl.fromTo(sEnd, { scale: 1 }, { scale: 1.035, duration: 30 - T(15), ease: 'sine.out' }, t15)

// ---------------------------------------------------------------- captions
const capsEl = $('#caps')
function caption(eb, jp, a, b, tin, tout) {
  const c = h(`<div class="cap"${PORTRAIT && a.length > 24 ? ' style="font-size:64px"' : ''}><div class="eb"><span class="mask"><span class="wi">${eb}${jp ? `<span class="jp">${jp}</span>` : ''}</span></span></div><div class="hd">${maskWords(a)} <span class="g">${maskWords(b)}</span></div></div>`)
  capsEl.append(c)
  const ws = $$('.wi', c)
  gsap.set(ws, { yPercent: 115 })
  tl.to(ws, { yPercent: 0, duration: 0.7, ease: 'expo.out', stagger: 0.045 }, tin)
  tl.to(ws, { yPercent: -115, duration: 0.3, ease: 'power3.in', stagger: 0.02 }, tout - 0.3)
}
caption('I. THE SIDEBAR', 'サイドバー', 'Every session,', 'one rail.', T(5, 3), T(7) - 0.1)
caption('II. THE BROWSER', 'ブラウザ', 'A real browser', 'it drives.', T(7, 1.5), T(9) - 0.2)
caption('III. DUAL VIEW', '', 'One page,', 'seen twice.', T(9, 1.5), T(10) - 0.05)
caption('IV. ON YOUR PHONE', 'ポケット', "Your Mac's agent,", 'in your pocket.', T(10, 1.5), T(11) - 0.1)
caption('V. BRANCHES', '', 'Each chat,', 'its own branch.', T(11, 1.5), T(12) - 0.05)
caption('VI. ANY AGENT', '', 'Claude Code, Codex or Gemini.', 'Per chat.', T(12, 1.25), T(13) - 0.15)

// paper back on for the branch / end scenes, dark for montage
tl.set('#paper', { visibility: 'visible' }, 0)
tl.to('#capfade', { opacity: 1, duration: 0.5, ease: 'power2.out' }, T(5, 2.5))
tl.set('#capfade', { opacity: 0 }, T(13))
if (PORTRAIT) tl.to('#capfade', { opacity: 0, duration: 0.2, ease: 'none' }, T(13) - 0.5) // the knob comes through it
tl.to('#blobs', { opacity: 0.7, duration: 0.5 }, T(9))
tl.set('#bgDark', { visibility: 'visible' }, T(13)); tl.set(['#paper', '#blobs', '#dots'], { visibility: 'hidden' }, T(13))
tl.set('#bgDark', { visibility: 'hidden' }, T(14, 4.5)); tl.set(['#paper', '#blobs', '#dots'], { visibility: 'visible' }, T(14, 4.5))

// ---------------------------------------------------------------- procedural: camera, fx, grain
const kicks = kickTimes()
const shakeEl = $('#shake')
const grooveOn = (t) => (t >= T(3) && t < T(14, 4.5)) || (t >= T(15) && t < T(16) + 0.5)
procs.push((t) => {
  let env = 0; for (const k of kicks) if (t >= k && t - k < 0.4) env = Math.max(env, Math.exp(-(t - k) / 0.085))
  const bump = grooveOn(t) ? 1 + 0.011 * env : 1
  let sx = 0, sy = 0, rz = 0
  for (const [t0, A] of [[T(3), 16], [T(15), 22], [T(16), 8], [T(9), 6], [T(13), 8]]) {
    if (t >= t0 && t - t0 < 0.6) { const e = A * Math.exp(-(t - t0) / 0.1); sx += Math.sin((t - t0) * 95) * e; sy += Math.cos((t - t0) * 77) * e * 0.8; rz += Math.sin((t - t0) * 60) * e * 0.02 }
  }
  shakeEl.style.transform = `translate(${sx}px, ${sy}px) rotate(${rz}deg) scale(${bump})`
  // spinners
  $$('.spinner').forEach((s) => (s.style.transform = `rotate(${(t * 420) % 360}deg)`))
  // blobs drift
  $$('#blobs .blob').forEach((b, i) => (b.style.transform = `translate(${Math.sin(t * 0.4 + i * 2) * 120}px, ${Math.cos(t * 0.33 + i) * 80}px)`))
  $('#dots').style.backgroundPosition = `${-t * 12}px ${-t * 8}px`
})

// particles
const fx = $('#fx').getContext('2d')
const bursts = []
function burst(t0, x, y, n, seed, opts = {}) {
  const r = mulberry(seed)
  const cols = opts.cols || ['#93b087', '#b8a3d2', '#86a6c6', '#e0aeb0', '#d9c188', '#23241f']
  const ps = []
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, sp = (opts.speed || 1500) * (0.35 + r() * 0.9)
    ps.push({ a, sp, s: 8 + r() * 18, rot: r() * 6, vr: (r() - 0.5) * 16, c: cols[Math.floor(r() * cols.length)], life: 0.7 + r() * 0.8, round: r() < 0.35 })
  }
  bursts.push({ t0, x, y, ps, drag: opts.drag || 4.2, grav: opts.grav ?? 300 })
}
burst(T(3), 960, 540, 70, 11)
burst(T(15), 960, L2Y + 100, 60, 23, { speed: 1300, grav: 700 })
burst(T(16), L2X, L2Y, 26, 31, { speed: 900 })
procs.push((t) => {
  fx.clearRect(0, 0, 1920, 1080)
  for (const b of bursts) {
    const dt = t - b.t0
    if (dt < 0 || dt > 1.8) continue
    for (const p of b.ps) {
      if (dt > p.life) continue
      const k = (1 - Math.exp(-b.drag * dt)) / b.drag
      const x = b.x + Math.cos(p.a) * p.sp * k
      const y = b.y + Math.sin(p.a) * p.sp * k + 0.5 * b.grav * dt * dt
      const f = 1 - dt / p.life
      const s = p.s * (0.4 + 0.6 * f)
      fx.save(); fx.translate(x, y); fx.rotate(p.rot + p.vr * k); fx.globalAlpha = Math.min(1, f * 1.6)
      fx.fillStyle = p.c
      if (p.round) { fx.beginPath(); fx.arc(0, 0, s / 2, 0, 6.283); fx.fill() } else { const rr = s * 0.28; fx.beginPath(); fx.roundRect(-s / 2, -s / 2, s, s, rr); fx.fill() }
      fx.restore()
    }
  }
})
// warp stars (montage)
const wctx = warp.getContext('2d')
const stars = []; { const r = mulberry(99); for (let i = 0; i < 420; i++) stars.push({ x: (r() - 0.5) * 3000, y: (r() - 0.5) * 1800, z: r() }) }
procs.push((t) => {
  if (t < T(13) - 0.05 || t > T(14, 4.5)) return
  const u = t - T(13)
  // distance travelled, accelerating into the drop
  const dist = (u) => 0.25 * u + 0.22 * u * u + 0.05 * u * u * u
  wctx.fillStyle = '#0c0d10'; wctx.fillRect(0, 0, 1920, 1080)
  const d = dist(u), d0 = dist(Math.max(0, u - 1 / 60))
  wctx.lineCap = 'round'
  for (const s of stars) {
    const z = 1 - ((s.z + d) % 1), z0 = 1 - ((s.z + d0) % 1)
    if (z0 < z) continue
    const px = 960 + s.x / (z * 3 + 0.05), py = 540 + s.y / (z * 3 + 0.05)
    const qx = 960 + s.x / (z0 * 3 + 0.05), qy = 540 + s.y / (z0 * 3 + 0.05)
    const a = clamp((1 - z) * 1.3)
    wctx.strokeStyle = `rgba(230,232,240,${a * 0.85})`; wctx.lineWidth = 1 + (1 - z) * 2.5
    wctx.beginPath(); wctx.moveTo(qx, qy); wctx.lineTo(px, py); wctx.stroke()
  }
})
// grain
const gc = $('#grain').getContext('2d')
const tiles = []
{ const r = mulberry(5); for (let k = 0; k < 6; k++) { const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); const im = x.createImageData(256, 256); for (let i = 0; i < 256 * 256; i++) { const v = 128 + (r() - 0.5) * 110; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255 } x.putImageData(im, 0, 0); tiles.push(c) } }
procs.push((t) => {
  const f = Math.floor(t * 30)
  const tile = tiles[f % tiles.length]
  gc.save(); gc.translate(-(hash(f) * 256), -(hash(f + 1) * 256)); gc.fillStyle = gc.createPattern(tile, 'repeat'); gc.fillRect(0, 0, 1920 + 256, 1080 + 256); gc.restore()
})

// ---------------------------------------------------------------- portrait camera
// What the upright frame looks at: [time, x, y, zoom, where on screen that
// point sits (y)], in the scenes' own 1920×1080 pixels. It eases from one key
// to the next; a key marked 'cut' is jumped to.
if (PORTRAIT) {
  const K = [
    [0, 960, 540, 1.08, 960],
    [T(2) - 0.14, 960, 540, 1.08, 960], [T(2) + 0.05, 975, 540, stack2 ? 1.0 : 0.84, 960],
    [T(3), 960, 540, 1.0, 960, 'cut'], [T(3, 1.8), 960, 540, 1.0, 960], [T(3, 3), 960, 585, 1.02, 960],
    [T(4, 3.6), 960, 585, 1.02, 960], [T(4, 4.4), 960, 540, 1.0, 960],
    [T(5), 1000, 480, 0.86, 880, 'cut'], [8.3, 1000, 480, 0.86, 880], [8.7, 590, 450, 1.55, 860], [9.0, 636, 560, 1.4, 860], [9.45, 624, 620, 1.3, 860],
    [9.85, 1240, 560, 1.35, 860], [10.7, 1235, 560, 1.35, 860], [11.0, 1342, 560, 1.35, 860], [11.4, 960, 478, 1.06, 860],
    [14.55, 960, 478, 1.06, 860], [T(9) - 0.01, 935, 500, 0.7, 860],
    [T(9), 675, 470, 0.98, 860, 'cut'], [15.85, 678, 470, 0.98, 860], [16.35, 1495, 470, 1.5, 860], [16.5, 1495, 470, 1.5, 860],
    [16.8, 1045, 478, 1.5, 860], [17.2, 960, 480, 1.45, 860], [T(11) - 0.03, 960, 480, 1.45, 860],
    [T(11) - 0.02, 560, 520, 1.08, 860, 'cut'], [19.05, 620, 520, 1.08, 860], [19.7, 1000, 520, 1.08, 860], [20.3, 1380, 520, 1.08, 860], [T(12) - 0.2, 1390, 520, 1.08, 860],
    [T(12) + 0.3, 960, 480, 1.6, 860], [T(13) - 0.01, 960, 480, 1.6, 860],
    [T(13), 960, 540, 1.0, 960, 'cut'], [T(14, 4.5) - 0.01, 960, 540, 1.0, 960],
    [T(14, 4.5), 960, 660, 1.0, 960, 'cut'], [30, 960, 660, 1.0, 960]
  ]
  procs.push((t) => {
    let i = 0
    while (i < K.length - 1 && t >= K[i + 1][0]) i++
    const a = K[i], b = K[i + 1]
    let v = a
    if (b && b[5] !== 'cut') { const k = eio3(ramp(t, a[0], b[0])); v = [0, lerp(a[1], b[1], k), lerp(a[2], b[2], k), lerp(a[3], b[3], k), lerp(a[4], b[4], k)] }
    stageEl.style.transform = `translate(${540 - v[1] * v[3]}px, ${v[4] - v[2] * v[3]}px) scale(${v[3]})`
  })
}

// ================================================================= public API
window.renderAt = (t) => { tl.seek(t, true); for (const p of procs) p(t) }
window.getCues = async () => CUES
window.DURATION = DURATION
window.ready = true
renderAt(0)
