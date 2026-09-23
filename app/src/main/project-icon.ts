import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'
import { nativeImage } from 'electron'

/**
 * What a project actually IS, read off its own files instead of guessed from
 * its name — a website's favicon, or a native app's own app icon, in front of
 * its name instead of the same folder glyph every project gets otherwise.
 */

const FAVICON_CANDIDATES = [
  'favicon.ico',
  'favicon.png',
  'favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'public/favicon.svg',
  'static/favicon.ico',
  'static/favicon.png',
  'src/favicon.ico',
  'assets/favicon.ico',
  'assets/favicon.png'
]

const MIME: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif'
}

/** A file this small is either a real icon or a broken one — never worth reading past. */
const MAX_ICON_BYTES = 2_000_000

function fileToDataUri(path: string): string | null {
  try {
    const mime = MIME[extname(path).toLowerCase()]
    if (!mime) return null
    const buf = readFileSync(path)
    if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function findFavicon(root: string): string | null {
  for (const rel of FAVICON_CANDIDATES) {
    const uri = fileToDataUri(join(root, rel))
    if (uri) return uri
  }
  return null
}

/** The Contents.json entry with the largest actual pixel size, so a 3x @1024
 *  App Store icon wins over a stray 20x20 one some project keeps around. */
function pickBestAppIconFile(dir: string): string | null {
  try {
    const contents = JSON.parse(readFileSync(join(dir, 'Contents.json'), 'utf8')) as {
      images?: { filename?: string; size?: string; scale?: string }[]
    }
    let best: { filename: string; area: number } | null = null
    for (const img of contents.images ?? []) {
      if (!img.filename) continue
      const width = parseFloat((img.size ?? '0x0').split('x')[0]) || 0
      const scale = parseInt((img.scale ?? '1x').replace('x', ''), 10) || 1
      const area = width * scale
      if (!best || area > best.area) best = { filename: img.filename, area }
    }
    return best ? join(dir, best.filename) : null
  } catch {
    return null
  }
}

/** Never where a project's own icon lives, and often huge. */
const SKIP_DIRS = new Set([
  'node_modules',
  'Pods',
  'Carthage',
  'DerivedData',
  'build',
  'dist',
  'out',
  'target',
  'vendor',
  '__pycache__'
])

/** Past this many folders, give up — detection runs on the main process. */
const MAX_DIRS_VISITED = 1500

/**
 * Breadth-first, so the shallowest icon set wins, and deep enough to reach an
 * app inside a project that groups several repos:
 * repo/SuperAgent/Resources/Assets.xcassets/AppIcon.appiconset is five levels
 * down, which the old three-level walk never reached. At one level, the main
 * `AppIcon` beats alternates like `AppIconAmber`, whichever readdir lists first.
 */
function findAppIconSet(root: string, maxDepth: number): string | null {
  let level = [root]
  let visited = 0
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = []
    const found: string[] = []
    for (const dir of level) {
      if (++visited > MAX_DIRS_VISITED) return found[0] ?? null
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
        const p = join(dir, name)
        if (name.endsWith('.appiconset')) {
          if (existsSync(join(p, 'Contents.json'))) found.push(p)
          continue
        }
        try {
          if (statSync(p).isDirectory()) next.push(p)
        } catch {
          // unreadable entry (permissions, broken symlink) — skip it
        }
      }
    }
    if (found.length) return found.find((p) => p.endsWith('/AppIcon.appiconset')) ?? found[0]
    level = next
  }
  return null
}

function findXcodeAppIcon(root: string): string | null {
  const set = findAppIconSet(root, 5)
  if (!set) return null
  const file = pickBestAppIconFile(set)
  return file ? fileToDataUri(file) : null
}

/** The root's favicon, else one in any repo directly inside it — a project
 *  that groups several repos keeps its web app's favicon a level down. */
function findFaviconShallow(root: string): string | null {
  const own = findFavicon(root)
  if (own) return own
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const uri = findFavicon(join(root, name))
    if (uri) return uri
  }
  return null
}

export const iconKvKey = (workspaceId: string): string => `icon:${workspaceId}`

export type ProjectGlyphKind = 'screenplay' | 'design' | 'music' | 'documents'

export type DetectedIcon =
  { source: 'app-icon' | 'favicon'; dataUri: string } | { source: 'kind'; kind: ProjectGlyphKind }

/** File extensions that mean "this folder is clearly a ___ project", even
 *  though there's no picture to show for it — a screenplay, a design file, a
 *  DAW project, don't carry an icon the way an app or a website does. Not
 *  every project is code. */
const GLYPH_EXTENSIONS: [ProjectGlyphKind, string[]][] = [
  ['screenplay', ['.fountain', '.fdx', '.highland']],
  ['design', ['.sketch', '.fig', '.psd', '.ai', '.xd']],
  ['music', ['.logicx', '.als', '.flp', '.ptx', '.rpp']],
  ['documents', ['.pages', '.docx', '.doc']]
]

/** Whether ANY file with one of these extensions exists within a couple
 *  levels of root — same depth/skip rules as findAppIconSet, for the same
 *  reason (a real project's telling files are never buried in node_modules). */
function hasFileWithExt(dir: string, exts: string[], depth: number): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (exts.includes(extname(name).toLowerCase())) return true
    if (depth <= 0) continue
    try {
      if (statSync(p).isDirectory() && hasFileWithExt(p, exts, depth - 1)) return true
    } catch {
      // unreadable entry — skip it
    }
  }
  return false
}

function findGlyphKind(root: string): ProjectGlyphKind | null {
  for (const [kind, exts] of GLYPH_EXTENSIONS) {
    if (hasFileWithExt(root, exts, 2)) return kind
  }
  return null
}

/**
 * App icon and favicon both win over a glyph kind — a real picture beats a
 * generic symbol every time it's available. App icon wins over favicon when a
 * project happens to have both (a Capacitor/React Native app's own web
 * build, say) — it's the more deliberately-made asset of the two.
 */
export function detectProjectIcon(root: string): DetectedIcon | null {
  const appIcon = findXcodeAppIcon(root)
  if (appIcon) return { source: 'app-icon', dataUri: appIcon }
  const favicon = findFaviconShallow(root)
  if (favicon) return { source: 'favicon', dataUri: favicon }
  const kind = findGlyphKind(root)
  if (kind) return { source: 'kind', kind }
  return null
}

/** A user-picked file, for the manual override — downscaled, since this can
 *  be any photo off disk rather than an already-small icon asset. */
export function iconFromPickedFile(path: string): string | null {
  try {
    let img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const longest = Math.max(width, height)
    if (longest > 256) {
      img = width >= height ? img.resize({ width: 256 }) : img.resize({ height: 256 })
    }
    return `data:image/png;base64,${img.toPNG().toString('base64')}`
  } catch {
    return null
  }
}
