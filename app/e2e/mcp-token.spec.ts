import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The tool server only answers a caller whose address was issued for the
 * conversation it names. An agent knows the server's address; writing another
 * chat's id into it must get it nothing: not that chat's browser, board or
 * mail, and not its yes to use the Mac. As the installed app runs
 * (COVE_E2E_STRICT_MCP=1 turns the rule on in a test run).
 */
test('a hand-made address for another conversation is refused outright', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-tok-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-tok-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const urlFile = join(data, 'mcp-url.txt')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      COVE_E2E_STRICT_MCP: '1',
      NODE_ENV: 'production'
    }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => existsSync(urlFile), { timeout: 20_000 }).toBe(true)
    const base = readFileSync(urlFile, 'utf8')
    const token = (ws: string, chat: string): Promise<string> =>
      app.evaluate(
        (_e, [w, c]) =>
          (globalThis as unknown as { __mcpToken: (w: string, c: string) => string }).__mcpToken(
            w,
            c
          ),
        [ws, chat]
      )
    const list = (query: string): Promise<Response> =>
      fetch(`${base}?${query}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })

    // The address as the app issues it: answered.
    const mine = await token('ws-a', 'chat-1')
    const ok = await list(`ws=ws-a&chat=chat-1&k=${mine}`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('board_list')

    // Another chat's id with this chat's token, no token, a guess, another workspace.
    for (const q of [
      `ws=ws-a&chat=chat-2&k=${mine}`,
      'ws=ws-a&chat=chat-1',
      `ws=ws-a&chat=chat-1&k=${'a'.repeat(32)}`,
      `ws=ws-b&chat=chat-1&k=${mine}`,
      'ws=ws-a'
    ]) {
      const res = await list(q)
      expect(res.status, q).toBe(403)
      expect(await res.text()).toContain('not issued for that conversation')
    }
    // A routine's address (no chat) is issued too, and works.
    const routine = await token('ws-a::routine', '')
    expect((await list(`ws=${encodeURIComponent('ws-a::routine')}&k=${routine}`)).status).toBe(200)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
