import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { crc32, inflateRawSync } from 'zlib'
import type { AgentProvider } from '../shared/agent-provider'

/**
 * Adding a skill from a folder, a .zip/.skill file or a link, without a
 * terminal. Nothing of Electron in here, so it is tested with a temporary HOME
 * and a fake download.
 *
 * Everything is read into memory and checked first (a SKILL.md, a name, no
 * path that climbs out, no link that points outside, a size limit), and only
 * then written into the agent's own folder. Nothing in a skill is ever run:
 * its files are only copied.
 */

/** Unpacked, per install. */
export const MAX_BYTES = 20 * 1024 * 1024
export const MAX_FILES = 500
/** What a download may weigh before it is even opened (a whole repo's zip). */
export const MAX_DOWNLOAD = 60 * 1024 * 1024
/** Entries in an archive's directory, to bound the work on a huge repo. */
const MAX_ZIP_ENTRIES = 50_000
const MAX_SKILLS = 100

export class SkillError extends Error {}

export interface SkillFile {
  data: Buffer
  executable: boolean
}

/** One skill, read and checked, waiting to be written. */
export interface SkillBundle {
  name: string
  description: string
  /** Paths relative to the skill's folder, with '/' separators; always has SKILL.md. */
  files: Map<string, SkillFile>
}

// ---------- names and frontmatter ----------

function frontmatter(md: string): { fm: string; body: string } | null {
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/)
  return m ? { fm: m[1], body: md.slice(m[0].length) } : null
}

function fmField(md: string, key: string): string {
  const f = frontmatter(md)
  if (!f) return ''
  const m = f.fm.match(new RegExp(`^${key}:[^\\S\\r\\n]*(.*?)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''
}

/** A name that is safe as one folder or file name and as a `/command`. */
export function cleanName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
    .replace(/[-.]+$/g, '')
}

/** Frontmatter `name:` first, the folder's name otherwise. */
export function skillName(skillMd: string, folderName: string): string {
  return cleanName(fmField(skillMd, 'name')) || cleanName(folderName)
}

/** The same SKILL.md under another name (Keep both). */
export function renameSkillMd(md: string, name: string): string {
  const f = frontmatter(md)
  if (!f || !/^name:/m.test(f.fm)) return md
  const head = md.slice(0, md.length - f.body.length)
  return head.replace(/^name:.*$/m, `name: ${name}`) + f.body
}

/**
 * Codex wants one flat prompt file per command: the SKILL.md's instructions,
 * keeping only the description from its frontmatter (the part Codex reads).
 */
export function toCodexPrompt(skillMd: string): string {
  const f = frontmatter(skillMd)
  const description = fmField(skillMd, 'description')
  const body = (f ? f.body : skillMd.replace(/^\uFEFF/, '')).replace(/^\s*\n/, '')
  return description ? `---\ndescription: ${JSON.stringify(description)}\n---\n\n${body}` : body
}

const SCRIPT_EXT =
  /\.(sh|bash|zsh|fish|command|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|bin|applescript|scpt|jxa|lua|swift)$/i

/** Whether the agent could later run something from this skill. */
export function hasScripts(bundle: SkillBundle): boolean {
  for (const [path, f] of bundle.files) {
    if (path === 'SKILL.md') continue
    if (f.executable || SCRIPT_EXT.test(path)) return true
    if (f.data.length >= 2 && f.data[0] === 0x23 && f.data[1] === 0x21) return true // #!
  }
  return false
}

// ---------- paths ----------

/**
 * A path inside an archive, as '/'-separated segments, or null for one that
 * would land outside where it is unpacked: absolute, a drive letter, `..`, or a
 * NUL. Backslashes count as separators.
 */
export function safeRelPath(name: string): string | null {
  if (name.includes('\0')) return null
  const p = name.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null
  const parts = p.split('/').filter((s) => s !== '' && s !== '.')
  if (parts.some((s) => s === '..')) return null
  return parts.join('/')
}

// ---------- zip ----------

interface ZipEntry {
  path: string
  dir: boolean
  symlink: boolean
  executable: boolean
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

/**
 * The archive's directory, every entry checked: one entry with a path that
 * climbs out refuses the whole archive. Zip64 and encrypted archives are
 * refused rather than half-read.
 */
export function listZip(buf: Buffer): ZipEntry[] {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new SkillError("That file isn't a zip archive.")
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new SkillError('That archive is too large to open here.')
  if (count > MAX_ZIP_ENTRIES) throw new SkillError('That archive has too many files.')
  const out: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new SkillError('That archive is damaged.')
    const madeBy = buf.readUInt16LE(p + 4) >> 8
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const external = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    const raw = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff)
      throw new SkillError('That archive is too large to open here.')
    const path = safeRelPath(raw)
    if (path === null)
      throw new SkillError('That archive has files that would land outside the skill folder.')
    // Unix modes live in the top half of the external attributes, when the
    // archive was made on a Unix (3) or a Mac (19).
    const mode = madeBy === 3 || madeBy === 19 ? external >>> 16 : 0
    const type = mode & 0o170000
    out.push({
      path,
      dir: raw.endsWith('/') || raw.endsWith('\\') || type === 0o040000,
      symlink: type === 0o120000,
      executable: type === 0o100000 && (mode & 0o111) !== 0,
      method,
      flags,
      crc,
      compressedSize,
      size,
      localOffset
    })
  }
  return out
}

function readZipEntry(buf: Buffer, e: ZipEntry, budget: number): Buffer {
  if (e.flags & 1) throw new SkillError('That archive is password protected.')
  const at = e.localOffset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50)
    throw new SkillError('That archive is damaged.')
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
  const packed = buf.subarray(start, start + e.compressedSize)
  if (packed.length !== e.compressedSize) throw new SkillError('That archive is damaged.')
  // The sizes in an archive can lie (a zip bomb says small and unpacks huge),
  // so the unpacking itself stops at what is left of the limit.
  if (e.size > budget) throw new SkillError(tooBig())
  let data: Buffer
  if (e.method === 0) data = Buffer.from(packed)
  else if (e.method === 8) {
    try {
      data = inflateRawSync(packed, { maxOutputLength: Math.max(1, budget) })
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new SkillError(tooBig())
      throw new SkillError('That archive is damaged.')
    }
  } else throw new SkillError('That archive uses a kind of compression this does not read.')
  if (data.length !== e.size || crc32(data) !== e.crc)
    throw new SkillError('That archive is damaged.')
  return data
}

const tooBig = (): string =>
  `That is too big for a skill (over ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB).`

// ---------- a tree of files, from any source ----------

/** Files by '/'-separated relative path. */
type Tree = Map<string, SkillFile>

/** Where the skills are in a list of paths: each folder with a SKILL.md, not nested in another. */
export function skillRoots(paths: Iterable<string>): string[] {
  const roots: string[] = []
  for (const p of paths) {
    const parts = p.split('/')
    if (parts[parts.length - 1] !== 'SKILL.md') continue
    if (parts.some((s) => s === '__MACOSX' || s === '.git' || s === 'node_modules')) continue
    roots.push(parts.slice(0, -1).join('/'))
  }
  roots.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const kept: string[] = []
  for (const r of roots) {
    if (!kept.some((k) => k === '' || r === k || r.startsWith(k + '/'))) kept.push(r)
  }
  return kept
}

const under = (root: string, path: string): string | null =>
  root === '' ? path : path.startsWith(root + '/') ? path.slice(root.length + 1) : null

/** Count and weigh as files are taken, so one limit covers every source. */
class Budget {
  files = 0
  bytes = 0
  take(size: number): void {
    this.files += 1
    this.bytes += size
    if (this.files > MAX_FILES || this.bytes > MAX_BYTES) throw new SkillError(tooBig())
  }
  get left(): number {
    return MAX_BYTES - this.bytes
  }
}

function bundlesFrom(roots: string[], tree: Tree, fallbackName: string): SkillBundle[] {
  if (roots.length === 0)
    throw new SkillError('No SKILL.md found. A skill is a folder with a SKILL.md file in it.')
  if (roots.length > MAX_SKILLS)
    throw new SkillError('That has too many skills in it to add at once.')
  const out: SkillBundle[] = []
  for (const root of roots) {
    const files: Tree = new Map()
    for (const [p, f] of tree) {
      const rel = under(root, p)
      if (rel !== null) files.set(rel, f)
    }
    const md = files.get('SKILL.md')!.data
    if (md.length === 0 || md.includes(0))
      throw new SkillError('Its SKILL.md is empty or not text.')
    const text = md.toString('utf8')
    const name = skillName(text, root === '' ? fallbackName : basename(root))
    if (!name) throw new SkillError('The skill has no name. Give its SKILL.md a "name:" line.')
    if (out.some((b) => b.name === name))
      throw new SkillError(`It has two skills named "${name}". Add them one at a time.`)
    out.push({ name, description: fmField(text, 'description'), files })
  }
  return out
}

/** Skills from a zip or .skill archive. `subdir` keeps only that folder (a GitHub tree link). */
export function bundlesFromZip(
  buf: Buffer,
  fallbackName: string,
  opts: { stripTop?: boolean; subdir?: string } = {}
): SkillBundle[] {
  const entries = listZip(buf)
  const sub = opts.subdir ? safeRelPath(opts.subdir) : ''
  if (sub === null) throw new SkillError('That link has a path that is not allowed.')
  const located: { rel: string; e: ZipEntry }[] = []
  for (const e of entries) {
    let p = e.path
    if (opts.stripTop) p = p.split('/').slice(1).join('/')
    const rel = under(sub, p)
    if (rel === null || rel === '' || e.dir) continue
    located.push({ rel, e })
  }
  if (sub && located.length === 0) throw new SkillError(`There is no folder "${sub}" in that repo.`)
  const roots = skillRoots(located.map((l) => l.rel))
  const budget = new Budget()
  const tree: Tree = new Map()
  for (const { rel, e } of located) {
    if (!roots.some((r) => under(r, rel) !== null)) continue
    if (e.symlink)
      throw new SkillError('The skill contains a link to another file. Links are not allowed.')
    const data = readZipEntry(buf, e, budget.left)
    budget.take(data.length)
    tree.set(rel, { data, executable: e.executable })
  }
  const name = sub ? basename(sub) : fallbackName
  return bundlesFrom(roots, tree, name)
}

/** One SKILL.md on its own (a raw link, or a .md picked). */
export function bundleFromMarkdown(data: Buffer, fallbackName: string): SkillBundle[] {
  if (data.length > MAX_BYTES) throw new SkillError(tooBig())
  return bundlesFrom([''], new Map([['SKILL.md', { data, executable: false }]]), fallbackName)
}

/**
 * Skills from a folder on disk: the folder itself when it has a SKILL.md, or
 * every skill folder inside it. A link inside a skill must point inside that
 * same skill; one that points anywhere else refuses the install.
 */
export function bundlesFromFolder(dir: string): SkillBundle[] {
  const top = realpathSync(dir)
  // Find SKILL.md files without wandering a whole disk: a few levels, no
  // dependency or git folders, and not through links.
  const found: string[] = []
  let visited = 0
  const find = (abs: string, rel: string, depth: number): void => {
    if (existsSync(join(abs, 'SKILL.md'))) {
      found.push(rel ? `${rel}/SKILL.md` : 'SKILL.md')
      return
    }
    if (depth >= 4) return
    let names: string[]
    try {
      names = readdirSync(abs)
    } catch {
      return
    }
    for (const n of names) {
      if (++visited > 20_000) throw new SkillError('That folder is too big to look through.')
      if (n === 'node_modules' || n === '.git' || n === '__MACOSX') continue
      const child = join(abs, n)
      let st
      try {
        st = lstatSync(child)
      } catch {
        continue
      }
      if (st.isDirectory()) find(child, rel ? `${rel}/${n}` : n, depth + 1)
    }
  }
  find(top, '', 0)
  const roots = skillRoots(found)
  const budget = new Budget()
  const tree: Tree = new Map()
  for (const root of roots) {
    const rootAbs = root ? join(top, ...root.split('/')) : top
    const rootReal = realpathSync(rootAbs)
    const inside = (p: string): boolean => p === rootReal || p.startsWith(rootReal + sep)
    const seen = new Set<string>()
    const walk = (abs: string, rel: string): void => {
      const real = realpathSync(abs)
      if (!inside(real))
        throw new SkillError(
          'The skill links to files outside its folder. Links like that are not allowed.'
        )
      const st = statSync(real)
      if (st.isDirectory()) {
        if (seen.has(real)) return
        seen.add(real)
        for (const n of readdirSync(real)) {
          if (n === '.git' || n === '.DS_Store' || n === 'node_modules') continue
          walk(join(abs, n), rel ? `${rel}/${n}` : n)
        }
      } else if (st.isFile()) {
        budget.take(st.size)
        const key = root ? `${root}/${rel}` : rel
        tree.set(key, { data: readFileSync(real), executable: (st.mode & 0o111) !== 0 })
      }
    }
    walk(rootAbs, '')
  }
  return bundlesFrom(roots, tree, basename(top))
}

// ---------- links ----------

export type SkillLink =
  | { kind: 'github'; owner: string; repo: string; ref?: string; path: string; zipUrl: string }
  | { kind: 'markdown'; url: string; name: string }
  | { kind: 'zip'; url: string; name: string }

const SEG = /^[A-Za-z0-9_.-]+$/

/**
 * What a pasted link points at: a GitHub repo, a folder in one (a tree link, or
 * a blob link to its SKILL.md), a raw SKILL.md, or a .zip/.skill to download.
 * GitHub repos come down as the zip GitHub serves, so no git and no token.
 */
export function parseSkillLink(input: string): SkillLink {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new SkillError('That is not a link.')
  }
  if (u.protocol !== 'https:') throw new SkillError('Use an https:// link.')
  const parts = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s))
  const last = parts[parts.length - 1] ?? ''
  const host = u.hostname.toLowerCase()
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repoRaw, kind, ref, ...rest] = parts
    const repo = (repoRaw ?? '').replace(/\.git$/, '')
    if (!owner || !repo || !SEG.test(owner) || !SEG.test(repo))
      throw new SkillError('That GitHub link has no repo in it.')
    const zip = (r?: string): string =>
      `https://codeload.github.com/${owner}/${repo}/zip/${r ? encodeURIComponent(r) : 'HEAD'}`
    if (!kind) return { kind: 'github', owner, repo, path: '', zipUrl: zip() }
    if ((kind === 'tree' || kind === 'blob') && ref) {
      let path = rest.join('/')
      if (kind === 'blob') {
        if (/\.md$/i.test(path) && basename(path) !== 'SKILL.md')
          return {
            kind: 'markdown',
            url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
            name: basename(path).replace(/\.md$/i, '')
          }
        // A link to a skill's SKILL.md means the skill: its whole folder.
        path = path.split('/').slice(0, -1).join('/')
      }
      if (safeRelPath(path) === null)
        throw new SkillError('That link has a path that is not allowed.')
      return { kind: 'github', owner, repo, ref, path, zipUrl: zip(ref) }
    }
    throw new SkillError('Use a link to a GitHub repo, a folder in it, or a SKILL.md.')
  }
  if (/\.md$/i.test(last)) {
    const name = last === 'SKILL.md' ? (parts[parts.length - 2] ?? '') : last.replace(/\.md$/i, '')
    return { kind: 'markdown', url: u.toString(), name }
  }
  if (/\.(zip|skill)$/i.test(last))
    return { kind: 'zip', url: u.toString(), name: last.replace(/\.(zip|skill)$/i, '') }
  throw new SkillError('Use a link to a GitHub repo, a folder in it, a SKILL.md, or a .zip.')
}

export type FetchBytes = (url: string, maxBytes: number) => Promise<Buffer>

/** Downloads with no token and no cookies, up to a size. */
export const fetchBytes: FetchBytes = async (url, maxBytes) => {
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', credentials: 'omit' })
  } catch {
    throw new SkillError("Couldn't download it. Check the link and your connection.")
  }
  if (!res.ok || !res.body)
    throw new SkillError(
      "Couldn't download it. Only public GitHub repos work, and the link has to be exact."
    )
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new SkillError('That download is too big.')
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      void reader.cancel()
      throw new SkillError('That download is too big.')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export async function bundlesFromLink(
  input: string,
  fetcher: FetchBytes = fetchBytes
): Promise<SkillBundle[]> {
  const link = parseSkillLink(input)
  if (link.kind === 'markdown')
    return bundleFromMarkdown(await fetcher(link.url, MAX_BYTES), link.name)
  if (link.kind === 'zip') return bundlesFromZip(await fetcher(link.url, MAX_DOWNLOAD), link.name)
  const buf = await fetcher(link.zipUrl, MAX_DOWNLOAD)
  return bundlesFromZip(buf, link.repo, { stripTop: true, subdir: link.path })
}

// ---------- where they go ----------

export interface SkillTarget {
  dir: string
  /** A folder per skill with a SKILL.md (Claude, Antigravity), or one flat .md (Codex). */
  layout: 'folder' | 'flat'
}

/**
 * The agent's own folders: "All projects" is its global one, "This project"
 * the project's, where that agent has one. Codex reads its prompts from
 * ~/.codex/prompts only, so it has no project choice.
 */
export function skillTargets(
  provider: AgentProvider,
  home: string,
  projectPath?: string
): { global: SkillTarget; project?: SkillTarget } {
  if (provider === 'codex')
    return { global: { dir: join(home, '.codex', 'prompts'), layout: 'flat' } }
  if (provider === 'antigravity')
    return {
      global: { dir: join(home, '.gemini', 'antigravity-cli', 'skills'), layout: 'folder' },
      project: projectPath
        ? { dir: join(projectPath, '.agents', 'skills'), layout: 'folder' }
        : undefined
    }
  return {
    global: { dir: join(home, '.claude', 'skills'), layout: 'folder' },
    project: projectPath
      ? { dir: join(projectPath, '.claude', 'skills'), layout: 'folder' }
      : undefined
  }
}

const destOf = (t: SkillTarget, name: string): string =>
  join(t.dir, t.layout === 'flat' ? `${name}.md` : name)

export function alreadyThere(t: SkillTarget, name: string): boolean {
  try {
    lstatSync(destOf(t, name))
    return true
  } catch {
    return false
  }
}

export type OnConflict = 'replace' | 'keep-both' | 'none'

/**
 * Write the skills into the target. A skill already there under that name is
 * moved to the Trash (Replace), or the new one gets a free name (Keep both);
 * with 'none' a clash stops before anything is written. Each skill is written
 * beside its destination first and moved into place in one step.
 */
export async function installBundles(
  bundles: SkillBundle[],
  target: SkillTarget,
  onConflict: OnConflict,
  trash: (path: string) => Promise<void>
): Promise<string[]> {
  if (onConflict === 'none') {
    const clash = bundles.find((b) => alreadyThere(target, b.name))
    if (clash) throw new SkillError(`A skill named "${clash.name}" is already there.`)
  }
  mkdirSync(target.dir, { recursive: true })
  const names: string[] = []
  for (const b of bundles) {
    let name = b.name
    if (alreadyThere(target, name)) {
      if (onConflict === 'replace') await trash(destOf(target, name))
      else {
        let n = 2
        while (alreadyThere(target, `${b.name}-${n}`)) n++
        name = `${b.name}-${n}`
      }
    }
    const md = b.files.get('SKILL.md')!.data.toString('utf8')
    const skillMd = name === b.name ? md : renameSkillMd(md, name)
    const tmp = join(target.dir, `.superagent-adding-${process.pid}-${Date.now()}-${names.length}`)
    try {
      if (target.layout === 'flat') {
        writeFileSync(tmp, toCodexPrompt(skillMd))
      } else {
        mkdirSync(tmp)
        for (const [rel, f] of b.files) {
          const abs = resolve(tmp, ...rel.split('/'))
          // Every path was checked when it was read; this is the second lock.
          if (relative(tmp, abs).startsWith('..') || safeRelPath(rel) !== rel)
            throw new SkillError('The skill has a file path that is not allowed.')
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, rel === 'SKILL.md' ? skillMd : f.data, {
            mode: f.executable ? 0o755 : 0o644
          })
        }
      }
      renameSync(tmp, destOf(target, name))
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true })
      throw err
    }
    names.push(name)
  }
  return names
}

// ---------- removing ----------

/**
 * The file or folder behind a skill the panel shows, if it is one the user may
 * remove from here: anything in the agent's global folders, and in a project
 * only what is in its skills folder (never other project files).
 */
export function removablePath(
  provider: AgentProvider,
  home: string,
  projectPath: string | undefined,
  skill: { name: string; scope: 'global' | 'project'; kind: 'skill' | 'command' }
): string | null {
  const { name, scope, kind } = skill
  if (!name || name !== basename(name) || name === '.' || name === '..' || name.includes('\\'))
    return null
  const dirs: string[] = []
  if (scope === 'global') {
    if (provider === 'codex')
      dirs.push(kind === 'skill' ? join(home, '.codex', 'skills') : join(home, '.codex', 'prompts'))
    else if (provider === 'antigravity') {
      if (kind === 'skill')
        dirs.push(
          join(home, '.gemini', 'config', 'skills'),
          join(home, '.gemini', 'antigravity-cli', 'skills')
        )
    } else
      dirs.push(
        kind === 'skill' ? join(home, '.claude', 'skills') : join(home, '.claude', 'commands')
      )
  } else {
    if (!projectPath || kind !== 'skill') return null
    const folder =
      provider === 'codex' ? '.codex' : provider === 'antigravity' ? '.agents' : '.claude'
    dirs.push(join(projectPath, folder, 'skills'))
  }
  // Discovery lets the later folder win, so the one shown is the last that has it.
  for (const dir of dirs.reverse()) {
    const p = join(dir, kind === 'skill' ? name : `${name}.md`)
    try {
      lstatSync(p)
      if (dirname(p) === dir) return p
    } catch {
      // not here
    }
  }
  return null
}
