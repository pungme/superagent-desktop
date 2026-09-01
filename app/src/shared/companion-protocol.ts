/**
 * Wire protocol between Superagent desktop and its phone companion.
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
      /**
       * The message this one is answering, WhatsApp-style.
       *
       * Carried beside the text rather than inside it. The agent is told about
       * the quote by a blockquote prefixed to what it receives, but that prefix
       * is for the agent — a device rendering the conversation wants the quote
       * as its own thing so it can draw a chip, and wants `text` to be only
       * what the person actually typed.
       */
      replyTo?: { role: 'user' | 'assistant'; text: string }
    }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; detail: string; task?: TaskInfo }
  | { kind: 'tool_result'; toolId: string; ok: boolean; summary: string }
  | { kind: 'diff'; id: string; file: string; hunks: DiffHunk[] }
  | { kind: 'turn_end'; ok: boolean; subtype: string; costUsd?: number; tokens?: number }
  | { kind: 'session'; claudeSessionId: string; model?: string; commands?: string[] }
  | { kind: 'notice'; text: string }
  /**
   * A file the agent handed to the user: a generated PDF, an export, a report.
   * Recorded when it opens one, so the conversation keeps it rather than the
   * file existing only as a path in some tool call. `workspaceId` and `path`
   * are what the phone needs to fetch it; `path` is relative to the project
   * when it sits inside one, absolute when it does not.
   */
  | {
      kind: 'file'
      id: string
      path: string
      name: string
      workspaceId?: string
      size?: number
      mediaType?: string
    }
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
  /**
   * Which copy of the project this chat is in: '' for the project folder
   * itself, otherwise the worktree's path. The phone needs it to tell the
   * folder's own chat — the one the project row opens — from a chat on a
   * branch, which it could only guess at before. Absent from older Macs.
   */
  cwd?: string
  /**
   * Waiting for its first message to cut its branch. It has no cwd yet, exactly
   * like the folder's own chat, so without this the phone would mistake a new
   * conversation for the one the project row opens — the same trap the window's
   * sidebar has to step around.
   */
  pending?: boolean
  /**
   * Which agent this conversation runs on. The phone's model and mode pickers
   * are Claude Code's, and it had no way to know a conversation was on Codex —
   * so it sent settings the other agent refuses to start with. Absent from
   * older Macs, which is why the Mac also drops a setting that does not belong.
   */
  provider?: 'claude' | 'codex'
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
  /**
   * The agent called `open_file` and wants the user to see a file. `chatId`
   * scopes it to the conversation that asked, so a background chat's file does
   * not open over the one you are reading; null means the workspace's agent.
   */
  | { t: 'openFile'; workspaceId: string; path: string; chatId: string | null }
  | { t: 'browser'; browser: WireBrowser }
  | { t: 'simulator'; simulator: WireSimulator }
  | { t: 'res'; id: string; ok: true; result?: unknown }
  | { t: 'res'; id: string; ok: false; error: { code: RpcErrorCode; message: string } }
  | { t: 'pong' }

/**
 * What a conversation currently has open in the Mac's browser pane — the phone
 * shows the page above its chat the way the desktop shows it beside one.
 * `open: false` means the pane went away.
 */
export interface WireBrowser {
  chatId: string
  open: boolean
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/** The iOS Simulator a conversation has open on the Mac, mirrored to the phone. */
export interface WireSimulator {
  chatId: string
  open: boolean
  udid: string
  /** "iPhone 17 Pro · iOS 26.5", for the mirror's title. */
  device: string
}

/** `sim.screenshot`: a still of the device the conversation has open. */
export interface WireSimulatorShot {
  udid: string
  device: string
  /** A whole `data:image/jpeg;base64,…` URL, as the Mac's own pane uses. */
  url: string
}

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

/**
 * One checkout of a project: the folder you opened, or a branch cut from it.
 * The desktop's sidebar is a row per one of these, so the phone's is too.
 */
export interface WireWorktree {
  path: string
  branch: string | null
  /** The folder the project was opened as, rather than a branch cut from it. */
  main: boolean
  /** Where this branch merges home to. Null for main. */
  base: string | null
  /** The conversation happening in it, when there is one. */
  chatId?: string
  chatTitle?: string
}

export type RpcMethod =
  | 'tree.list'
  | 'chat.list'
  | 'chat.send'
  | 'chat.interrupt'
  | 'chat.create'
  | 'chat.setAgent'
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
  | 'sim.screenshot'
  | 'sim.input'
  | 'files.list'
  | 'files.read'
  | 'files.chunk'
  | 'chat.image'
  | 'git.branches'
  | 'worktrees.list'
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
  /**
   * The message this one answers, WhatsApp-style. The Mac turns it into the
   * blockquote the agent reads and records it beside the text, so every device
   * showing this conversation can draw the quote.
   */
  replyTo?: { role: 'user' | 'assistant'; text: string }
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
  /**
   * A PDF: the phone renders it itself with PDFKit, so it wants the bytes, not
   * pictures of pages — that keeps the text selectable and searchable. The
   * relay caps a frame at 1 MB, so the bytes come in `chunks` pulls of
   * `files.chunk` instead of riding along here.
   */
  | { kind: 'pdf'; path: string; size: number; chunks: number }
  | { kind: 'binary'; path: string; size: number }

/**
 * `chat.image`: the thumbnail for one picture on one message. The bytes of an
 * attachment never enter the event log, so a device that did not send the
 * message asks the Mac for them when it comes to draw it.
 */
export interface WireImage {
  messageId: string
  index: number
  mediaType: string
  data: string
}

/** `files.chunk`: one slice of a file's bytes, base64, indexed from 0. */
export interface WireFileChunk {
  path: string
  index: number
  chunks: number
  data: string
}

/** Bytes per `files.chunk` pull, before base64. Sized so a chunk plus its JSON
 *  envelope stays under the relay's 1 MB frame ceiling. */
export const FILE_CHUNK_BYTES = 480_000

/** The largest file the phone will pull in chunks; past this it just gets a size. */
export const FILE_CHUNK_MAX_BYTES = 25 * 1024 * 1024

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
