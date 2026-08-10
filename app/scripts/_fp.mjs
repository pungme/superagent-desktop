import { chromium } from 'playwright-core'
import { homedir } from 'os'
const b = await chromium.launch({
  headless: false,
  executablePath: homedir()+"/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
})
const p = await b.newPage()
await p.goto('https://example.com')
const r = await p.evaluate(() => JSON.stringify({
  webdriver: navigator.webdriver, plugins: navigator.plugins.length, mime: navigator.mimeTypes.length,
  langs: navigator.languages.join(','), hw: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
  platform: navigator.platform, vendor: navigator.vendor, maxTouch: navigator.maxTouchPoints,
  pdfViewer: navigator.pdfViewerEnabled, chrome: typeof window.chrome,
  chromeRuntime: !!(window.chrome && window.chrome.runtime), chromeCsi: !!(window.chrome && window.chrome.csi),
  chromeLoadTimes: !!(window.chrome && window.chrome.loadTimes),
  notif: typeof Notification !== 'undefined' ? Notification.permission : 'none'
}))
console.log('REAL CHROME: ' + r)
await b.close()
