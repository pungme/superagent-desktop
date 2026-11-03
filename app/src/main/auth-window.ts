import { BaseWindow, WebContentsView, type BrowserWindow } from 'electron'

/**
 * The window a sign-in or a connector's sign-in is shown in: a small browser
 * with its address in a bar on top, where it can be read and changed, and a
 * close button. It used to be a modal sheet, which on macOS has no title bar:
 * once open it could not be dismissed.
 *
 * Two views in one window: the bar (a page of ours, no preload) and the page.
 * The bar speaks to us only through its title (`superagent-bar://go?u=…`, a
 * counter keeps two of the same apart), read here; we speak to it with
 * `executeJavaScript`. A navigation to an unknown scheme is not a reliable
 * channel: it may never be reported.
 */

export const BAR_HEIGHT = 40

export interface AuthWindow {
  /** The page's web contents (not the bar's). */
  page: Electron.WebContents
  loadURL: (url: string) => void
  isDestroyed: () => boolean
  close: () => void
  onClosed: (fn: () => void) => void
}

/** What the bar asks for, from the address it navigated to. */
export function barRequest(url: string): { go: string } | { close: true } | { back: true } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'superagent-bar:') return null
  if (u.hostname === 'close') return { close: true }
  if (u.hostname === 'back') return { back: true }
  if (u.hostname !== 'go') return null
  const typed = (u.searchParams.get('u') ?? '').trim()
  if (!typed) return null
  const go = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`
  return /^https?:\/\//i.test(go) ? { go } : null
}

const BAR_HTML = `<!doctype html><meta charset="utf-8"><title>bar</title>
<style>
:root{color-scheme:light dark}
html,body{margin:0;height:100%;font:13px -apple-system,system-ui;background:#f4f4f5;color:#222}
@media (prefers-color-scheme:dark){html,body{background:#2a2a2c;color:#eee}input{background:#1c1c1e!important;color:#eee!important;border-color:#444!important}button{color:#ddd!important}}
form{display:flex;gap:6px;align-items:center;height:100%;padding:0 8px;box-sizing:border-box;border-bottom:1px solid rgba(0,0,0,.12)}
input{flex:1;height:26px;border:1px solid #d4d4d8;border-radius:7px;padding:0 9px;font:inherit;background:#fff;color:#222;outline:none;min-width:0}
input:focus{border-color:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.2)}
button{border:0;background:transparent;font:inherit;font-size:15px;width:28px;height:28px;border-radius:7px;color:#444;cursor:default}
button:hover{background:rgba(127,127,127,.18)}
</style>
<form id="f"><button type="button" id="back" title="Back" aria-label="Back">‹</button><input id="u" aria-label="Address" spellcheck="false" autocomplete="off"><button type="button" id="x" title="Close (Esc)" aria-label="Close">✕</button></form>
<script>
const u=document.getElementById('u')
let n=0
const ask=(s)=>{document.title=s+(s.includes('?')?'&':'?')+'n='+(++n)}
window.setUrl=(s)=>{if(document.activeElement!==u)u.value=s}
document.getElementById('f').onsubmit=(e)=>{e.preventDefault();ask('superagent-bar://go?u='+encodeURIComponent(u.value));u.blur()}
document.getElementById('x').onclick=()=>{ask('superagent-bar://close')}
document.getElementById('back').onclick=()=>{ask('superagent-bar://back')}
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'){if(document.activeElement===u){u.blur()}else{ask('superagent-bar://close')}}})
</script>`

export function openAuthWindow(opts: {
  title: string
  width: number
  height: number
  parent: BrowserWindow | null
  partition: string
  /** Called with the page's contents before anything loads (user agent and the like). */
  prepare?: (page: Electron.WebContents) => void
}): AuthWindow {
  const parent = opts.parent && !opts.parent.isDestroyed() ? opts.parent : undefined
  const win = new BaseWindow({
    width: opts.width,
    height: opts.height + BAR_HEIGHT,
    // A child window, not a modal sheet: it has a title bar and can be closed.
    parent,
    title: opts.title,
    show: false,
    minimizable: false,
    fullscreenable: false
  })
  const bar = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const view = new WebContentsView({
    webPreferences: {
      partition: opts.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.contentView.addChildView(bar)
  win.contentView.addChildView(view)
  const place = (): void => {
    const { width, height } = win.getContentBounds()
    bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT })
    view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) })
  }
  place()
  win.on('resize', place)
  opts.prepare?.(view.webContents)
  win.show()
  view.webContents.focus()

  const page = view.webContents
  const showUrl = (): void => {
    if (bar.webContents.isDestroyed() || page.isDestroyed()) return
    const url = page.getURL()
    void bar.webContents
      .executeJavaScript(
        `window.setUrl && window.setUrl(${JSON.stringify(url.startsWith('data:') ? '' : url)})`
      )
      .catch(() => {})
  }
  page.on('did-navigate', showUrl)
  page.on('did-navigate-in-page', showUrl)
  page.on('page-title-updated', (_e, t) => !win.isDestroyed() && win.setTitle(t || opts.title))
  bar.webContents.on('did-finish-load', showUrl)

  const close = (): void => {
    if (!win.isDestroyed()) win.close()
  }
  bar.webContents.on('will-navigate', (e) => e.preventDefault())
  bar.webContents.on('page-title-updated', (e, title) => {
    e.preventDefault()
    const asked = barRequest(title)
    if (!asked) return
    if ('close' in asked) close()
    else if ('back' in asked) {
      if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack()
    } else void page.loadURL(asked.go)
  })
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Esc closes it from the page as well.
  page.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') close()
  })
  void bar.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BAR_HTML))

  win.on('closed', () => {
    for (const v of [bar, view]) if (!v.webContents.isDestroyed()) v.webContents.close()
  })

  return {
    page,
    loadURL: (url) => {
      if (!page.isDestroyed()) void page.loadURL(url)
    },
    isDestroyed: () => win.isDestroyed(),
    close,
    onClosed: (fn) => win.on('closed', fn)
  }
}
