import { spawn, type ChildProcess } from 'child_process'
import { app, BrowserWindow } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { applyBrowserIdentity } from './browser'
import { findAgy, findClaude, findCodex } from './claude-cli'
import { PROVIDER_PRODUCT, type AgentProvider } from '../shared/agent-provider'

/**
 * Signing an agent in without leaving Superagent.
 *
 * It used to open Terminal running the CLI, which opened the default browser,
 * and the user came back and pressed Re-check: three apps to do one thing.
 * Each CLI's own sign-in is still what runs here, but its web page is shown in
 * a window of ours and the CLI is not allowed to open a browser itself:
 *
 *  - Claude Code (`claude auth login`) asks macOS to `open` its link. A stand-in
 *    `open` first on its PATH hands us the link instead. That link returns to a
 *    port the CLI listens on, so it finishes by itself.
 *  - Codex is asked for a link through its app server (`account/login/start`),
 *    which opens nothing, and says when it is done (`account/login/completed`).
 *  - Antigravity (`agy models`) prints a Google link and waits for a code.
 *    Google sends the code to antigravity.google/oauth-callback; it is read off
 *    that address and typed into the CLI for the user.
 */

export type SignInResult = { ok: true } | { ok: false; cancelled?: boolean; error: string }

/** A link in a CLI's output. */
export function linkIn(text: string): string | null {
  return text.match(/https:\/\/[^\s"'<>]+/)?.[0] ?? null
}

/** The code an OAuth provider hands back on its callback address. */
export function codeFromCallback(url: string, host: string, path: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname !== host || !u.pathname.startsWith(path)) return null
    const code = u.searchParams.get('code')
    if (!code) return null
    // Claude's paste-a-code form wants "code#state".
    const state = u.searchParams.get('state')
    return host.endsWith('claude.com') && state ? `${code}#${state}` : code
  } catch {
    return null
  }
}

/** A directory whose `open` writes its argument to a file instead of opening it. */
function shim(): { dir: string; file: string } {
  const dir = join(app.getPath('userData'), 'signin-shim')
  const file = join(dir, `link-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'open')
  if (!existsSync(bin)) {
    writeFileSync(
      bin,
      '#!/bin/sh\n[ -n "$SUPERAGENT_LINK_FILE" ] && printf \'%s\\n\' "$1" >> "$SUPERAGENT_LINK_FILE"\nexit 0\n'
    )
    chmodSync(bin, 0o755)
  }
  return { dir, file }
}

let active: { provider: AgentProvider; cancel: () => void } | null = null

/** One sign-in at a time; a second request for the same agent refocuses it. */
export function signInAgent(
  provider: AgentProvider,
  parent: BrowserWindow | null
): Promise<SignInResult> {
  if (active) active.cancel()
  return new Promise<SignInResult>((resolve) => {
    let win: BrowserWindow | null = null
    let proc: ChildProcess | null = null
    let done = false
    let poll: ReturnType<typeof setInterval> | null = null
    let out = ''
    let attempts = 0
    const { dir, file } = shim()

    const finish = (result: SignInResult): void => {
      if (done) return
      done = true
      active = null
      if (poll) clearInterval(poll)
      clearTimeout(limit)
      try {
        proc?.kill()
      } catch {
        // already gone
      }
      rmSync(file, { force: true })
      if (win && !win.isDestroyed()) win.destroy()
      resolve(result)
    }
    const limit = setTimeout(
      () => finish({ ok: false, error: 'The sign-in took too long. Try again.' }),
      10 * 60_000
    )
    active = { provider, cancel: () => finish({ ok: false, cancelled: true, error: 'Cancelled.' }) }

    /** Show the sign-in page, in the window if it is already up. */
    const show = (url: string): void => {
      if (done) return
      if (win && !win.isDestroyed()) {
        void win.loadURL(url)
        return
      }
      win = new BrowserWindow({
        width: 520,
        height: 740,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        modal: !!parent && !parent.isDestroyed(),
        title: `Sign in to ${PROVIDER_PRODUCT[provider]}`,
        show: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          // Its own jar: a sign-in here is the agent's, not the browser pane's.
          partition: 'persist:agent-signin',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      applyBrowserIdentity(win.webContents)
      // "Continue with Google" and the like open a popup; keep it in this window.
      win.webContents.setWindowOpenHandler(({ url: next }) => {
        if (/^https:/.test(next)) void win?.loadURL(next)
        return { action: 'deny' }
      })
      const seen = (next: string): void => {
        // Where a provider returns a code for pasting, paste it for them.
        const code =
          codeFromCallback(next, 'antigravity.google', '/oauth-callback') ??
          codeFromCallback(next, 'platform.claude.com', '/oauth/code/callback')
        if (code) proc?.stdin?.write(code + '\n')
      }
      win.webContents.on('will-redirect', (_e, next) => seen(next))
      win.webContents.on('did-navigate', (_e, next) => seen(next))
      win.once('ready-to-show', () => win?.show())
      win.on('closed', () => {
        win = null
        finish({ ok: false, cancelled: true, error: 'Cancelled.' })
      })
      void win.loadURL(url)
    }

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      BROWSER: join(dir, 'open'),
      SUPERAGENT_LINK_FILE: file
    }

    if (provider === 'codex') {
      // The app server: a link on request, no browser of its own, and a
      // notification when the account is in.
      try {
        proc = spawn(findCodex(), ['app-server'], { env, cwd: os.homedir(), shell: false })
      } catch (e) {
        return finish({ ok: false, error: (e as Error).message })
      }
      const send = (msg: Record<string, unknown>): void => {
        proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
      }
      let buf = ''
      proc.stdout?.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          let msg: {
            id?: number
            method?: string
            result?: { authUrl?: string }
            error?: { message?: string }
            params?: { success?: boolean; error?: string | null }
          }
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.id === 2 && msg.result?.authUrl) show(msg.result.authUrl)
          else if (msg.id === 2)
            finish({ ok: false, error: msg.error?.message ?? 'Codex did not offer a sign-in.' })
          else if (msg.method === 'account/login/completed')
            finish(
              msg.params?.success
                ? { ok: true }
                : { ok: false, error: msg.params?.error || 'Codex did not finish signing in.' }
            )
        }
      })
      proc.on('error', (e) => finish({ ok: false, error: e.message }))
      proc.on('exit', () => finish({ ok: false, error: 'Codex stopped before signing in.' }))
      send({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'superagent', title: 'Superagent', version: app.getVersion() }
        }
      })
      send({ method: 'initialized', params: {} })
      send({ id: 2, method: 'account/login/start', params: { type: 'chatgpt' } })
      return
    }

    const [bin, args] =
      provider === 'claude' ? [findClaude(), ['auth', 'login']] : [findAgy(), ['models']]

    /** Run the CLI's sign-in; Antigravity gives up after a minute, so it is run again. */
    const run = (): void => {
      attempts++
      out = ''
      rmSync(file, { force: true })
      let shown = false
      const startedAt = Date.now()
      try {
        proc = spawn(bin, args, { env, cwd: os.homedir(), shell: false })
      } catch (e) {
        return finish({ ok: false, error: (e as Error).message })
      }
      const mine = proc
      const offer = (): void => {
        if (shown || done || mine !== proc) return
        // The link handed to `open` returns to the CLI by itself; the one it
        // prints is the paste-a-code variant, used when nothing was opened.
        const opened = existsSync(file) ? linkIn(readFileSync(file, 'utf8')) : null
        const printed = linkIn(out)
        const url = opened ?? (Date.now() - startedAt > 2500 ? printed : null)
        if (!url) return
        shown = true
        show(url)
      }
      if (poll) clearInterval(poll)
      poll = setInterval(offer, 150)
      const take = (c: Buffer): void => {
        out += c.toString('utf8')
      }
      mine.stdout?.on('data', take)
      mine.stderr?.on('data', take)
      mine.stdin?.on('error', () => {})
      mine.on('error', (e) => finish({ ok: false, error: e.message }))
      mine.on('exit', (code) => {
        if (done || mine !== proc) return
        // Antigravity lists its models once it is in; a signed-out one says so.
        const signedIn =
          provider === 'claude' ? code === 0 : code === 0 && !/sign in|authentication/i.test(out)
        if (signedIn) return finish({ ok: true })
        // Still on the page: its minute ran out. Start over behind the window.
        if (provider === 'antigravity' && win && !win.isDestroyed() && attempts < 8) return run()
        finish({
          ok: false,
          error:
            out
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l && !/^https:/.test(l))
              .pop() ?? `${PROVIDER_PRODUCT[provider]} did not finish signing in.`
        })
      })
    }
    run()
  })
}

/** The window is going away, or the user pressed Cancel. */
export function cancelAgentSignIn(): void {
  active?.cancel()
}
