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

/** Past this it is not an icon. (Big ones are shrunk before use; see fileToDataUri.) */
const MAX_ICON_BYTES = 10_000_000

function fileToDataUri(path: string): string | null {
  try {
    const mime = MIME[extname(path).toLowerCase()]
    if (!mime) return null
    const buf = readFileSync(path)
    if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null
    // A 1024px App Store icon is often a megabyte or two; the sidebar draws it
    // at 16px. Shrink anything big to a size that still looks sharp on Retina.
    if (buf.length > 100_000 && mime !== 'image/svg+xml') {
      const img = nativeImage.createFromBuffer(buf)
      if (!img.isEmpty()) {
        const small = img.resize({ width: 128, height: 128, quality: 'best' }).toPNG()
        return `data:image/png;base64,${small.toString('base64')}`
      }
    }
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
 * Not the app itself: a widget, extension, watch app, App Clip or test target
 * keeps an icon set of its own, and it must never stand in for the app's.
 */
const SIDE_TARGET = /(widget|extension|watch|clip|intents?|share|notification|tests?)/i

/**
 * Every app icon in the project — `.appiconset`s and Icon Composer `.icon`s —
 * best first: the app's own before a side target's, an icon set (an exact
 * picture) before an `.icon` (which has to be drawn), shallower before deeper,
 * and the main `AppIcon` before alternates like `AppIconAmber`. The caller
 * takes the first that actually has a picture in it: stopping at the first set
 * found meant an empty one (a widget's) left the project with a folder.
 */
function findAppIcons(root: string, maxDepth: number): string[] {
  const found: { path: string; depth: number }[] = []
  let level = [root]
  let visited = 0
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (++visited > MAX_DIRS_VISITED) break
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
          if (existsSync(join(p, 'Contents.json'))) found.push({ path: p, depth })
          continue
        }
        if (name.endsWith('.icon')) {
          if (existsSync(join(p, 'icon.json'))) found.push({ path: p, depth })
          continue
        }
        try {
          if (statSync(p).isDirectory()) next.push(p)
        } catch {
          // unreadable entry (permissions, broken symlink) — skip it
        }
      }
    }
    level = next
  }
  const rank = (f: { path: string; depth: number }): number[] => [
    SIDE_TARGET.test(f.path.slice(root.length)) ? 1 : 0,
    // An exact picture beats one we have to draw, wherever it sits.
    f.path.endsWith('.icon') ? 1 : 0,
    f.depth,
    /\/AppIcon\.(appiconset|icon)$/.test(f.path) ? 0 : 1
  ]
  return found
    .sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
      return a.path.localeCompare(b.path)
    })
    .map((f) => f.path)
}

/** "srgb:0.1,0.2,0.3,1" (Icon Composer's fill) → a CSS colour. */
function iconFill(fill: unknown): string {
  const solid = (fill as { solid?: string } | undefined)?.solid
  const m = /^(?:srgb|extended-srgb|display-p3):([\d.]+),([\d.]+),([\d.]+)(?:,([\d.]+))?/.exec(
    solid ?? ''
  )
  if (!m) return '#e5e5ea'
  const c = (v: string): number => Math.round(Math.min(1, Math.max(0, Number(v))) * 255)
  return `rgba(${c(m[1])},${c(m[2])},${c(m[3])},${Number(m[4] ?? 1)})`
}

/**
 * An Icon Composer `.icon` drawn as a picture: its fill as a rounded square,
 * its layers on top (the first group is the frontmost). Approximate — no glass,
 * shadow or blend — but it is the app's own mark and colour, which is what a
 * 16px sidebar glyph needs.
 */
function renderIconComposer(dir: string): string | null {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'icon.json'), 'utf8')) as {
      fill?: unknown
      groups?: { layers?: { 'image-name'?: string; hidden?: boolean }[]; hidden?: boolean }[]
    }
    const layers: string[] = []
    for (const g of [...(json.groups ?? [])].reverse()) {
      if (g.hidden) continue
      for (const l of [...(g.layers ?? [])].reverse()) {
        if (l.hidden || !l['image-name']) continue
        const uri = fileToDataUri(join(dir, 'Assets', l['image-name']))
        if (uri) layers.push(uri)
      }
    }
    if (!layers.length) return null
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
      `<rect width="128" height="128" rx="28" fill="${iconFill(json.fill)}"/>` +
      layers.map((u) => `<image href="${u}" width="128" height="128"/>`).join('') +
      `</svg>`
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  } catch {
    return null
  }
}

function findXcodeAppIcon(root: string): string | null {
  for (const icon of findAppIcons(root, 5)) {
    let uri: string | null
    if (icon.endsWith('.icon')) uri = renderIconComposer(icon)
    else {
      const file = pickBestAppIconFile(icon)
      uri = file ? fileToDataUri(file) : null
    }
    if (uri) return uri
  }
  return null
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
 *  levels of root — same depth/skip rules as findAppIcons, for the same
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
