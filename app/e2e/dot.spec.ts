import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The dot: Superagent as a tile in the corner of the screen, with a panel to
 * ask from. The agent is stood in for (a request would start a real one): the
 * chat's events are sent to the dot as main would send them, and what it shows
 * for each is checked.
 */
let app: ElectronApplication
let dot: Page
let main: Page
let data: string
let proj: string
const SHOT = process.env.SHOT ? (name: string): string => `/tmp/sa-dot-${name}.png` : null

async function shoot(name: string): Promise<void> {
  if (!SHOT) return
  // Past the entrance and colour transitions.
  await dot.waitForTimeout(500)
  await dot.screenshot({ path: SHOT(name)!, omitBackground: true })
}
/** A chat event, as main forwards it. */
const event = (data: Record<string, unknown>): Promise<void> =>
  app.evaluate(
    ({ BrowserWindow }, p) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('dot:event', p)
    },
    { chatId: 'chat-1', data }
  )

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-dot-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-dot-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_DOT: '1',
      NODE_ENV: 'production'
    }
  })
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  const pages = app.windows()
  dot = pages.find((p) => p.url().endsWith('#dot'))!
  main = pages.find((p) => !p.url().endsWith('#dot'))!
  await dot.waitForSelector('.dot-tile', { timeout: 20_000 })
  // Requests are recorded, not sent to an agent.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { asked: unknown[]; answered: unknown[]; stopped: string[] }
    g.asked = []
    g.answered = []
    g.stopped = []
    ipcMain.removeHandler('dot:ask')
    ipcMain.handle('dot:ask', (_e, workspaceId: string, text: string, into?: string) => {
      g.asked.push({ workspaceId, text, into: into ?? null })
      return { ok: true, chatId: 'chat-1', workspaceId }
    })
    ipcMain.removeHandler('dot:answer')
    ipcMain.handle('dot:answer', (_e, id: string, approve: boolean) => {
      g.answered.push({ id, approve })
      return true
    })
    ipcMain.removeHandler('dot:stop')
    ipcMain.handle('dot:stop', (_e, chatId: string) => {
      g.stopped.push(chatId)
      return true
    })
  })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) if (d) rmSync(d, { recursive: true, force: true })
})

test('it is a tile until asked, and the main window is still the app', async () => {
  await expect(dot.locator('.dot-tile')).toBeVisible()
  await expect(dot.locator('.dot-panel')).toHaveCount(0)
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-idle/)
  // The app's own window is untouched by there being a second one.
  await main.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await main.reload()
  await expect(main.locator('.sidebar')).toBeVisible({ timeout: 20_000 })
  await expect(main.locator('.dot-tile')).toHaveCount(0)
  await shoot('1-idle')
})

test('its window floats over everything, in the corner, and lets clicks through', async () => {
  const w = await app.evaluate(({ BrowserWindow, screen, globalShortcut }) => {
    // A window on its way out answers nothing; it is not one of ours to count.
    const urlOf = (w: {
      isDestroyed(): boolean
      webContents: { getURL(): string }
    }): string | null => {
      try {
        return w.isDestroyed() ? null : w.webContents.getURL()
      } catch {
        return null
      }
    }
    const win = BrowserWindow.getAllWindows().find((x) => (urlOf(x) ?? '').endsWith('#dot'))!
    const area = screen.getPrimaryDisplay().workArea
    const b = win.getBounds()
    return {
      onTop: win.isAlwaysOnTop(),
      everySpace: win.isVisibleOnAllWorkspaces(),
      resizable: win.isResizable(),
      // Bottom right of the screen's usable area.
      right: area.x + area.width - (b.x + b.width),
      bottom: area.y + area.height - (b.y + b.height),
      hotkey: globalShortcut.isRegistered('Alt+Space')
    }
  })
  expect(w).toEqual({
    onTop: true,
    everySpace: true,
    resizable: false,
    right: 0,
    bottom: 0,
    hotkey: true
  })

  // Solid only where something is drawn: main is told as the pointer crosses.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { solid: boolean[] }
    g.solid = []
    ipcMain.on('dot:solid', (_e, v: boolean) => g.solid.push(v))
  })
  const tile = (await dot.locator('.dot-tile').boundingBox())!
  await dot.mouse.move(40, 40)
  await dot.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2)
  await dot.mouse.move(40, 40)
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { solid: boolean[] }).solid))
    .toEqual([true, false])
})

test('dragging the tile moves it, and it stays where it was left', async () => {
  const where = (): Promise<{ x: number; y: number }> =>
    app.evaluate(({ BrowserWindow }) => {
      // A window on its way out answers nothing; it is not one of ours to count.
      const urlOf = (w: {
        isDestroyed(): boolean
        webContents: { getURL(): string }
      }): string | null => {
        try {
          return w.isDestroyed() ? null : w.webContents.getURL()
        } catch {
          return null
        }
      }
      const b = BrowserWindow.getAllWindows()
        .find((x) => (urlOf(x) ?? '').endsWith('#dot'))!
        .getBounds()
      return { x: b.x, y: b.y }
    })
  const before = await where()
  const tile = (await dot.locator('.dot-tile').boundingBox())!
  const cx = tile.x + tile.width / 2
  const cy = tile.y + tile.height / 2
  await dot.mouse.move(cx, cy)
  await dot.mouse.down()
  await dot.mouse.move(cx - 60, cy - 40, { steps: 6 })
  await dot.mouse.up()
  const after = await where()
  expect(after.x).toBeLessThan(before.x)
  expect(after.y).toBeLessThan(before.y)
  // A drag is not a click: the panel did not open.
  await expect(dot.locator('.dot-panel')).toHaveCount(0)
  // Remembered for the next launch.
  await expect
    .poll(() => main.evaluate(() => window.cove.kvAll().then((k) => k['dot.position'] ?? '')))
    .toContain(`"x":${after.x}`)
})

test('a click opens the panel on the Computer, with things to ask', async () => {
  await dot.locator('.dot-tile').click()
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.dot-chip-name')).toHaveText('Computer')
  await expect(panel.locator('.dot-input')).toBeFocused()
  await expect(panel.locator('.dot-suggestion').first()).toBeVisible()
  await expect(panel).toContainText('Tidy my Downloads folder')
  await shoot('2-ask')
})

test('the project can be picked by name, and is where the request goes', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await panel.locator('.dot-chip').click()
  const list = dot.getByRole('listbox', { name: 'Projects' })
  await expect(list.locator('.dot-item').first()).toContainText('Computer')
  await expect(list).toContainText('e2e-project')
  await shoot('3-projects')
  // The arrow keys move through it, starting from the one in use, and wrap.
  const on = list.locator('.dot-item.on .dot-item-name')
  await expect(on).toHaveText('Computer')
  await list.locator('.dot-find').press('ArrowDown')
  await expect(on).toHaveText('e2e-project')
  await list.locator('.dot-find').press('ArrowDown')
  await expect(on).toHaveText('Computer')
  await list.locator('.dot-find').press('ArrowUp')
  await expect(on).toHaveText('e2e-project')
  await list.locator('.dot-find').press('ArrowUp')
  // Typing narrows it; Enter takes the first match.
  await list.locator('.dot-find').fill('e2e')
  await expect(list.locator('.dot-item')).toHaveCount(1)
  await list.locator('.dot-find').press('Enter')
  await expect(panel.locator('.dot-chip-name')).toHaveText('e2e-project')
  // A project gets questions about a project, not about the Mac.
  await expect(panel).toContainText('What changed here this week?')
  await expect(panel).not.toContainText('Tidy my Downloads folder')

  await panel.locator('.dot-input').fill('Why is the deploy failing?')
  await panel.locator('.dot-input').press('Enter')
  const asked = await app.evaluate(
    () => (globalThis as unknown as { asked: { workspaceId: string; text: string }[] }).asked
  )
  expect(asked).toHaveLength(1)
  expect(asked[0].text).toBe('Why is the deploy failing?')
  expect(asked[0].workspaceId).not.toBe('__desktop_chat__')
  await expect(panel.locator('.dot-you')).toHaveText('Why is the deploy failing?')
  await expect(panel.locator('.dot-input')).toHaveValue('')
})

test('while it works it shows the steps, and can be stopped', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-working/)
  await expect(panel.locator('.dot-step.now')).toHaveText('Starting…')
  await event({ kind: 'tool', id: 't1', name: 'Bash', detail: 'gh run list --limit 3' })
  await event({
    kind: 'tool',
    id: 't2',
    name: 'Read',
    detail: '/repo/.github/workflows/deploy.yml'
  })
  await expect(panel.locator('.dot-step')).toHaveText([
    'Running a command · gh run list --limit 3',
    'Reading · deploy.yml'
  ])
  await expect(panel.locator('.dot-step.now')).toHaveText('Reading · deploy.yml')
  await shoot('4-working')
  await panel.getByRole('button', { name: 'Stop' }).click()
  expect(
    await app.evaluate(() => (globalThis as unknown as { stopped: string[] }).stopped)
  ).toEqual(['chat-1'])
})

test('it goes amber and asks before anything risky, and passes the answer on', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await event({
    kind: 'approval',
    id: 'gate-1',
    toolName: 'mcp__cove-browser__mail_send',
    preview: 'Send email to caspar@example.com\nSubject: Deploy is fixed',
    approvalKind: 'permission',
    expiresAt: Date.now() + 60_000
  })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-needs/)
  await expect(panel.locator('.dot-approval')).toContainText('caspar@example.com')
  await shoot('5-needs-you')
  await panel.getByRole('button', { name: 'Allow' }).click()
  expect(
    await app.evaluate(() => (globalThis as unknown as { answered: unknown[] }).answered)
  ).toEqual([{ id: 'gate-1', approve: true }])
  await event({ kind: 'approval_end', id: 'gate-1', outcome: 'approved', by: 'desktop' })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-working/)
})

test('stuck in the browser, it sends you to the browser rather than asking to allow', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await event({
    kind: 'approval',
    id: 'handoff-1',
    toolName: 'mcp__cove-browser__browser_ask_user',
    preview: 'Sign in to Shopify, then press Done',
    approvalKind: 'handoff',
    expiresAt: Date.now() + 60_000
  })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-needs/)
  await expect(panel.locator('.dot-approval')).toContainText('Sign in to Shopify')
  await expect(panel).toContainText('It needs you in the browser.')
  // Nothing to allow or refuse from here.
  await expect(panel.getByRole('button', { name: 'Allow' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Open in Superagent', exact: true })).toBeVisible()
  await event({ kind: 'approval_end', id: 'handoff-1', outcome: 'approved', by: 'desktop' })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-working/)
})

test('the answer lands by the dot, with a way to the whole conversation', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await event({
    kind: 'assistant',
    id: 'a1',
    text: 'The **migration step** fails: `users.email` already exists on dev.'
  })
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
  await expect(panel.locator('.dot-answer')).toContainText('migration step')
  await expect(panel.locator('.dot-answer strong')).toHaveText('migration step')
  await expect(panel.getByRole('button', { name: /Open in Superagent/ })).toBeVisible()
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-idle/)
  await shoot('6-done')
  // Escape closes it; the tile stays.
  await panel.locator('.dot-input').press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(dot.locator('.dot-tile')).toBeVisible()
})

test('an answer that arrives while it is closed shows on the tile until looked at', async () => {
  await dot.locator('.dot-tile').click()
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  // Asked with the last answer still on screen, it is a follow-up: the same
  // conversation, so the agent knows what "the staging one" refers to.
  await panel.locator('.dot-input').fill('And the staging one?')
  await panel.locator('.dot-input').press('Enter')
  const asks = await app.evaluate(
    () => (globalThis as unknown as { asked: { text: string; into: string | null }[] }).asked
  )
  expect(asks.map((a) => a.into)).toEqual([null, 'chat-1'])
  await expect(panel.locator('.dot-you')).toHaveText('And the staging one?')
  await expect(panel.locator('.dot-answer')).toHaveCount(0)
  await panel.locator('.dot-input').press('Escape')
  await expect(panel).toHaveCount(0)
  // Working, closed: the tile says whose work it is.
  await expect(dot.locator('.dot-tag')).toContainText('e2e-project')
  await event({ kind: 'assistant', id: 'a2', text: 'Staging is healthy.' })
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-done/)
  await expect(dot.locator('.dot-badge')).toHaveText('1')
  await expect(dot.locator('.dot-tag')).toHaveCount(0)
  await shoot('7-unseen')
  await dot.locator('.dot-tile').click()
  await expect(dot.locator('.dot-badge')).toHaveCount(0)
  await expect(panel.locator('.dot-answer')).toContainText('Staging is healthy.')
})

test('closing the app window leaves the dot, and a Dock click brings the app back', async () => {
  const appWindows = (): Promise<number> =>
    app.evaluate(({ BrowserWindow }) => {
      // A window on its way out answers nothing; it is not one of ours to count.
      const urlOf = (w: {
        isDestroyed(): boolean
        webContents: { getURL(): string }
      }): string | null => {
        try {
          return w.isDestroyed() ? null : w.webContents.getURL()
        } catch {
          return null
        }
      }
      return BrowserWindow.getAllWindows().filter(
        (w) => urlOf(w) !== null && !urlOf(w)!.endsWith('#dot')
      ).length
    })
  expect(await appWindows()).toBe(1)
  await app.evaluate(({ BrowserWindow }) => {
    // A window on its way out answers nothing; it is not one of ours to count.
    const urlOf = (w: {
      isDestroyed(): boolean
      webContents: { getURL(): string }
    }): string | null => {
      try {
        return w.isDestroyed() ? null : w.webContents.getURL()
      } catch {
        return null
      }
    }
    BrowserWindow.getAllWindows()
      .find((w) => urlOf(w) !== null && !urlOf(w)!.endsWith('#dot'))!
      .close()
  })
  await expect.poll(appWindows).toBe(0)
  // The dot is still there and still works.
  await expect(dot.locator('.dot-tile')).toBeVisible()
  // What a click on the Dock icon does.
  await app.evaluate(({ app: a }) => {
    a.emit('activate')
  })
  await expect.poll(appWindows, { timeout: 15_000 }).toBe(1)
  const appPage = (): Page | undefined =>
    app.windows().find((p) => p.url().includes('index.html') && !p.url().endsWith('#dot'))
  await expect.poll(() => !!appPage(), { timeout: 15_000 }).toBe(true)
  main = appPage()!
  await main.waitForSelector('.sidebar', { timeout: 20_000 })
})

test('a question the agent asks as choices shows as buttons, and a click answers it', async () => {
  if ((await dot.locator('.dot-panel').count()) === 0) await dot.locator('.dot-tile').click()
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  const before = await app.evaluate(
    () => (globalThis as unknown as { asked: unknown[] }).asked.length
  )
  await event({
    kind: 'assistant',
    id: 'a9',
    text:
      'Two ways to do it.\n\n```ask\n' +
      JSON.stringify({
        question: 'Which one?',
        multiple: false,
        options: [{ label: 'Rebase', hint: 'Keeps history straight' }, { label: 'Merge' }]
      }) +
      '\n```'
  })
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
  const choices = panel.getByRole('group', { name: 'Which one?' })
  await expect(choices.locator('.dot-choice')).toHaveText(['RebaseKeeps history straight', 'Merge'])
  // The JSON it is written as never shows.
  await expect(panel.locator('.dot-answer')).not.toContainText('"options"')
  await expect(panel.locator('.dot-answer')).toContainText('Two ways to do it.')
  await shoot('8-choices')
  await choices.getByRole('button', { name: /Merge/ }).click()
  const asked = await app.evaluate(
    () => (globalThis as unknown as { asked: { text: string; into: string | null }[] }).asked
  )
  expect(asked).toHaveLength(before + 1)
  // The pick goes into the same conversation, as your answer.
  expect(asked[asked.length - 1]).toMatchObject({ text: 'Merge', into: 'chat-1' })
  await expect(panel.locator('.dot-you')).toHaveText('Merge')
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
})

test('a question with several answers lets you tick them, then Send', async () => {
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  await event({
    kind: 'assistant',
    id: 'a10',
    text:
      '```ask\n' +
      JSON.stringify({
        question: 'Which checks?',
        multiple: true,
        options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Build' }]
      }) +
      '\n```'
  })
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
  const choices = panel.getByRole('group', { name: 'Which checks?' })
  const send = choices.getByRole('button', { name: 'Send', exact: true })
  // Nothing ticked, nothing to send.
  await expect(send).toBeDisabled()
  await choices.getByRole('button', { name: 'Lint' }).click()
  await choices.getByRole('button', { name: 'Build' }).click()
  await expect(choices.getByRole('button', { name: 'Lint' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  // A tick comes off again.
  await choices.getByRole('button', { name: 'Lint' }).click()
  await choices.getByRole('button', { name: 'Tests' }).click()
  await send.click()
  const asked = await app.evaluate(
    () => (globalThis as unknown as { asked: { text: string; into: string | null }[] }).asked
  )
  // In the order they were ticked, in the same conversation.
  expect(asked[asked.length - 1]).toMatchObject({ text: 'Build, Tests', into: 'chat-1' })
  await event({ kind: 'turn_end', ok: true, subtype: 'success' })
})

test('a request that cannot be sent says why, and keeps what was typed', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('dot:ask')
    ipcMain.handle('dot:ask', () => ({ ok: false, error: 'Claude Code is not signed in.' }))
  })
  if ((await dot.locator('.dot-panel').count()) === 0) await dot.locator('.dot-tile').click()
  const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
  const clear = panel.getByRole('button', { name: 'Clear' })
  if (await clear.count()) await clear.click()
  await panel.locator('.dot-input').fill('Is it up?')
  await panel.locator('.dot-input').press('Enter')
  await expect(panel.getByRole('alert')).toHaveText('Claude Code is not signed in.')
  await expect(panel.locator('.dot-input')).toHaveValue('Is it up?')
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-idle/)
  // Dark whatever the app's theme is: an answer in the light theme's ink
  // would not show on its panel.
  expect(await dot.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
  await panel.locator('.dot-input').press('Escape')
})

test('the shortcut can be changed, and Settings says when another app has it', async () => {
  await main.click('.sidebar-settings[title="Settings"]')
  // The row with the choice in it (the switch's own description mentions a shortcut too).
  const row = main.locator('.settings-row', { has: main.getByLabel('Shortcut for the dot') })
  const pick = row.getByLabel('Shortcut for the dot')
  await expect(pick).toHaveValue('Alt+Space')
  const registered = (acc: string): Promise<boolean> =>
    app.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), acc)

  await pick.selectOption('Control+Alt+Space')
  expect(await registered('Control+Alt+Space')).toBe(true)
  // The old one is let go of, not left held for nothing.
  expect(await registered('Alt+Space')).toBe(false)
  await expect(row).toContainText('Opens the dot from anywhere')
  // The tile's tooltip says the same.
  await expect(dot.locator('.dot-tile')).toHaveAttribute('title', /⌃⌥ Space/)

  // None: no shortcut at all.
  await pick.selectOption('none')
  expect(await registered('Control+Alt+Space')).toBe(false)
  await expect(dot.locator('.dot-tile')).toHaveAttribute('title', 'Ask Superagent')

  // One that is taken: the system says no, and Settings says so.
  await app.evaluate(({ globalShortcut }) => {
    const real = globalShortcut.register.bind(globalShortcut)
    globalShortcut.register = ((acc: string, cb: () => void) =>
      acc === 'Alt+Shift+Space' ? false : real(acc, cb)) as typeof globalShortcut.register
  })
  await pick.selectOption('Alt+Shift+Space')
  await expect(row).toContainText('⌥⇧ Space is already used by another app')
  await expect(pick).toHaveClass(/warn/)
  await expect(dot.locator('.dot-tile')).toHaveAttribute('title', 'Ask Superagent')
  // Back to the default, which is free.
  await pick.selectOption('Alt+Space')
  await expect(row).toContainText('Opens the dot from anywhere')
  expect(await registered('Alt+Space')).toBe(true)
  if (process.env.SHOT)
    await main
      .locator('.settings-row', { hasText: 'Show Superagent as a floating dot' })
      .locator('xpath=..')
      .screenshot({ path: '/tmp/sa-dot-settings.png' })
})

test('while an agent is using the Mac, the tile says so and can stop it', async () => {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = globalThis as unknown as { stops: number }
    g.stops = 0
    ipcMain.removeHandler('computer:stop')
    ipcMain.handle('computer:stop', () => {
      g.stops++
      return []
    })
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('computer:active', true)
  })
  await expect(dot.locator('.dot-tile')).toHaveClass(/dot-controlling/)
  const tag = dot.locator('.dot-control')
  await expect(tag).toContainText('Using your Mac')
  await expect(tag).toContainText('⌥Esc')
  await shoot('9-controlling')
  await tag.click()
  expect(await app.evaluate(() => (globalThis as unknown as { stops: number }).stops)).toBe(1)
  // ⌥Esc, or it going quiet, clears it.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('computer:stopped')
  })
  await expect(dot.locator('.dot-control')).toHaveCount(0)
  await expect(dot.locator('.dot-tile')).not.toHaveClass(/dot-controlling/)
})

test('computer use is off until turned on, and shows which permissions it still needs', async () => {
  // The permissions as macOS would report them, stood in for.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as {
      cu: { enabled: boolean; screen: boolean; accessibility: boolean; asked: string[] }
    }
    g.cu = { enabled: false, screen: false, accessibility: true, asked: [] }
    const status = (): unknown => ({ supported: true, helper: true, ...g.cu, asked: undefined })
    for (const ch of [
      'computer:status',
      'computer:set-enabled',
      'computer:request',
      'computer:open-settings',
      'computer:check'
    ])
      ipcMain.removeHandler(ch)
    ipcMain.handle('computer:status', status)
    ipcMain.handle('computer:set-enabled', (_e, on: boolean) => {
      g.cu.enabled = on
      return status()
    })
    ipcMain.handle('computer:request', (_e, which: string) => {
      g.cu.asked.push(which)
      return status()
    })
    ipcMain.handle('computer:open-settings', (_e, which: string) => {
      g.cu.asked.push(`open:${which}`)
    })
    // Really trying: seeing fails until Screen Recording is truly in force.
    ipcMain.handle('computer:check', () =>
      g.cu.screen
        ? { see: true, act: true, via: 'capturer', size: '1440×900', error: '' }
        : { see: false, act: true, via: '', size: '', error: 'The screen could not be captured.' }
    )
  })
  // Leave Settings and come back, so it reads the status afresh.
  await main.reload()
  await main.waitForSelector('.sidebar', { timeout: 20_000 })
  await main.click('.sidebar-settings[title="Settings"]')
  const row = main.locator('.settings-row', { hasText: 'Let agents use this Mac' })
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked()
  // Nothing about permissions until it is wanted.
  await expect(main.locator('.settings-row', { hasText: 'Screen Recording' })).toHaveCount(0)

  await row.locator('.switch').click()
  await expect(row.locator('input[type="checkbox"]')).toBeChecked()
  const screenRow = main.locator('.settings-row', { hasText: 'Screen Recording' })
  const accessRow = main.locator('.settings-row', { hasText: 'Accessibility' })
  await expect(accessRow).toContainText('Granted')
  await expect(screenRow).toContainText('Not granted yet')
  if (process.env.SHOT)
    await row.locator('xpath=..').screenshot({ path: '/tmp/sa-computer-settings.png' })
  // A real try, which says what is wrong rather than what macOS reports.
  const check = main.locator('.settings-row', { hasText: 'Check it works' })
  await check.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(check).toContainText('The screen could not be captured.')
  await screenRow.getByRole('button', { name: 'Grant…' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { cu: { asked: string[] } }).cu.asked))
    .toEqual(['screen', 'open:screen'])
  // Granted in System Settings: noticed here without a click.
  await app.evaluate(() => {
    ;(globalThis as unknown as { cu: { screen: boolean } }).cu.screen = true
  })
  await expect(screenRow).toContainText('Granted', { timeout: 6000 })
  await expect(screenRow.getByRole('button', { name: 'Grant…' })).toHaveCount(0)
  await check.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(check).toContainText(
    'It can see the screen (1440×900) and use the mouse and keyboard.'
  )
  if (process.env.SHOT)
    await row.locator('xpath=..').screenshot({ path: '/tmp/sa-computer-settings.png' })
})

test('it can be turned off in Settings, and back on', async () => {
  if ((await main.locator('.settings-row').count()) === 0)
    await main.click('.sidebar-settings[title="Settings"]')
  const row = main.locator('.settings-row', { hasText: 'Show Superagent as a floating dot' })
  await expect(row.locator('input[type="checkbox"]')).toBeChecked()
  await row.locator('.switch').click()
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked()
  await expect.poll(() => app.windows().length).toBe(1)
  await row.locator('.switch').click()
  await expect(row.locator('input[type="checkbox"]')).toBeChecked()
  await expect.poll(() => app.windows().length).toBe(2)
})
