import { afterAll, describe, it, expect, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The real Brave these tests start runs headless: no window on the user's screen.
process.env.COVE_E2E_QUIET ??= '1'

const dataDir = mkdtempSync(join(tmpdir(), 'sa-sign-ins-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./store', () => ({
  kvGet: () => undefined,
  kvSet: vi.fn(),
  DESKTOP_WORKSPACE_ID: '__desktop_chat__'
}))

import { copySignIns, hostMatches, siteOf } from './sign-ins'
import {
  endSignIn,
  ensureRunning,
  profileDir,
  signInYourself,
  stopBrowser
} from './external-browser'
import { execSync } from 'child_process'

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const haveBrave = existsSync('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')

describe('which cookies belong to a picked site', () => {
  it('groups hosts by site', () => {
    expect(siteOf('.shopify.com')).toBe('shopify.com')
    expect(siteOf('admin.shopify.com')).toBe('shopify.com')
    expect(siteOf('accounts.google.com')).toBe('google.com')
    expect(siteOf('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1')
  })

  it('takes a site and its subdomains, never a lookalike', () => {
    expect(hostMatches('.shopify.com', ['shopify.com'])).toBe(true)
    expect(hostMatches('admin.shopify.com', ['shopify.com'])).toBe(true)
    expect(hostMatches('notshopify.com', ['shopify.com'])).toBe(false)
    expect(hostMatches('shopify.com.evil.io', ['shopify.com'])).toBe(false)
  })
})

type Cookie = { name: string; value: string; domain: string }

// Against the real browser: cookies it wrote, copied as encrypted rows into
// another profile, must be readable there — that is the whole feature.
describe.skipIf(!haveBrave)('bringing sign-ins over in a real Brave', () => {
  it('copies only the picked sites, readable by the other profile, into a new or used one', async () => {
    const aside = mkdtempSync(join(tmpdir(), 'sa-everyday-'))
    const expires = Math.floor(Date.now() / 1000) + 86_400
    const set = async (cookies: Cookie[]): Promise<void> => {
      const conn = await ensureRunning('brave')
      await conn.send('Storage.setCookies', {
        cookies: cookies.map((c) => ({ ...c, path: '/', expires }))
      })
    }
    const read = async (): Promise<string[]> => {
      const conn = await ensureRunning('brave')
      const { cookies } = await conn.send<{ cookies: Cookie[] }>('Storage.getCookies')
      return cookies.map((c) => `${c.domain}:${c.name}=${c.value}`).sort()
    }
    try {
      // "Everyday" profile: signed in to four sites. A clean quit saves them.
      await set([
        { name: 'sid', value: 'shop', domain: 'admin.shopify.test' },
        { name: 'g', value: 'goog', domain: '.google.test' },
        { name: 'b', value: 'bank', domain: 'bank.test' },
        { name: 'm', value: 'mail', domain: 'mail.test' }
      ])
      expect(await stopBrowser('brave')).toBe(true)
      cpSync(profileDir('brave'), aside, { recursive: true })
      rmSync(profileDir('brave'), { recursive: true, force: true })

      // A fresh agent profile — no cookie database at all yet.
      const first = copySignIns(join(aside, 'Default'), join(profileDir('brave'), 'Default'), [
        'shopify.test'
      ])
      expect(first).toEqual({ copied: 1, sites: ['shopify.test'] })
      expect(await read()).toEqual(['admin.shopify.test:sid=shop'])

      // A used one, with a sign-in of its own that must survive.
      await set([{ name: 'own', value: 'mine', domain: 'own.test' }])
      await stopBrowser('brave')
      copySignIns(join(aside, 'Default'), join(profileDir('brave'), 'Default'), ['google.test'])
      expect(await read()).toEqual([
        '.google.test:g=goog',
        'admin.shopify.test:sid=shop',
        'own.test:own=mine'
      ])
    } finally {
      await stopBrowser('brave')
      rmSync(aside, { recursive: true, force: true })
    }
  }, 90_000)

  it('opens for the user to sign in with no remote control, and the agent waits for it', async () => {
    try {
      await ensureRunning('brave')
      const done = signInYourself('brave', 'about:blank')
      await new Promise((r) => setTimeout(r, 1500))
      // Google checks for remote control at sign-in: this copy must have none.
      const args = execSync(
        `ps -axo args | grep -- '--user-data-dir=${profileDir('brave')}' | grep -v grep || true`
      )
        .toString()
        .split('\n')
        .filter((l) => !l.includes('--type='))
        .join('\n')
      expect(args).toContain(profileDir('brave'))
      expect(args).not.toContain('remote-debugging')
      await expect(ensureRunning('brave')).rejects.toThrow(/signing in/)
      endSignIn('brave')
      await done
      // Quit: the agent takes over again.
      const conn = await ensureRunning('brave')
      expect(conn.closed).toBe(false)
    } finally {
      await stopBrowser('brave')
    }
  }, 60_000)
})
