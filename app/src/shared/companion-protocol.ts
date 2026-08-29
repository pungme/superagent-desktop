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
  | { kind: 'tool'; id: string; name: string; detail: string }
  | { kind: 'tool_result'; toolId: string; ok: boolean; summary: string }
  | { kind: 'diff'; id: string; file: string; hunks: DiffHunk[] }
  | { kind: 'turn_end'; ok: boolean; subtype: string; costUsd?: number; tokens?: number }
  | { kind: 'session'; claudeSessionId: string; model?: string }
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
  kind: 'app' | 'browser'
  status: 'idle' | 'working' | 'needs-you'
}

export interface WireChat {
  id: string
  workspaceId: string
  title: string | null
  updatedAt: number
  /** Whether a claude process is alive for this chat right now. */
  live: boolean
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

export type RpcMethod =
  | 'tree.list'
  | 'chat.list'
  | 'chat.send'
  | 'chat.interrupt'
  | 'chat.create'
  | 'approval.answer'
  | 'routines.list'
  | 'routines.runNow'
  | 'board.list'
  | 'screenshot.take'
  | 'device.presence'

export type RpcErrorCode = 'bad-params' | 'not-found' | 'gone' | 'unavailable' | 'internal'

export interface ChatSendParams {
  chatId: string
  text: string
  images?: { mediaType: string; data: string }[]
  /** Client-generated id, echoed in the resulting `user` event for dedupe. */
  localId?: string
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
