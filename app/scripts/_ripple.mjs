import { chromium } from 'playwright-core'
import { homedir } from 'os'
const b = await chromium.launch({ executablePath: homedir()+"/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" })
const p = await b.newPage({ viewport: { width: 800, height: 520 } })
await p.goto(process.argv[2])
// Click three points on the phone picture and compare both placements.
const out = await p.evaluate(() => {
  const stage = document.getElementById('stage'), shot = document.getElementById('shot')
  const sr = stage.getBoundingClientRect(), ir = shot.getBoundingClientRect()
  const probe = (clientX, clientY) => {
    // old: percentage of the picture, applied to the stage
    const oldLeft = ((clientX - ir.left) / ir.width) * 100 / 100 * sr.width
    const oldTop = ((clientY - ir.top) / ir.height) * 100 / 100 * sr.height
    // new: pixels within the stage
    const newLeft = clientX - sr.left
    const newTop = clientY - sr.top
    const want = { x: clientX - sr.left, y: clientY - sr.top }
    return { clickedAt: [Math.round(want.x), Math.round(want.y)],
             oldDrewAt: [Math.round(oldLeft), Math.round(oldTop)],
             newDrewAt: [Math.round(newLeft), Math.round(newTop)],
             oldOffBy: Math.round(Math.hypot(oldLeft - want.x, oldTop - want.y)),
             newOffBy: Math.round(Math.hypot(newLeft - want.x, newTop - want.y)) }
  }
  return [probe(ir.left + 20, ir.top + 20), probe(ir.left + ir.width/2, ir.top + ir.height/2),
          probe(ir.right - 15, ir.bottom - 40)]
})
for (const r of out) console.log(JSON.stringify(r))
await b.close()
