/**
 * Every picture in a conversation, in the order it appeared: what the user
 * attached, what a tool returned (a screenshot), and what the agent showed in
 * its reply. This is what the chat's Images view lists.
 */
export type ChatImageRef =
  /** Bytes already in the window: a picture the user attached here. */
  | { kind: 'data'; key: string; from: 'you'; src: string; at?: number }
  /** Kept by the Mac under a message or tool id: fetched by id and index. */
  | { kind: 'remote'; key: string; from: 'you' | 'agent'; id: string; index: number; at?: number }
  /** Named in the agent's reply: a path on this Mac, or a web address. */
  | { kind: 'path'; key: string; from: 'agent'; src: string; alt: string; at?: number }

interface MessageLike {
  id: string
  role: 'user' | 'assistant'
  text: string
  images?: string[]
  imageCount?: number
  at?: number
  system?: boolean
}
type ItemLike =
  | { kind: 'msg'; msg: MessageLike }
  | { kind: 'tool'; tool: { id: string; imageCount?: number } }
  | { kind: string }

/** The images a piece of Markdown shows, leaving out anything inside code. */
export function markdownImages(text: string): { src: string; alt: string }[] {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '')
  const found: { src: string; alt: string }[] = []
  const re = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g
  for (let m = re.exec(prose); m; m = re.exec(prose))
    found.push({ alt: m[1], src: m[2].replace(/^<|>$/g, '') })
  return found
}

export function chatImageRefs(items: ItemLike[]): ChatImageRef[] {
  const out: ChatImageRef[] = []
  for (const it of items) {
    if (it.kind === 'tool' && 'tool' in it) {
      for (let i = 0; i < (it.tool.imageCount ?? 0); i++)
        out.push({
          kind: 'remote',
          key: `${it.tool.id}:${i}`,
          from: 'agent',
          id: it.tool.id,
          index: i
        })
      continue
    }
    if (it.kind !== 'msg' || !('msg' in it)) continue
    const m = it.msg
    if (m.system) continue
    if (m.images?.length)
      m.images.forEach((src, i) =>
        out.push({ kind: 'data', key: `${m.id}:${i}`, from: 'you', src, at: m.at })
      )
    else
      for (let i = 0; i < (m.imageCount ?? 0); i++)
        out.push({
          kind: 'remote',
          key: `${m.id}:${i}`,
          from: m.role === 'user' ? 'you' : 'agent',
          id: m.id,
          index: i,
          at: m.at
        })
    if (m.role === 'assistant')
      markdownImages(m.text).forEach((im, i) =>
        out.push({ kind: 'path', key: `${m.id}:md:${i}`, from: 'agent', ...im, at: m.at })
      )
  }
  return out
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic'
}

/** A data: URL as its type and bytes (base64), or null when it is not one. */
export function dataUrlParts(
  url: string
): { mediaType: string; ext: string; base64: string } | null {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(url)
  if (!m || !EXT[m[1]]) return null
  return { mediaType: m[1], ext: EXT[m[1]], base64: m[2] }
}

/**
 * A file name that is free in a folder: "shot.png", then "shot 2.png". Names
 * are compared without regard to case, as the Mac's disk does.
 */
export function freeName(taken: string[], wanted: string): string {
  const clean = wanted.replace(/[/\\:\0]/g, '-').trim() || 'image'
  const has = new Set(taken.map((n) => n.toLowerCase()))
  if (!has.has(clean.toLowerCase())) return clean
  const dot = clean.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
  for (let n = 2; ; n++) {
    const next = `${stem} ${n}${ext}`
    if (!has.has(next.toLowerCase())) return next
  }
}

/** The name a picture with no file behind it is saved under. */
export function stampedName(ext: string, now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Superagent ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} at ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.${ext}`
}
