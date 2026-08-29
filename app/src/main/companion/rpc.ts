import { z } from 'zod'
import {
  getTree,
  listAllChats,
  getChat,
  getWorkspace,
  kvGet,
  listCards,
  createChat,
  deleteChat,
  setChatTitle,
  lastChatPreview,
  searchChats,
  addCard,
  updateCard,
  moveCard,
  getWorkspacePath,
  DESKTOP_WORKSPACE_ID
} from '../store'
import * as auto from '../automation'
import { getPaneWebContents, ensureBackgroundPane, ensureCompositing } from '../browser'
import { nativeImage, BrowserWindow } from 'electron'
import { statSync } from 'fs'
import { extname } from 'path'
import {
  startAgent,
  stopAgent,
  sendToAgent,
  hardInterruptAgent,
  findSessionByChat,
  getSessionOpts,
  AgentStartOptions
} from '../agent'
import {
  gitBranch,
  gitBranches,
  gitCheckout,
  listProjectFiles,
  readTextFile,
  resolveInside
} from '../files'
import { listRoutines, runRoutine, setRoutineEnabled } from '../routines'
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
  ApprovalAnswerParams,
  WireBrowserShot,
  WireFileContent
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

const permissionModes = z.enum(['bypassPermissions', 'acceptEdits', 'plan', 'ask'])
const chatSend = z.object({
  chatId: z.string().min(1),
  text: z.string().max(200_000),
  images: z
    .array(z.object({ mediaType: z.string().regex(/^image\//), data: z.string().max(5_000_000) }))
    .max(6)
    .optional(),
  localId: z.string().max(80).optional(),
  model: z.string().max(60).optional(),
  permissionMode: permissionModes.optional()
})
const chatRename = z.object({ chatId: z.string().min(1), title: z.string().min(1).max(120) })
const chatId = z.object({ chatId: z.string().min(1) })
const chatCreate = z.object({ workspaceId: z.string().min(1) })
const approvalAnswer = z.object({
  id: z.string().min(1),
  approve: z.boolean(),
  trustRest: z.boolean().optional()
})
const routineRun = z.object({ id: z.string().min(1) })
const routineEnable = z.object({ id: z.string().min(1), enabled: z.boolean() })
const boardList = z.object({ workspaceId: z.string().min(1) })
const cardStatus = z.enum(['todo', 'doing', 'testing', 'done'])
const boardAdd = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().max(20_000).optional(),
  status: cardStatus.optional()
})
const boardUpdate = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(20_000).optional(),
  status: cardStatus.optional(),
  tags: z.array(z.string().max(40)).max(20).optional()
})
const boardMove = z.object({
  id: z.string().min(1),
  status: cardStatus,
  beforeId: z.string().nullable().optional()
})
const browserOpen = z.object({ chatId: z.string().min(1), url: z.string().min(1).max(4000) })
const browserShot = z.object({
  chatId: z.string().min(1),
  maxWidth: z.number().int().min(200).max(1600).optional()
})
const browserNav = z.object({
  chatId: z.string().min(1),
  action: z.enum(['back', 'forward', 'reload'])
})
const workspaceId = z.object({ workspaceId: z.string().min(1) })
const fileRead = z.object({ workspaceId: z.string().min(1), path: z.string().min(1).max(4000) })
const gitCheckoutParams = z.object({
  workspaceId: z.string().min(1),
  branch: z.string().min(1).max(200)
})
const chatSearch = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional()
})

/** How much of a text file a phone gets; the rest is marked truncated. */
const PHONE_TEXT_BYTES = 400_000
/** The largest picture a phone gets back, before base64 and the frame wrapper. */
const PHONE_IMAGE_BYTES = 600_000

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
      case 'chat.rename': {
        const p = chatRename.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!getChat(p.data.chatId)) return fail('not-found', 'no such chat')
        setChatTitle(p.data.chatId, p.data.title.trim())
        broadcastToWindows('projects:changed')
        pushChats()
        return { ok: true }
      }
      case 'chat.delete': {
        const p = chatId.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!getChat(p.data.chatId)) return fail('not-found', 'no such chat')
        const s = findSessionByChat(p.data.chatId)
        if (s) stopAgent(s.id)
        deleteChat(p.data.chatId)
        broadcastToWindows('projects:changed')
        pushChats()
        return { ok: true }
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
      case 'board.add': {
        const p = boardAdd.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!getWorkspace(p.data.workspaceId)) return fail('not-found', 'no such project')
        const card = addCard(p.data.workspaceId, p.data.title, {
          body: p.data.body,
          status: p.data.status
        })
        broadcastToWindows('board:changed', { workspaceId: p.data.workspaceId })
        return { ok: true, result: card }
      }
      case 'board.update': {
        const p = boardUpdate.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const { id, ...patch } = p.data
        const card = updateCard(id, patch)
        if (!card) return fail('not-found', 'no such card')
        broadcastToWindows('board:changed', { workspaceId: card.workspaceId })
        return { ok: true, result: card }
      }
      case 'board.move': {
        const p = boardMove.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const card = moveCard(p.data.id, p.data.status, p.data.beforeId ?? null)
        if (!card) return fail('not-found', 'no such card')
        broadcastToWindows('board:changed', { workspaceId: card.workspaceId })
        return { ok: true, result: card }
      }
      case 'routines.setEnabled': {
        const p = routineEnable.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!listRoutines().some((r) => r.id === p.data.id))
          return fail('not-found', 'no such routine')
        setRoutineEnabled(p.data.id, p.data.enabled)
        broadcastToWindows('routines:changed')
        return { ok: true }
      }
      case 'browser.open': {
        const p = browserOpen.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const pane = paneFor(p.data.chatId)
        if (!pane) return fail('not-found', 'no such chat')
        // The Mac may be showing another chat (or nothing): give this one a
        // live-but-hidden pane, the same one the window adopts when it opens
        // the chat, so the page is already there.
        if (!getPaneWebContents(pane)) {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) return fail('unavailable', 'SuperAgent has no window open')
          ensureBackgroundPane(win, pane)
        }
        ensureCompositing(pane)
        const url = await auto.navigate(pane, p.data.url)
        return { ok: true, result: { url } }
      }
      case 'browser.screenshot': {
        const p = browserShot.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const pane = paneFor(p.data.chatId)
        if (!pane) return fail('not-found', 'no such chat')
        const wc = getPaneWebContents(pane)
        if (!wc || wc.isDestroyed() || !/^https?:/i.test(wc.getURL()))
          return fail('unavailable', 'the browser is not open for this conversation')
        ensureCompositing(pane)
        const png = await withTimeout(
          auto.screenshot(pane),
          8000,
          'the browser did not produce a frame'
        )
        return { ok: true, result: shrinkShot(wc, png, p.data.maxWidth ?? 900) }
      }
      case 'browser.nav': {
        const p = browserNav.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const pane = paneFor(p.data.chatId)
        const wc = pane ? getPaneWebContents(pane) : undefined
        if (!wc || wc.isDestroyed())
          return fail('unavailable', 'the browser is not open for this conversation')
        if (p.data.action === 'back') wc.navigationHistory.goBack()
        else if (p.data.action === 'forward') wc.navigationHistory.goForward()
        else wc.reload()
        return { ok: true }
      }
      case 'files.list': {
        const p = workspaceId.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = getWorkspacePath(p.data.workspaceId)
        if (!root) return fail('not-found', 'no such project')
        return { ok: true, result: { root, files: listProjectFiles(root, 8000) } }
      }
      case 'files.read': {
        const p = fileRead.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = getWorkspacePath(p.data.workspaceId)
        if (!root) return fail('not-found', 'no such project')
        const abs = resolveInside(root, p.data.path)
        if (!abs) return fail('bad-params', 'that path is outside the project')
        return { ok: true, result: readForPhone(abs, p.data.path) }
      }
      case 'git.branches': {
        const p = workspaceId.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = getWorkspacePath(p.data.workspaceId)
        if (!root) return fail('not-found', 'no such project')
        return { ok: true, result: await gitBranches(root) }
      }
      case 'git.checkout': {
        const p = gitCheckoutParams.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = getWorkspacePath(p.data.workspaceId)
        if (!root) return fail('not-found', 'no such project')
        const r = await gitCheckout(root, p.data.branch)
        if (!r.ok) return fail('unavailable', r.error || 'git refused')
        broadcastToWindows('projects:changed')
        return { ok: true, result: { branch: gitBranch(root) } }
      }
      case 'chat.search': {
        const p = chatSearch.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        return {
          ok: true,
          result: searchChats(p.data.query, p.data.limit ?? 30).filter(
            (h) => h.workspaceId !== DESKTOP_WORKSPACE_ID
          )
        }
      }
      case 'screenshot.take':
        return fail('unavailable', 'use browser.screenshot')
      case 'device.presence':
        return { ok: true } // handled per connection in session.ts
      default:
        return fail('bad-params', `unknown method ${String(method)}`)
    }
  } catch (e) {
    return fail('internal', (e as Error).message)
  }
}

/**
 * The browser pane a conversation drives: per chat (`workspace::chat`) like the
 * desktop's, falling back to the workspace-level pane a browser project may use.
 */
function paneFor(chatId: string): string | null {
  const chat = getChat(chatId)
  if (!chat) return null
  const perChat = `${chat.workspaceId}::${chatId}`
  if (getPaneWebContents(perChat)) return perChat
  if (getPaneWebContents(chat.workspaceId)) return chat.workspaceId
  return perChat
}

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(why)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** A PNG capture, resized and re-encoded so the whole frame fits the relay. */
function shrinkShot(
  wc: Electron.WebContents,
  pngBase64: string,
  maxWidth: number
): WireBrowserShot {
  let img = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'))
  const size = img.getSize()
  if (size.width > maxWidth) img = img.resize({ width: maxWidth })
  let quality = 72
  let jpeg = img.toJPEG(quality)
  while (jpeg.length > PHONE_IMAGE_BYTES && quality > 30) {
    quality -= 12
    jpeg = img.toJPEG(quality)
  }
  const out = img.getSize()
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    width: out.width,
    height: out.height,
    jpeg: jpeg.toString('base64')
  }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp'
}

/** A project file in the shape a phone can show: text, a picture, or a size. */
function readForPhone(abs: string, rel: string): WireFileContent {
  let size = 0
  try {
    size = statSync(abs).size
  } catch {
    return { kind: 'binary', path: rel, size: 0 }
  }
  const type = IMAGE_TYPES[extname(abs).toLowerCase()]
  if (type) {
    let img = nativeImage.createFromPath(abs)
    if (img.isEmpty()) return { kind: 'binary', path: rel, size }
    if (img.getSize().width > 1200) img = img.resize({ width: 1200 })
    let quality = 80
    let jpeg = img.toJPEG(quality)
    while (jpeg.length > PHONE_IMAGE_BYTES && quality > 30) {
      quality -= 12
      jpeg = img.toJPEG(quality)
    }
    return {
      kind: 'image',
      path: rel,
      size,
      mediaType: 'image/jpeg',
      data: jpeg.toString('base64')
    }
  }
  const text = readTextFile(abs, 2 * 1024 * 1024)
  if (text === null) return { kind: 'binary', path: rel, size }
  const truncated = Buffer.byteLength(text) > PHONE_TEXT_BYTES
  return {
    kind: 'text',
    path: rel,
    size,
    text: truncated ? text.slice(0, PHONE_TEXT_BYTES) : text,
    truncated
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
      status: statuses.get(w.id) ?? 'idle',
      branch: w.kind === 'app' ? gitBranch(w.path) : null,
      browserUrl: w.browserUrl ?? null
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
      live: !!findSessionByChat(c.id),
      preview: lastChatPreview(c.id)
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
  // A different model or mode than the running agent's: restart it on the
  // same claude session, exactly as the desktop does when its pickers change.
  if (session && !session.owned && (p.model !== undefined || p.permissionMode !== undefined)) {
    const cur = getSessionOpts(session.id)
    const wantModel = p.model ?? cur?.model ?? ''
    const wantMode = p.permissionMode ?? cur?.permissionMode ?? 'bypassPermissions'
    if (
      (cur?.model ?? '') !== wantModel ||
      (cur?.permissionMode ?? 'bypassPermissions') !== wantMode
    ) {
      stopAgent(session.id)
      session = undefined
    }
  }
  if (!session) {
    const ws = getWorkspace(chat.workspaceId)
    if (!ws) return fail('not-found', 'no such project')
    const opts: AgentStartOptions = {
      cwd: chat.cwd ?? ws.path,
      workspaceId: ws.id,
      chatId: chat.id,
      resumeSessionId: getChat(chat.id)?.claudeSessionId ?? chat.claudeSessionId,
      browserProject: ws.kind === 'browser',
      permissionMode: p.permissionMode ?? permissionModeSetting(),
      model: p.model ?? (kvGet('cove.model') || undefined)
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
  return v === 'acceptEdits' || v === 'plan' || v === 'bypassPermissions' || v === 'ask'
    ? v
    : 'bypassPermissions'
}
