import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { ipcMain } from 'electron'
import { ensureRunning, profileDir, stopBrowser, type BrowserId } from './external-browser'

/**
 * "Bring my sign-ins over": copy the logins for sites the user picks from their
 * everyday browser into the agent's profile of it.
 *
 * The agent's browser has to be a profile of its own — Chromium refuses remote
 * control of the everyday one — so it starts signed out of everything. Copying
 * only the chosen sites' cookies gets it into Shopify or Google without handing
 * it the user's email or bank as well.
 *
 * The rows are copied as they are, still encrypted: the key is the browser
 * app's own (its "Safe Storage" item in the Keychain), the same for every
 * profile of that app, so the agent's copy reads them without Superagent ever
 * decrypting a cookie.
 */

type RealBrowser = Exclude<BrowserId, 'builtin'>

/** Each browser's data folder under ~/Library/Application Support. */
const DATA_ROOT: Record<RealBrowser, string> = {
  brave: 'BraveSoftware/Brave-Browser',
  chrome: 'Google/Chrome',
  edge: 'Microsoft Edge'
}

/** The profile the user last used in their everyday copy of the browser. */
export function everydayProfile(id: RealBrowser): string {
  // E2E hook: a fixture profile instead of the real one on the test machine.
  if (process.env.COVE_E2E_EVERYDAY_PROFILE) return process.env.COVE_E2E_EVERYDAY_PROFILE
  const root = join(homedir(), 'Library', 'Application Support', DATA_ROOT[id])
  let name = 'Default'
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as {
      profile?: { last_used?: string }
    }
    name = state.profile?.last_used || 'Default'
  } catch (err) {
    // No Local State: not set up, or macOS said no — the cookie read reports it.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') throw notAllowed()
  }
  return join(root, name)
}

function notAllowed(): Error {
  return new Error(
    "macOS didn't let Superagent read your browser's data. Allow it when macOS asks, " +
      'or in System Settings → Privacy & Security, then try again.'
  )
}

/**
 * The site a cookie belongs to, as the picker lists it: "admin.shopify.com" and
 * ".shopify.com" are both shopify.com. Two labels, or three under a two-letter
 * country's second level (bbc.co.uk).
 */
export function siteOf(hostKey: string): string {
  const host = hostKey.replace(/^\./, '').toLowerCase()
  if (/^[\d.]+$/.test(host) || !host.includes('.')) return host
  const parts = host.split('.')
  const tld = parts[parts.length - 1]
  const second = parts[parts.length - 2]
  const n =
    tld.length === 2 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(second) ? 3 : 2
  return parts.slice(-n).join('.')
}

/** Whether a cookie's host belongs to one of the picked sites. */
export function hostMatches(hostKey: string, sites: string[]): boolean {
  const host = hostKey.replace(/^\./, '').toLowerCase()
  return sites.some((s) => host === s || host.endsWith('.' + s))
}

/**
 * Read a profile's Cookies database through a private copy: the running browser
 * holds the real one, and a copy reads its last saved state without touching it.
 */
function withCookies<T>(profile: string, fn: (db: Database.Database, copy: string) => T): T {
  const src = join(profile, 'Cookies')
  const tmp = mkdtempSync(join(tmpdir(), 'sa-cookies-'))
  try {
    try {
      copyFileSync(src, join(tmp, 'Cookies'))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') throw notAllowed()
      if (code === 'ENOENT') throw new Error('No saved sign-ins found in that browser.')
      throw err
    }
    const db = new Database(join(tmp, 'Cookies'), { readonly: true })
    try {
      return fn(db, join(tmp, 'Cookies'))
    } finally {
      db.close()
    }
  } finally {
    // The copy holds every cookie of the everyday profile (encrypted); don't keep it.
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The sites the everyday profile is signed in to, most cookies first. */
export function listSites(
  id: RealBrowser,
  source = everydayProfile(id)
): { site: string; count: number }[] {
  const hosts = withCookies(source, (db) =>
    db.prepare('SELECT host_key AS h, COUNT(*) AS n FROM cookies GROUP BY host_key').all()
  ) as { h: string; n: number }[]
  const counts = new Map<string, number>()
  for (const { h, n } of hosts) counts.set(siteOf(h), (counts.get(siteOf(h)) ?? 0) + n)
  return [...counts]
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site))
}

const schemaVersion = (db: Database.Database): string =>
  (db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string }).value

/**
 * Copy the picked sites' cookies from `source` (a profile folder) into `dest`.
 * The agent's browser must not be running — see importSignIns.
 */
export function copySignIns(
  source: string,
  dest: string,
  sites: string[]
): { copied: number; sites: string[] } {
  const want = [...new Set(sites.map((s) => s.trim().toLowerCase()).filter(Boolean))]
  if (want.length === 0) return { copied: 0, sites: [] }
  const destDb = join(dest, 'Cookies')
  return withCookies(source, (src, snapshot) => {
    // Timestamps are microseconds since 1601 — past what a JS number holds
    // exactly — so rows travel as BigInts.
    const rows = (
      src.prepare('SELECT * FROM cookies').safeIntegers(true).all() as { host_key: string }[]
    ).filter((r) => hostMatches(r.host_key, want))
    const found = [...new Set(rows.map((r) => siteOf(r.host_key)))]
    if (rows.length === 0) return { copied: 0, sites: [] }
    if (!existsSync(destDb)) {
      // A profile that has never stored a cookie has no database yet: start from
      // the everyday one's (same schema by construction), keep only the picked
      // sites, and VACUUM so nothing else lingers in the file's free pages.
      mkdirSync(dirname(destDb), { recursive: true })
      copyFileSync(snapshot, destDb)
      const db = new Database(destDb)
      try {
        const keep = db.prepare('SELECT rowid AS id, host_key FROM cookies').all() as {
          id: number
          host_key: string
        }[]
        const drop = db.prepare('DELETE FROM cookies WHERE rowid = ?')
        db.transaction(() => {
          for (const r of keep) if (!hostMatches(r.host_key, want)) drop.run(r.id)
        })()
        db.exec('VACUUM')
      } finally {
        db.close()
      }
      return { copied: rows.length, sites: found }
    }
    const db = new Database(destDb)
    try {
      if (schemaVersion(db) !== schemaVersion(src))
        throw new Error(
          'Your everyday browser and the agent’s copy save sign-ins differently. Update the browser and try again.'
        )
      const cols = (db.prepare('PRAGMA table_info(cookies)').all() as { name: string }[]).map(
        (c) => c.name
      )
      const insert = db
        .prepare(
          `INSERT OR REPLACE INTO cookies (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`
        )
        .safeIntegers(true)
      db.transaction(() => {
        for (const r of rows) insert.run(r)
      })()
    } finally {
      db.close()
    }
    return { copied: rows.length, sites: found }
  })
}

/**
 * The whole step: quit the agent's copy (it would overwrite the file on exit),
 * copy, and start it again if it was running.
 */
export async function importSignIns(
  id: RealBrowser,
  sites: string[]
): Promise<{ ok: true; copied: number; sites: string[] } | { ok: false; error: string }> {
  try {
    const source = everydayProfile(id)
    const wasRunning = await stopBrowser(id)
    try {
      const result = copySignIns(source, join(profileDir(id), 'Default'), sites)
      return { ok: true, ...result }
    } finally {
      if (wasRunning) await ensureRunning(id).catch(() => undefined)
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function registerSignInsIpc(): void {
  ipcMain.handle('browsers:sites', (_e, id: RealBrowser) => {
    try {
      return { ok: true, sites: listSites(id) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('browsers:import', (_e, id: RealBrowser, sites: string[]) =>
    importSignIns(id, Array.isArray(sites) ? sites.map(String) : [])
  )
}
