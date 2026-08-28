import { z } from 'zod'
import {
  getTree,
  listAllChats,
  getChat,
  getWorkspace,
  kvGet,
  listCards,
  createChat,
  DESKTOP_WORKSPACE_ID
} from '../store'
import {
  startAgent,
  sendToAgent,
  hardInterruptAgent,
  findSessionByChat,
  AgentStartOptions
} from '../agent'
import { listRoutines, runRoutine } from '../routines'
import { resolveGate } from '../hooks'
import { workspaceStatuses } from './status'
import { pushChats } from './index'
import { broadcastToWindows } from '../util'
import type {
  RpcMethod,
  RpcErrorCode,
  WireGroup,
  WireChat,
  ChatSendParams,
  ApprovalAnswerParams
} from '../../shared/companion-protocol'

/**
 * What the phone may ask the Mac to do. Every method is a thin adapter onto a
 * function main already has; params are validated before anything runs.
 */

export type RpcResult =
  { ok: true; result?: unknown } | { ok: false; error: { code: RpcErrorCode; message: string } }

const fail = (code: RpcErrorCode, message: string): RpcResult => ({
  ok: false,
  error: { code, message }
})

const chatSend = z.object({
  chatId: z.string().min(1),
  text: z.string().max(200_000),
  images: z
    .array(z.object({ mediaType: z.string().regex(/^image\//), data: z.string().max(5_000_000) }))
    .max(6)
    .optional(),
  localId: z.string().max(80).optional()
})
const chatId = z.object({ chatId: z.string().min(1) })
const chatCreate = z.object({ workspaceId: z.string().min(1) })
const approvalAnswer = z.object({
  id: z.string().min(1),
  approve: z.boolean(),
  trustRest: z.boolean().optional()
})
const routineRun = z.object({ id: z.string().min(1) })
const boardList = z.object({ workspaceId: z.string().min(1) })

export async function handleRpc(method: RpcMethod, params: unknown): Promise<RpcResult> {
  try {
    switch (method) {
      case 'tree.list':
        return { ok: true, result: listTree() }
      case 'chat.list':
        return { ok: true, result: listChats() }
      case 'chat.send': {
        const p = chatSend.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        return sendToChat(p.data)
      }
      case 'chat.interrupt': {
        const p = chatId.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const s = findSessionByChat(p.data.chatId)
        if (!s) return fail('not-found', 'no running agent for this chat')
        await hardInterruptAgent(s.id)
        return { ok: true }
      }
      case 'chat.create': {
        const p = chatCreate.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!getWorkspace(p.data.workspaceId)) return fail('not-found', 'no such project')
        const id = createChat(p.data.workspaceId)
        // Every phone (and the desktop sidebar) learns about the new row now.
        broadcastToWindows('projects:changed')
        pushChats()
        return { ok: true, result: { chatId: id } }
      }
      case 'approval.answer': {
        const p = approvalAnswer.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const a: ApprovalAnswerParams = p.data
        const done = resolveGate(a.id, a.approve, a.trustRest ?? false, 'ios')
        return done ? { ok: true } : fail('gone', 'that approval is no longer waiting')
      }
      case 'routines.list':
        return { ok: true, result: listRoutines() }
      case 'routines.runNow': {
        const p = routineRun.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const r = listRoutines().find((x) => x.id === p.data.id)
        if (!r) return fail('not-found', 'no such routine')
        void runRoutine(r)
        return { ok: true }
      }
      case 'board.list': {
        const p = boardList.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        return { ok: true, result: listCards(p.data.workspaceId) }
      }
      case 'screenshot.take':
        return fail('unavailable', 'screenshots arrive in a later version')
      case 'device.presence':
        return { ok: true } // handled per connection in session.ts
      default:
        return fail('bad-params', `unknown method ${String(method)}`)
    }
  } catch (e) {
    return fail('internal', (e as Error).message)
  }
}

/** The sidebar, as the phone sees it. */
export function listTree(): WireGroup[] {
  const statuses = workspaceStatuses()
  return getTree().map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    workspaces: g.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      kind: w.kind,
      status: statuses.get(w.id) ?? 'idle'
    }))
  }))
}

export function listChats(): WireChat[] {
  return listAllChats()
    .filter((c) => c.workspaceId !== DESKTOP_WORKSPACE_ID)
    .map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      title: c.title,
      updatedAt: c.updatedAt,
      live: !!findSessionByChat(c.id)
    }))
}

/**
 * Send a prompt into a chat, starting its agent first if nothing is running —
 * the same options the window would have used, read from the store.
 */
function sendToChat(p: ChatSendParams): RpcResult {
  const chat = getChat(p.chatId)
  if (!chat) return fail('not-found', 'no such chat')
  let session = findSessionByChat(p.chatId)
  if (!session) {
    const ws = getWorkspace(chat.workspaceId)
    if (!ws) return fail('not-found', 'no such project')
    const opts: AgentStartOptions = {
      cwd: chat.cwd ?? ws.path,
      workspaceId: ws.id,
      chatId: chat.id,
      resumeSessionId: chat.claudeSessionId,
      browserProject: ws.kind === 'browser',
      permissionMode: permissionModeSetting(),
      model: kvGet('cove.model') || undefined
    }
    const id = startAgent(null, opts)
    session = { id, chatId: chat.id, workspaceId: ws.id, owned: false }
  }
  const sent = sendToAgent(session.id, p.text, p.images ?? [], { from: 'ios', localId: p.localId })
  return sent
    ? { ok: true, result: { sessionId: session.id } }
    : fail('unavailable', 'agent not accepting input')
}

function permissionModeSetting(): AgentStartOptions['permissionMode'] {
  const v = kvGet('cove.permissionMode')
  return v === 'acceptEdits' || v === 'plan' || v === 'bypassPermissions' ? v : 'bypassPermissions'
}
