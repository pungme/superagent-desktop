import { test, _electron as electron } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Not a test: a CPU profile of the window on a copy of real data (PROFILE_DATA, PROFILE_CHAT). */
test.skip(
  !process.env.PROFILE_DATA,
  'PROFILE_DATA=<userData copy> PROFILE_CHAT=<id> PROFILE_PROJECT=<name> to run'
)

test('profile the window on a big chat', async () => {
  test.setTimeout(240_000)
  const data = process.env.PROFILE_DATA!
  const chatId = process.env.PROFILE_CHAT!
  const project = process.env.PROFILE_PROJECT!
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, NODE_ENV: 'production' }
  })
  await app.firstWindow()
  await new Promise((r) => setTimeout(r, 1500))
  // The app window, not the dot (real data has the dot on).
  const page =
    (await app.windows()).find((w) => !w.url().includes('#dot')) ?? (await app.firstWindow())
  await page.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as { fake?: string[] }
    g.fake = []
    ipcMain.removeHandler('agent:start')
    ipcMain.handle('agent:start', () => {
      g.fake!.push('prof-agent')
      return 'prof-agent'
    })
    ipcMain.removeHandler('agent:suggestTitle')
    ipcMain.handle('agent:suggestTitle', () => null)
    ipcMain.removeAllListeners('agent:send')
    ipcMain.on('agent:send', () => {})
    return 'ok'
  })
  await page.click(`.sidebar-item:has-text("${project}")`)
  await page.locator(`[data-chat-id="${chatId}"]`).first().click()
  await page.waitForSelector('.easy-assistant:visible', { timeout: 60_000 })
  await page.waitForTimeout(3000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
  const metrics = (): Promise<number> =>
    app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((m) => m.type === 'Tab')
        .reduce((n, m) => n + m.cpu.percentCPUUsage, 0)
    )
  await metrics()
  // Idle: the chat open, nothing happening.
  await cdp.send('Profiler.start')
  await page.waitForTimeout(5000)
  const idle = await cdp.send('Profiler.stop')
  const idleCpu = await metrics()
  writeFileSync('/tmp/sa-prof-idle.json', JSON.stringify(idle.profile))
  // Streaming: a fake agent types ~180 tokens at 30/s.
  const input = page.locator('textarea.easy-input:visible')
  await input.fill('profile this')
  await input.press('Enter')
  await page.waitForTimeout(500)
  const send = (e: unknown): Promise<void> =>
    app.evaluate(
      ({ BrowserWindow }, event) =>
        BrowserWindow.getAllWindows()[0].webContents.send('agent:event:prof-agent', event),
      e
    )
  await send({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'text' } }
  })
  await metrics()
  await cdp.send('Profiler.start')
  const t0 = Date.now()
  for (let i = 0; i < 180; i++) {
    await send({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `word${i} ` } }
    })
    await page.waitForTimeout(33)
  }
  const streamed = await cdp.send('Profiler.stop')
  const streamCpu = await metrics()
  writeFileSync('/tmp/sa-prof-stream.json', JSON.stringify(streamed.profile))
  console.log(
    `PROFILE idleCpu=${idleCpu.toFixed(0)}% streamCpu=${streamCpu.toFixed(0)}% streamWall=${Date.now() - t0}ms`
  )
  await send({ type: 'stream_event', event: { type: 'content_block_stop' } })
  await send({ type: 'result', subtype: 'success', usage: {} })
  await page.waitForTimeout(500)
  await app.close()
})
