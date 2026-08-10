import { chromium } from 'playwright-core'
import { homedir } from 'os'
const b = await chromium.launch({ executablePath: homedir()+"/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" })
const p = await b.newPage()
await p.goto(process.argv[2])
await p.waitForTimeout(600)
const r = await p.evaluate(() => {
  const px = (c) => (c.match(/\d+(\.\d+)?/g) || []).slice(0,3).map(Number)
  const lum = (c) => { const v = px(c).map(n => { n/=255; return n<=0.03928 ? n/12.92 : Math.pow((n+0.055)/1.055, 2.4) })
                       return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2] }
  const ratio = (a,bg) => { const L1=lum(a), L2=lum(bg); return (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05) }
  const t = document.querySelector('.preview-toast')
  const cs = getComputedStyle(t)
  const close = getComputedStyle(document.querySelector('.preview-toast-close'))
  return { text: cs.color, chip: cs.backgroundColor,
           textContrast: +ratio(cs.color, cs.backgroundColor).toFixed(2),
           closeContrast: +ratio(close.color, cs.backgroundColor).toFixed(2) }
})
console.log(JSON.stringify(r, null, 1))
await b.close()
