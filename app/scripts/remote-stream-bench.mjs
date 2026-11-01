// What the remote-control stream costs, measured on real UI pixels and never on
// anyone's screen: two 2560x1600 screenshots of this app (app/*.png) stand in
// for the Mac's display, and the usual things a person does to a screen are done
// to them (typing, a blinking cursor, a scroll, switching window, and noise as
// the worst case).
//
//   node scripts/remote-stream-bench.mjs
//
// It runs the real dirty-rectangle and encoder code from
// src/main/remote-control/stream.ts, with sharp's libjpeg-turbo as the JPEG
// encoder (Electron's nativeImage.toJPEG is the same library). It does NOT
// measure the capture itself (desktopCapturer), which needs a real screen, and
// it runs in Node, not in Electron's main process: add the capture time to every
// "work" figure for the real thing.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { build } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes, randomFillSync } from 'crypto'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const require = createRequire(import.meta.url)
const sharp = require('sharp')

const out = join(mkdtempSync(join(tmpdir(), 'rc-bench-')), 'stream.cjs')
await build({
  entryPoints: [join(app, 'src/main/remote-control/stream.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'silent'
})
const { dirtyRect, alignRect, ScreenEncoder, REMOTE_FRAME_JPEG_MAX_PROXY } = require(out)
void REMOTE_FRAME_JPEG_MAX_PROXY
const CAP = 540_000

async function screen(file, width) {
  const height = Math.round((width * 900) / 1440)
  const { data } = await sharp(join(app, file))
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { width, height, data: new Uint8Array(data) }
}

const clone = (b) => ({ width: b.width, height: b.height, data: b.data.slice() })

async function jpeg(b, rect, quality) {
  return sharp(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength), {
    raw: { width: b.width, height: b.height, channels: 4 }
  })
    .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
    .jpeg({ quality })
    .toBuffer()
}

// The encoder takes a synchronous function: pre-encode lazily with a cache keyed
// by the request, filled by an async pass first.
async function frameFor(prev, next, quality, now = 0) {
  const asks = []
  const probe = new ScreenEncoder((_p, rect, q) => {
    asks.push({ rect, q })
    return Buffer.alloc(1)
  })
  if (prev) {
    probe.make(prev, quality, 0)?.commit?.()
  }
  const t0 = process.hrtime.bigint()
  const planned = probe.make(next, quality, now)
  const planMs = Number(process.hrtime.bigint() - t0) / 1e6
  if (!planned) return null
  const rect = asks.at(-1).rect
  const key = rect.w === next.width && rect.h === next.height
  let q = quality
  const t1 = process.hrtime.bigint()
  let buf = await jpeg(next, rect, q)
  while (buf.length > CAP && q > 30) {
    q = Math.max(30, q - 12)
    buf = await jpeg(next, rect, q)
  }
  const encMs = Number(process.hrtime.bigint() - t1) / 1e6
  return { rect, key, bytes: buf.length, encMs, planMs, quality: q }
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`.padStart(7)
const ms = (n) => `${n.toFixed(0)} ms`.padStart(6)

function row(label, r) {
  if (!r) return console.log(`  ${label.padEnd(34)} (nothing changed: nothing sent)`)
  const sealed = Math.ceil(((r.bytes * 4) / 3) * (4 / 3))
  console.log(
    `  ${label.padEnd(34)} ${r.key ? 'whole ' : 'piece '}${String(r.rect.w).padStart(4)}x${String(r.rect.h).padEnd(4)} ` +
      `q${r.quality}  ${kb(r.bytes)} (${kb(sealed)} on the wire)  find ${ms(r.planMs)}  encode ${ms(r.encMs)}`
  )
}

const scenarios = async (label, a, b) => {
  console.log(`\n${label}`)
  const q = 72
  row('first picture (a whole screen)', await frameFor(null, a, q))
  const typing = clone(a)
  for (let y = 400; y < 424; y++)
    for (let x = 300; x < 700; x++) {
      const i = (y * a.width + x) * 4
      typing.data[i] ^= 0x55
      typing.data[i + 1] ^= 0x33
    }
  row('typing a line (400x24 changes)', await frameFor(a, typing, q))
  const blink = clone(a)
  for (let y = 300; y < 318; y++)
    for (let x = 500; x < 502; x++)
      blink.data.fill(0, (y * a.width + x) * 4, (y * a.width + x) * 4 + 3)
  row('cursor blink (2x18)', await frameFor(a, blink, q))
  const scrolled = clone(a)
  const top = Math.round(a.height * 0.15)
  const rows = Math.round(a.height * 0.8)
  const shift = Math.round(a.height * 0.13)
  for (let y = 0; y < rows - shift; y++)
    scrolled.data.copyWithin(
      (top + y) * a.width * 4,
      (top + y + shift) * a.width * 4,
      (top + y + shift + 1) * a.width * 4
    )
  row('scrolling a page (80% of the screen)', await frameFor(a, scrolled, q))
  row('switching to another window', await frameFor(a, b, q))
  const noise = clone(a)
  randomFillSync(noise.data)
  row('worst case: every pixel noise', await frameFor(a, noise, q))
  // Time to find what changed on a whole screen's worth.
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 10; i++) dirtyRect(a, scrolled)
  console.log(
    `  finding the changed box on ${a.width}x${a.height}: ${(Number(process.hrtime.bigint() - t0) / 1e7).toFixed(1)} ms`
  )
}

for (const width of [1440, 1152, 960]) {
  const a = await screen('onboarding-approval.png', width)
  const b = await screen('transcript-performance.png', width)
  await scenarios(`Picture ${width} wide (${a.height} tall), JPEG quality 72`, a, b)
}

console.log('\nQuality against size, a whole 1440x900 picture of the app:')
const a1440 = await screen('onboarding-approval.png', 1440)
for (const q of [40, 55, 72, 85]) {
  const t0 = process.hrtime.bigint()
  const buf = await jpeg(a1440, { x: 0, y: 0, w: a1440.width, h: a1440.height }, q)
  console.log(`  q${q}: ${kb(buf.length)}  ${ms(Number(process.hrtime.bigint() - t0) / 1e6)}`)
}
void randomBytes
void alignRect
