import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '..', '..', '..', '.superagent', 'bg-tasks')

/**
 * The "Running in background" strip: five near-identical watchers fold into one
 * pill with a count, "Stop duplicates" asks the agent once, and a task the CLI
 * no longer lists (background_tasks_changed) is dropped instead of lingering.
 * The agent is stood in for; its events are the CLI's real shapes.
 */
test('the background strip folds duplicates and lets go of tasks the CLI dropped', async () => {
  test.setTimeout(90_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-twice-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-twice-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { fake: string[]; sent: string[] }
      g.fake = []
      g.sent = []
      ipcMain.removeHandler('agent:start')
      ipcMain.handle('agent:start', () => {
        g.fake.push(`fake-${g.fake.length + 1}`)
        return g.fake[g.fake.length - 1]
      })
      ipcMain.removeHandler('agent:suggestTitle')
      ipcMain.handle('agent:suggestTitle', () => null)
      ipcMain.removeAllListeners('agent:send')
      ipcMain.on('agent:send', (_e, _id: string, text: string) => g.sent.push(text))
    })
    await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')

    const sent = (): Promise<string[]> =>
      app.evaluate(() => (globalThis as unknown as { sent: string[] }).sent)
    const send = (event: unknown): Promise<void> =>
      app.evaluate(({ BrowserWindow }, e) => {
        const g = globalThis as unknown as { fake: string[] }
        BrowserWindow.getAllWindows()[0].webContents.send(
          `agent:event:${g.fake[g.fake.length - 1]}`,
          e
        )
      }, event)

    const watch = (n: number, description: string): Promise<void> =>
      send({
        type: 'assistant',
        message: {
          id: `m${n}`,
          content: [
            {
              type: 'tool_use',
              id: `toolu_${n}`,
              name: 'Bash',
              input: { command: `gh run watch ${n}`, run_in_background: true, description }
            }
          ]
        }
      })
    const input = page.locator('textarea.easy-input:visible')
    await input.fill('watch the deploy')
    await input.press('Enter')
    await expect.poll(async () => (await sent()).length).toBe(1)
    for (let n = 1; n <= 5; n++) {
      await watch(n, 'Keep streaming the prod v8.6.2 watch')
      await send({
        type: 'system',
        subtype: 'task_started',
        task_id: `b${n}`,
        tool_use_id: `toolu_${n}`,
        task_type: 'local_bash',
        description: 'x'
      })
    }
    await watch(6, 'Wait for the WD-208 rescore check')
    await send({
      type: 'system',
      subtype: 'task_started',
      task_id: 'b6',
      tool_use_id: 'toolu_6',
      task_type: 'local_bash',
      description: 'y'
    })
    const strip = page.locator('.easy-runs:visible')
    // Five identical watchers are ONE pill with a count.
    await expect(strip.locator('.easy-run-pill')).toHaveCount(2)
    await expect(strip.locator('.easy-run-pill').first()).toContainText('×5')
    await expect(strip.getByText('Stop duplicates')).toBeVisible()
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, 'strip-folded.png'), clip: await clipOf(strip) })

    // One ask to the agent, for the four older copies.
    await strip.getByText('Stop duplicates').click()
    await expect.poll(async () => (await sent()).length).toBe(2)
    const ask = (await sent())[1]
    expect(ask).toContain('Stop these 4 background jobs')
    expect(ask).toContain('TaskStop')
    expect(ask.match(/task b\d/g)).toHaveLength(4)
    expect(ask).not.toContain('task b5')
    await expect(strip.locator('.easy-run-pill')).toHaveCount(2)
    await expect(strip.locator('.easy-run-pill').first()).not.toContainText('×')

    // The CLI says only b6 is still live: b5 was a ghost and goes without a click.
    await send({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b6', task_type: 'local_bash', description: 'y' }]
    })
    // It is only seconds old, so it is kept for the grace period; the strip's own
    // clock re-checks it against the live list and drops it after.
    await expect(strip.locator('.easy-run-pill')).toHaveCount(2)
    await expect(strip.locator('.easy-run-pill')).toHaveCount(1, { timeout: 40_000 })
    await expect(strip).toContainText('WD-208')
    await page.screenshot({ path: join(SHOTS, 'strip-reconciled.png'), clip: await clipOf(strip) })
    // And an empty list takes the strip away.
    await send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    await expect(page.locator('.easy-runs:visible')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})

async function clipOf(
  loc: import('@playwright/test').Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = (await loc.boundingBox())!
  return {
    x: Math.max(0, b.x - 12),
    y: Math.max(0, b.y - 12),
    width: b.width + 24,
    height: b.height + 24
  }
}
