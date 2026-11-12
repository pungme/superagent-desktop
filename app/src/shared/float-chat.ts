/**
 * Browser first: the page fills the desk and the chat floats over it. What the
 * app's page, main and the floating view (FloatChat.tsx) say to each other.
 * See main/float-chat.ts.
 */

/** The browser area the chat floats over, in window CSS pixels. */
export interface FloatPlace {
  chatId: string
  rect: { x: number; y: number; w: number; h: number }
}

/** How much room the floating chat needs right now (its view is no bigger). */
export interface FloatSize {
  w: number
  h: number
}

export interface FloatMessage {
  id: string
  me: boolean
  /** Plain text, for the floating chat; the full chat keeps the markdown. */
  text: string
}

export interface FloatState {
  chatId: string
  /** "Claude Code", "Codex", "Antigravity". */
  agent: string
  provider: 'claude' | 'codex' | 'antigravity'
  messages: FloatMessage[]
  working: boolean
  /** What it is doing, while working ("Editing prototype.html"). */
  status: string
  /** It asked something the floating chat cannot answer (a permission, a choice). */
  needsYou: boolean
}

export type FloatAction =
  | { type: 'send'; chatId: string; text: string }
  /** Back to the chat beside the page. */
  | { type: 'side' }
  /** Give the keyboard back to the app's page. */
  | { type: 'focus-app' }
  /** How much of the page's right side the open chat takes: the page moves over by it (0: none). */
  | { type: 'inset'; px: number }

/** From the menu: open the box (⌘J), the whole chat (⌘⇧J), or back to the mark. */
export type FloatCommand = 'toggle' | 'full' | 'close'

/** The open card's width: what it starts at, and how far it can be dragged. */
export const CARD_W = { initial: 470, min: 360, max: 760 }
/** The whole chat's width. */
export const DRAWER_W = 400

/** Margin between the chat and the edge of the page it floats over. */
export const FLOAT_MARGIN = 18

/**
 * Where the floating chat's view goes: in the bottom-right corner of the page,
 * at the size the chat asked for, never larger than the page.
 */
export function floatBounds(
  rect: FloatPlace['rect'],
  size: FloatSize
): { x: number; y: number; width: number; height: number } {
  const w = Math.round(Math.min(size.w, Math.max(0, rect.w - FLOAT_MARGIN)))
  const h = Math.round(Math.min(size.h, Math.max(0, rect.h - FLOAT_MARGIN)))
  return {
    x: Math.round(rect.x + rect.w - w - FLOAT_MARGIN),
    y: Math.round(rect.y + rect.h - h - FLOAT_MARGIN),
    width: w,
    height: h
  }
}

/** A message as the floating chat shows it: markdown taken down to plain words. */
export function plainText(md: string, max = 600): string {
  const t = md
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * One short line of what the agent is doing, for the floating chat: "Editing
 * index.html", "Terminal npm test". A path is cut to its file name; anything
 * else to its first line.
 */
export function floatStatus(verb: string, detail: string): string {
  // A command's leading NAME=value settings say nothing about what it does.
  const d = detail
    .trim()
    .split('\n')[0]
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
  const what = /^[^\s]+\/[^\s]+$/.test(d) ? (d.split('/').pop() ?? d) : d
  const line = what ? `${verb} ${what}` : verb
  return line.length > 48 ? line.slice(0, 47) + '…' : line
}
