/**
 * Wire protocol between SuperAgent desktop and its phone companion.
 *
 * Everything the phone ever sees is described here, and only here. The Swift
 * side (superagent-ios, Sources/Protocol/Frames.swift) mirrors these shapes;
 * the JSON fixtures in fixtures/companion/ are decoded by both test suites so a
 * change that breaks one side fails the other's tests.
 *
 * Shared between main and renderer (the Settings UI shows devices and pairing
 * payloads), so this module must stay free of Electron and Node imports.
 */

export const PROTOCOL_VERSION = 1

// --- Events: the per-chat, append-only, sequence-numbered log ---------------

/** What a single entry in a chat's event log can be. */
export type WireEventKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'diff'
  | 'turn_end'
  | 'session'
  | 'notice'
  | 'approval'
  | 'approval_end'

export interface DiffHunk {
  removed: string[]
  added: string[]
}

export type WireEventData =
  | {
      kind: 'user'
      id: string
      text: string
      images?: { mediaType: string; size: number }[]
      from: 'desktop' | 'ios'
    }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; detail: string; task?: TaskInfo }
  | { kind: 'tool_result'; toolId: string; ok: boolean; summary: string }
  | { kind: 'diff'; id: string; file: string; hunks: DiffHunk[] }
  | { kind: 'turn_end'; ok: boolean; subtype: string; costUsd?: number; tokens?: number }
  | { kind: 'session'; claudeSessionId: string; model?: string; commands?: string[] }
  | { kind: 'notice'; text: string }
  | {
      kind: 'approval'
      id: string
      toolName: string
      preview: string
      approvalKind: 'guardrail' | 'permission'
      expiresAt: number
    }
  | {
      kind: 'approval_end'
      id: string
      outcome: 'approved' | 'denied' | 'expired'
      by: 'desktop' | 'ios'
    }

/** A persisted, replayable entry. `seq` is per chat and strictly increasing. */
export interface WireEvent {
  chatId: string
  seq: number
  ts: number
  data: WireEventData
}

// --- Summaries the phone lists ---------------------------------------------

export interface WireGroup {
  id: string
  name: string
  color: string
  workspaces: WireWorkspace[]
}

export interface WireWorkspace {
  id: string
  name: string
  path: string
  /** 'desktop' is the Computer row: the agent that drives the whole Mac. */
  kind: 'app' | 'browser' | 'desktop'
  status: 'idle' | 'working' | 'needs-you'
  /** Current git branch, when the project is a repository. */
  branch?: string | null
  /** Browser projects: the site they live on (for a favicon). */
  browserUrl?: string | null
  /** Git repos one level inside a code project (a folder of repos), as the sidebar's tree. */
  subrepos?: { name: string; path: string; branch: string | null }[]
}

/** `fs.dirs`: one folder on the Mac, for picking a project. */
export interface WireDir {
  name: string
  path: string
  /** It has a .git — the sidebar would show a branch chip. */
  repo: boolean
}

export interface WireChat {
  id: string
  workspaceId: string
  title: string | null
  updatedAt: number
  /** Whether a claude process is alive for this chat right now. */
  live: boolean
  /** The last thing said in it, for the list row. */
  preview?: string | null
}

export interface WireMachine {
  name: string
  appVersion: string
  protocol: number
}

// --- Frames: what travels over the (encrypted) socket -----------------------

/** Phone → Mac */
export type ClientFrame =
  | { t: 'hello'; v: number; device: string; token: string; app: string }
  | { t: 'pair'; device: { id: string; name: string; model: string; pushToken?: string } }
  | { t: 'subscribe'; chatId: string; afterSeq: number }
  | { t: 'unsubscribe'; chatId: string }
  | { t: 'req'; id: string; method: RpcMethod; params?: unknown }
  | { t: 'ping' }

/** Mac → Phone */
export type ServerFrame =
  | { t: 'welcome'; machine: WireMachine; tree: WireGroup[]; chats: WireChat[] }
  | { t: 'paired'; token: string; machine: WireMachine }
  | { t: 'bye'; reason: 'unauthorized' | 'revoked' | 'version' | 'pairing-closed' }
  | { t: 'event'; event: WireEvent }
  | { t: 'delta'; chatId: string; text: string }
  | { t: 'status'; workspaceId: string; status: 'idle' | 'working' | 'needs-you' }
  | { t: 'chats'; chats: WireChat[] }
  | { t: 'res'; id: string; ok: true; result?: unknown }
  | { t: 'res'; id: string; ok: false; error: { code: RpcErrorCode; message: string } }
  | { t: 'pong' }

/**
 * What a planning tool call said, so the phone can keep a Tasks panel without
 * parsing tool inputs itself: TodoWrite carries the whole list, TaskCreate one
 * new item, TaskUpdate a status change.
 */
export interface TaskInfo {
  todos?: { text: string; status: string }[]
  subject?: string
  description?: string
  taskId?: string
  status?: string
}

export type RpcMethod =
  | 'tree.list'
  | 'chat.list'
  | 'chat.send'
  | 'chat.interrupt'
  | 'chat.create'
  | 'chat.rename'
  | 'chat.delete'
  | 'approval.answer'
  | 'routines.list'
  | 'routines.runNow'
  | 'board.list'
  | 'board.add'
  | 'board.update'
  | 'board.move'
  | 'routines.setEnabled'
  | 'browser.open'
  | 'browser.screenshot'
  | 'browser.nav'
  | 'files.list'
  | 'files.read'
  | 'git.branches'
  | 'git.checkout'
  | 'chat.search'
  | 'workspace.add'
  | 'workspace.createBrowser'
  | 'workspace.remove'
  | 'group.create'
  | 'group.rename'
  | 'group.delete'
  | 'fs.dirs'
  | 'screenshot.take'
  | 'device.presence'

export type RpcErrorCode = 'bad-params' | 'not-found' | 'gone' | 'unavailable' | 'internal'

export interface ChatSendParams {
  chatId: string
  text: string
  images?: { mediaType: string; data: string }[]
  /** Client-generated id, echoed in the resulting `user` event for dedupe. */
  localId?: string
  /** Per-chat overrides; a running agent is restarted (resumed) if they differ. */
  model?: string
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'ask'
}

export interface ApprovalAnswerParams {
  id: string
  approve: boolean
  trustRest?: boolean
}

// --- Pairing ---------------------------------------------------------------

/** What the QR encodes (as base64url JSON). */
export interface PairPayload {
  v: number
  /** Human name of the Mac, for the phone's list. */
  name: string
  /** Relay URL, e.g. wss://superagent-relay.superagent-relay.workers.dev */
  relay: string
  /** Machine id — hex of the Mac's Ed25519 public key. */
  m: string
  /** 32-byte per-device secret, base64url. Single use, short-lived. */
  k: string
}

/** The 6-digit code both screens show, derived from the secret and machine id. */
export function pairingCodeFromDigest(digestHex: string): string {
  // First 6 decimal digits of the digest read as a big number — same on both
  // sides, no locale surprises. Callers pass SHA-256(k || m) as hex.
  const n = BigInt('0x' + digestHex.slice(0, 16))
  return (n % 1000000n).toString().padStart(6, '0')
}

/** `browser.screenshot`: what the conversation's browser pane shows right now. */
export interface WireBrowserShot {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  width: number
  height: number
  /** JPEG, base64. Sized to fit one relay frame. */
  jpeg: string
}

/** `files.read`: a project file, in whichever form the phone can show. */
export type WireFileContent =
  | { kind: 'text'; path: string; size: number; text: string; truncated: boolean }
  | { kind: 'image'; path: string; size: number; mediaType: string; data: string }
  | { kind: 'binary'; path: string; size: number }

export interface WireBranch {
  name: string
  current: boolean
  worktree: string | null
}

/** `chat.search`: one matching message, newest first. */
export interface WireSearchHit {
  chatId: string
  workspaceId: string
  title: string | null
  ts: number
  role: 'user' | 'assistant'
  snippet: string
}
