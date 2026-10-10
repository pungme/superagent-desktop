// Spike target: a Chromium window nobody can see or focus, reporting the mouse events its page gets.
const { app, BrowserWindow } = require('electron')
app.dock?.hide()
app.whenReady().then(() => {
  const w = new BrowserWindow({
    x: 40, y: 300, width: 320, height: 220, show: false, frame: false, focusable: false,
    webPreferences: { backgroundThrottling: false }
  })
  w.setOpacity(0)
  w.setIgnoreMouseEvents(true)
  w.webContents.on('console-message', (_e, _l, m) => console.log('PAGE ' + m))
  w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0"><button id=b style="position:absolute;left:20px;top:20px;width:120px;height:40px">Press</button>
<canvas id=c width=120 height=80 style="position:absolute;left:180px;top:20px;background:#ccc"></canvas>
<input id=i style="position:absolute;left:20px;top:120px;width:200px">
<script>
for (const t of ['mousedown','mouseup','click','contextmenu','auxclick','wheel','keydown','input'])
  addEventListener(t, e => console.log(t + ' x=' + e.clientX + ' y=' + e.clientY + ' button=' + e.button + ' trusted=' + e.isTrusted + ' target=' + (e.target.id||e.target.tagName) + ' activation=' + navigator.userActivation.hasBeenActive + (e.key ? ' key=' + e.key : '')), true)
console.log('LOADED focus=' + document.hasFocus())
</script>`))
  w.webContents.once('did-finish-load', () => {
    if (process.env.SHOWN === '1') w.showInactive()
    console.log('READY pid=' + process.pid + ' shown=' + w.isVisible())
  })
  setTimeout(() => app.quit(), 45000)
})
