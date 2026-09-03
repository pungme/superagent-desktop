import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, session } from 'electron'
import { kvGet, kvSet } from './store'
import { SHARED_BROWSER_PARTITION } from './util'

/**
 * Fold the old per-project browser sessions into the one shared session.
 *
 * Code projects used to browse in 'persist:ws-<id>', a separate cookie jar
 * each. They now all use SHARED_BROWSER_PARTITION. Cookies live in a directory
 * named after the partition, so switching the name alone would leave every
 * existing login sitting on disk that nothing ever opens again — which is
 * exactly what renaming the app in 1.7.2 did, and it came back as "the update
 * logged me out of everything".
 *
 * So: copy, once, and never delete. The old directories stay where they are. If
 * this goes wrong the worst case is a login that didn't carry, not a login
 * that's gone.
 */

const DONE_KEY = 'cove.partitions-merged'

/**
 * What makes two cookies the same cookie to a browser. Used to decide what NOT
 * to overwrite: whatever is already in the shared jar wins, so a session the
 * user is actively using can't be clobbered by an older copy from some project.
 */
export function cookieKey(c: { name: string; domain?: string; path?: string }): string {
  return `${c.domain ?? ''}|${c.path ?? '/'}|${c.name}`
}

/** Old per-project jars, by directory name. Everything else is left alone. */
export function legacyPartitionDirs(names: string[]): string[] {
  return names.filter((n) => n.startsWith('ws-'))
}

/**
 * Turn a cookie we read into the arguments needed to write it back.
 *
 * Two traps here. A cookie whose domain has no leading dot is HOST-ONLY, and
 * passing `domain` to set() would widen it to every subdomain — so the domain is
 * passed only when it was a domain cookie to begin with. And the url has to
 * carry the right scheme, because Chromium refuses a Secure cookie over http.
 */
export function cookieSetDetails(c: Electron.Cookie): Electron.CookiesSetDetails {
  const isDomainCookie = c.domain?.startsWith('.') ?? false
  const host = (c.domain ?? '').replace(/^\./, '')
  const details: Electron.CookiesSetDetails = {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
    sameSite: c.sameSite
  }
  return isDomainCookie ? { ...details, domain: c.domain } : details
}

/** Newest jar first, so the most recently used login wins any collision. */
function byRecencyDesc(root: string, dirs: string[]): string[] {
  return [...dirs].sort((a, b) => {
    try {
      return statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs
    } catch {
      return 0
    }
  })
}

/**
 * The merge's missing second half: throw the old jars away.
 *
 * mergeLegacyPartitions copied every login into the shared jar and deliberately
 * deleted nothing — right for the release that migrated, and it left 33
 * complete browser profiles (about 3.6 GB on a real machine, one of them
 * 1.3 GB alone) that nothing will ever open again: every pane has used
 * persist:browser since, and nothing else calls fromPartition with a ws- name.
 *
 * Deleted only on a LATER launch than the merge — this run must not have
 * opened those sessions, and a boot where the merge just ran has. Best-effort
 * per directory: a locked file keeps its jar until next time rather than
 * failing the sweep.
 */
export function sweepMergedPartitions(): void {
  if (kvGet(DONE_KEY) !== '1') return
  const root = join(app.getPath('userData'), 'Partitions')
  let names: string[]
  try {
    names = legacyPartitionDirs(readdirSync(root))
  } catch {
    return
  }
  let reclaimed = 0
  for (const dir of names) {
    try {
      const full = join(root, dir)
      rmSync(full, { recursive: true, force: true })
      reclaimed++
    } catch {
      // Held open by something? It gets another chance next launch.
    }
  }
  if (reclaimed) console.log(`[sessions] swept ${reclaimed} merged project jars`)
}

export async function mergeLegacyPartitions(): Promise<void> {
  if (kvGet(DONE_KEY) === '1') return

  const root = join(app.getPath('userData'), 'Partitions')
  let dirs: string[]
  try {
    dirs = legacyPartitionDirs(readdirSync(root))
  } catch {
    // No Partitions directory at all — a fresh install. Nothing to carry.
    kvSet(DONE_KEY, '1')
    return
  }

  const target = session.fromPartition(SHARED_BROWSER_PARTITION)
  const taken = new Set<string>()
  try {
    for (const c of await target.cookies.get({})) taken.add(cookieKey(c))
  } catch {
    // Reading the target failed; better to carry nothing than to overwrite
    // blindly, so leave the flag unset and try again next launch.
    return
  }

  let carried = 0
  for (const dir of byRecencyDesc(root, dirs)) {
    let cookies: Electron.Cookie[]
    try {
      cookies = await session.fromPartition(`persist:${dir}`).cookies.get({})
    } catch {
      continue // one unreadable jar must not stop the rest
    }
    for (const c of cookies) {
      const key = cookieKey(c)
      if (taken.has(key)) continue
      try {
        await target.cookies.set(cookieSetDetails(c))
        taken.add(key)
        carried += 1
      } catch {
        // Chromium rejects some cookies on the way back in (a __Host- prefix
        // whose reconstructed url doesn't satisfy the rule, SameSite=None
        // without Secure). One refused cookie is a login that didn't carry —
        // not a reason to abandon the rest.
      }
    }
  }

  kvSet(DONE_KEY, '1')
  console.log(`[sessions] merged ${dirs.length} project jars, carried ${carried} cookies`)
}
