import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('75 MB history streams incrementally and survives a killed process without duplicates', async () => {
  test.setTimeout(180_000)
  const data = mkdtempSync(join(tmpdir(), 'sa-persistence-'))
  const proj = mkdtempSync(join(tmpdir(), 'sa-persistence-project-'))
  writeFileSync(join(proj, 'README.md'), '# synthetic persistence fixture')
  const db = join(data, 'cove.db'), incremental = join(data, 'transcripts.sqlite')
  const sql = (file: string, query: string): string => execFileSync('/usr/bin/sqlite3', [file, query]).toString().trim()
  const launch = (): Promise<ElectronApplication> => electron.launch({args:[join(__dirname,'../out/main/index.js')], env:{...process.env,COVE_USER_DATA:data,COVE_E2E_PROJECT:proj,NODE_ENV:'production'}})
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const id = await page.evaluate(async () => {
      localStorage.setItem('cove.onboarded','1'); localStorage.setItem('cove.connectionsOffered','1')
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap(g=>g.workspaces).find(w=>w.name==='e2e-project')!
      return window.cove.chatCreate(ws.id)
    })
    await app.close()
    // No real conversation contents: representative large immutable history, 1,000 items.
    const legacyBytes = Number(execFileSync('python3',['-c',`
import sqlite3,json,sys
con=sqlite3.connect(sys.argv[1])
items=[{'kind':'thinking','id':'old-'+str(i),'text':'historical thought '+('x'*74900)} for i in range(1000)]
items.append({'kind':'msg','msg':{'id':'old-last','role':'assistant','text':'Existing history is intact.','at':1}})
raw=json.dumps(items,separators=(',',':'))
con.execute('UPDATE chats SET data=? WHERE id=?',(raw,sys.argv[2]));con.commit()
print(len(raw.encode()))
`,db,id]).toString())
    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('.sidebar',{timeout:30000})
    await app.evaluate(({ipcMain})=>{
      const g=globalThis as any; g.fake=[]
      ipcMain.removeHandler('agent:start'); ipcMain.handle('agent:start',()=>{g.fake.push('perf-agent');return 'perf-agent'})
      ipcMain.removeHandler('agent:suggestTitle');ipcMain.handle('agent:suggestTitle',()=>null)
      ipcMain.removeAllListeners('agent:send');ipcMain.on('agent:send',()=>{})
    })
    await page.click('.sidebar-item:has-text("e2e-project")')
    await expect(page.locator('.easy-assistant:visible').last()).toContainText('Existing history is intact.',{timeout:30000})
    expect(sql(incremental,`SELECT count(*) FROM transcript_items WHERE chatId='${id}'`)).toBe('1001')
    // Migration measured separately. Truncate WAL once so growth counts new WAL frame writes.
    sql(incremental,'PRAGMA wal_checkpoint(TRUNCATE)')
    await app.evaluate(()=>{
      const g=globalThis as any;g.lags=[];g.last=performance.now()
      g.timer=setInterval(()=>{const n=performance.now();g.lags.push(n-g.last);g.last=n},10)
    })
    await page.evaluate(()=>{
      const g=window as any;g.lags=[];g.last=performance.now()
      g.timer=setInterval(()=>{const n=performance.now();g.lags.push(n-g.last);g.last=n},10)
    })
    const input=page.locator('textarea.easy-input:visible')
    await input.fill('stream a persistence test');await input.press('Enter')
    await expect.poll(()=>app.evaluate(()=>(globalThis as any).fake.length)).toBeGreaterThan(0)
    const send=(e:unknown)=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('agent:event:perf-agent',event),e)
    await send({type:'stream_event',event:{type:'content_block_start',content_block:{type:'text'}}})
    let reply=''
    for(let i=0;i<100;i++){
      const part=`Token ${i}. `;reply+=part
      await send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:part}}})
      await page.waitForTimeout(100)
    }
    await send({type:'stream_event',event:{type:'content_block_stop'}})
    await send({type:'assistant',message:{id:'perf-reply',content:[{type:'text',text:reply}]}})
    await send({type:'result',subtype:'success',usage:{}})
    await expect.poll(()=>sql(incremental,`SELECT data FROM transcript_items WHERE chatId='${id}' ORDER BY position DESC LIMIT 1`)).toContain('Token 99.')
    const revision=Number(sql(incremental,`SELECT revision FROM transcripts WHERE id='${id}'`))
    const walBytes=statSync(incremental+'-wal').size
    const mainLags=await app.evaluate(()=>{clearInterval((globalThis as any).timer);return (globalThis as any).lags as number[]})
    const rendererLags=await page.evaluate(()=>{clearInterval((window as any).timer);return (window as any).lags as number[]})
    const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {p95:a[Math.floor(a.length*.95)],max:a[a.length-1]}}
    const result={legacyBytes,checkpoints:revision,walBytes,mainTimerMs:stats(mainLags),rendererTimerMs:stats(rendererLags)}
    console.log('PERSISTENCE_MEASUREMENTS',JSON.stringify(result))
    writeFileSync('transcript-performance.json',JSON.stringify(result,null,2))
    await page.screenshot({path:'transcript-performance.png'})
    expect(walBytes).toBeLessThan(2_000_000)
    expect(result.mainTimerMs.max).toBeLessThan(200)
    // Unclean termination, not graceful app.close: recovery must come from committed WAL.
    app.process().kill('SIGKILL')
    await new Promise<void>(resolve=>app.process().once('exit',()=>resolve()))
    app=await launch();page=await app.firstWindow()
    await page.waitForSelector('.sidebar',{timeout:30000})
    const recovered=await page.evaluate(async chatId=>JSON.parse((await window.cove.chatLoad(chatId))!),id)
    expect(recovered).toHaveLength(1003)
    expect(recovered.slice(0,1000).every((item:any,i:number)=>item.id===`old-${i}`&&item.text.length===74919)).toBe(true)
    expect(recovered.filter((item:any)=>item.kind==='msg'&&item.msg.text===reply)).toHaveLength(1)
    expect(recovered.filter((item:any)=>item.kind==='msg'&&item.msg.text==='stream a persistence test')).toHaveLength(1)
    expect(sql(db,`SELECT length(data) FROM chat_data WHERE id='${id}'`)).toBe(String(legacyBytes))
  } finally { await app.close().catch(()=>{});rmSync(data,{recursive:true,force:true});rmSync(proj,{recursive:true,force:true}) }
})
