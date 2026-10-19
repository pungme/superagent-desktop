// How evenly the embedded simulator screen keeps up, idle and with the main
// thread busy (as a busy Superagent keeps it). Prints frames the device drew,
// frames put on screen, and the longest gap between two (ms).
//
//   UDID=<booted device> MOD=native/simview.node npx electron scripts/sim-bench/bench.js
//
// Put something moving on the device first, e.g. serve this folder and open
// anim.html in its Safari: python3 -m http.server 8765, then
// xcrun simctl openurl <udid> http://127.0.0.1:8765/anim.html
//
// 2026-10-19, iPhone 17e: frames drawn on the main thread froze for 166 ms at
// a time while it was busy; drawn on their own queue, the longest gap was 23–41 ms.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const which = path.resolve(process.env.MOD || 'native/simview.node')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 600, height: 900, show: true })
  await win.loadURL('about:blank')
  const m = { exports: {} }
  process.dlopen(m, which)
  const sv = m.exports
  const info = sv.attach({ view: win.getNativeWindowHandle(), udid: process.env.UDID })
  sv.setBounds(info.id, 20, 20, 402, 874, 40, 0)
  sv.setVisible(info.id, true)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(2000)
  sv.stats(info.id)
  await wait(6000)
  const idle = sv.stats(info.id)
  // Busy: the main thread taken for 150 ms of every 300.
  const end = Date.now() + 6000
  while (Date.now() < end) {
    const s = Date.now()
    while (Date.now() - s < 150) {
      /* busy */
    }
    await wait(150)
  }
  const busy = sv.stats(info.id)
  console.log(JSON.stringify({ idle, busy }))
  sv.detach(info.id)
  app.quit()
})
