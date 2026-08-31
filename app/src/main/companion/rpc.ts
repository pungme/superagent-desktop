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
  chatCwd,
  isPendingBranch,
  markPendingBranch,
  takePendingBranch,
  createGroup,
  updateGroup,
  deleteGroup,
  createWorkspace,
  createBrowserWorkspace,
  deleteWorkspace,
  tabsGroupId,
  ensureDesktopWorkspace,
  DESKTOP_WORKSPACE_ID,
  TABS_GROUP,
  setChatCwd
} from '../store'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { readdirSync, existsSync, openSync, readSync, closeSync } from 'fs'
import * as auto from '../automation'
import {
  getPaneWebContents,
  ensureBackgroundPane,
  ensureCompositing,
  releaseCompositing
} from '../browser'
import { openSimulators, simStill, deviceLabel, sendSimInput } from '../simulator'
import { listWorktrees, ensureChatBranch, removeWorktree } from '../files'
import { nativeImage, BrowserWindow } from 'electron'
import { statSync } from 'fs'
import { extname, resolve, sep } from 'path'
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
  gitSubrepos,
  listProjectFiles,
  readTextFile,
  resolveInside
} from '../files'
import { listRoutines, runRoutine, setRoutineEnabled } from '../routines'
import { resolveGate } from '../hooks'
import { workspaceStatuses } from './status'
import { isGenerating } from './log'
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
  WireFileContent,
  WireFileChunk,
  WireDir
} from '../../shared/companion-protocol'
import { FILE_CHUNK_BYTES, FILE_CHUNK_MAX_BYTES } from '../../shared/companion-protocol'

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
// root: the conversation that lives in the project folder, which never cuts a
// branch. Anything else is a new conversation and gets its own copy on its
// first message. Older phones send neither, and a phone's "+ New chat" is the
// common case, so absent means new.
const chatCreate = z.object({ workspaceId: z.string().min(1), root: z.boolean().optional() })
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
const simShot = z.object({ chatId: z.string().min(1) })
const simInput = z.object({
  chatId: z.string().min(1),
  // Passed through to the Mac's own injector; it validates the shape.
  action: z.record(z.string(), z.unknown())
})
const browserNav = z.object({
  chatId: z.string().min(1),
  action: z.enum(['back', 'forward', 'reload'])
})
const workspaceId = z.object({ workspaceId: z.string().min(1) })
const fileRead = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1).max(4000),
  /** The conversation asking. On a worktree chat its files live there, not in the project. */
  chatId: z.string().min(1).optional()
})
const fileChunk = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1).max(4000),
  index: z.number().int().min(0).max(10_000),
  chatId: z.string().min(1).optional()
})
const fileList = z.object({
  workspaceId: z.string().min(1),
  chatId: z.string().min(1).optional()
})

/**
 * Where to look for a conversation's files: its worktree when the chat has one,
 * the project otherwise. A chat on a worktree writes there and nowhere else, so
 * rooting on the project shows main and hides everything the agent just made.
 */
function rootFor(p: { workspaceId: string; chatId?: string }): string | undefined {
  return (p.chatId ? chatCwd(p.chatId) : undefined) ?? getWorkspacePath(p.workspaceId)
}
const gitCheckoutParams = z.object({
  workspaceId: z.string().min(1),
  branch: z.string().min(1).max(200)
})
const chatSearch = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional()
})

const workspaceAdd = z.object({
  groupId: z.string().min(1),
  name: z.string().min(1).max(120),
  path: z.string().min(1).max(4000)
})
const browserCreate = z.object({ url: z.string().max(4000).optional() })
const idParam = z.object({ id: z.string().min(1) })
const groupCreate = z.object({ name: z.string().max(80).optional() })
const groupRename = z.object({ id: z.string().min(1), name: z.string().min(1).max(80) })
const dirsParams = z.object({ path: z.string().max(4000).optional() })

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
        if (!p.data.root) markPendingBranch(id)
        // Every phone (and the desktop sidebar) learns about the new row now.
        broadcastToWindows('projects:changed', {})
        pushChats()
        return { ok: true, result: { chatId: id } }
      }
      case 'chat.rename': {
        const p = chatRename.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!getChat(p.data.chatId)) return fail('not-found', 'no such chat')
        setChatTitle(p.data.chatId, p.data.title.trim())
        broadcastToWindows('projects:changed', {})
        pushChats()
        return { ok: true }
      }
      case 'chat.delete': {
        const p = chatId.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!getChat(p.data.chatId)) return fail('not-found', 'no such chat')
        const s = findSessionByChat(p.data.chatId)
        if (s) stopAgent(s.id)
        // Take the chat's copy of the project with it, exactly as the window
        // does. Deleting only the row left the worktree and its branch on disk,
        // so the Mac kept showing a row for a conversation that was gone.
        const dying = getChat(p.data.chatId)
        if (dying?.cwd && dying.cwd.includes('/.worktrees/')) {
          await removeWorktree(dying.cwd.split('/.worktrees/')[0], dying.cwd)
        }
        deleteChat(p.data.chatId)
        broadcastToWindows('projects:changed', {})
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
          if (!win) return fail('unavailable', 'Superagent has no window open')
          ensureBackgroundPane(win, pane)
        }
        // Composited only for the navigation itself. Screenshots park it again
        // when they need to; leaving it parked is what put a desktop-width page
        // in the Mac's window.
        ensureCompositing(pane)
        try {
          const url = await auto.navigate(pane, p.data.url)
          return { ok: true, result: { url } }
        } finally {
          releaseCompositing(pane)
        }
      }
      case 'browser.screenshot': {
        const p = browserShot.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const pane = paneFor(p.data.chatId)
        if (!pane) return fail('not-found', 'no such chat')
        const wc = getPaneWebContents(pane)
        if (!wc || wc.isDestroyed() || !/^https?:/i.test(wc.getURL()))
          return fail('unavailable', 'the browser is not open for this conversation')
        // Park it in the tree only for as long as the capture needs, and put it
        // back however that goes. A pane left composited keeps the page at
        // desktop width in the Mac's window.
        ensureCompositing(pane)
        try {
          const png = await withTimeout(
            auto.screenshot(pane),
            8000,
            'the browser did not produce a frame'
          )
          const shot = shrinkShot(wc, png, p.data.maxWidth ?? 900)
          if (!frameIsNew('browser:' + p.data.chatId, shot.jpeg)) {
            return { ok: true, result: { ...shot, jpeg: '', unchanged: true } }
          }
          return { ok: true, result: shot }
        } finally {
          releaseCompositing(pane)
        }
      }
      case 'sim.screenshot': {
        const p = simShot.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const udid = openSimulators().find((x) => x.chatId === p.data.chatId)?.udid
        if (!udid) return fail('not-found', 'no simulator open for this conversation')
        const url = await withTimeout(
          simStill(udid),
          20000,
          'the simulator did not produce a frame'
        )
        if (!url) return fail('unavailable', 'the simulator did not produce a frame')
        const device = await deviceLabel(udid)
        if (!frameIsNew('sim:' + p.data.chatId, url)) {
          return { ok: true, result: { udid, device, url: '', unchanged: true } }
        }
        return { ok: true, result: { udid, device, url } }
      }
      case 'sim.input': {
        const p = simInput.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const udid = openSimulators().find((x) => x.chatId === p.data.chatId)?.udid
        if (!udid) return fail('not-found', 'no simulator open for this conversation')
        const res = await sendSimInput(udid, p.data.action as never)
        return res.ok ? { ok: true, result: {} } : fail('unavailable', res.error ?? 'input failed')
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
        else {
          // Bypasses the cache — see the desktop's own reload for why: this
          // pane is always a dev server or a page the agent just edited, and a
          // cached reload can silently serve back the stale response it just
          // cached, from the phone exactly as much as from the Mac.
          if (wc.isLoading()) wc.stop()
          wc.reloadIgnoringCache()
        }
        return { ok: true }
      }
      case 'files.list': {
        const p = fileList.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = rootFor(p.data)
        if (!root) return fail('not-found', 'no such project')
        return { ok: true, result: { root, files: listProjectFiles(root, 8000) } }
      }
      case 'files.read': {
        const p = fileRead.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = rootFor(p.data)
        if (!root) return fail('not-found', 'no such project')
        const abs = resolveInside(root, p.data.path)
        if (!abs) return fail('bad-params', 'that path is outside the project')
        return { ok: true, result: readForPhone(abs, p.data.path) }
      }
      case 'files.chunk': {
        const p = fileChunk.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = rootFor(p.data)
        if (!root) return fail('not-found', 'no such project')
        const abs = resolveInside(root, p.data.path)
        if (!abs) return fail('bad-params', 'that path is outside the project')
        const chunk = readChunk(abs, p.data.path, p.data.index)
        if (!chunk) return fail('not-found', 'no such slice of that file')
        return { ok: true, result: chunk }
      }
      case 'worktrees.list': {
        const p = workspaceId.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const root = getWorkspacePath(p.data.workspaceId)
        if (!root) return fail('not-found', 'no such project')
        // The same list the window's sidebar draws, paired with the chats that
        // are in them. Each is only meaningful against the other: a branch with
        // no conversation is a row you can still open, and a chat whose copy
        // has been merged away should say so rather than vanish.
        const rows = await listWorktrees(root)
        // From the store, not listChats(): the wire shape has no cwd, and the
        // cwd is what says which copy of the project a chat is in.
        const chats = listAllChats().filter((c) => c.workspaceId === p.data.workspaceId)
        const norm = (v: string): string => v.replace(/\/+$/, '')
        return {
          ok: true,
          result: rows.map((w) => {
            // The folder's own chat has no cwd, so it matched no worktree and
            // the main row came back with no conversation at all — the phone
            // then opened whichever chat was touched last, or made a new one.
            // It is the same chat the window puts on the project row.
            const chat = w.main
              ? chats.find((c) => !c.cwd && !isPendingBranch(c.id))
              : chats.find((c) => c.cwd && norm(c.cwd) === norm(w.path))
            return { ...w, chatId: chat?.id, chatTitle: chat?.title ?? undefined }
          })
        }
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
        broadcastToWindows('projects:changed', {})
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
      case 'workspace.add': {
        const p = workspaceAdd.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        // Under the home folder, or inside a project that is already open (a
        // repo nested in a folder-of-repos lives wherever that project does).
        const dir = insideHome(p.data.path) ?? insideProject(p.data.path)
        if (!dir || !existsSync(dir))
          return fail(
            'bad-params',
            'that folder is not under your home directory or an open project'
          )
        const existing = getTree()
          .flatMap((g) => g.workspaces)
          .find((w) => w.path === dir)
        const id = existing?.id ?? createWorkspace(p.data.groupId, p.data.name, dir)
        broadcastToWindows('projects:changed', {})
        return { ok: true, result: { workspaceId: id, tree: listTree() } }
      }
      case 'workspace.createBrowser': {
        const p = browserCreate.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const id = createBrowserWorkspace(tabsGroupId(), 'New Tab', p.data.url)
        broadcastToWindows('projects:changed', {})
        return { ok: true, result: { workspaceId: id, tree: listTree() } }
      }
      case 'workspace.remove': {
        const p = idParam.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!getWorkspace(p.data.id) || p.data.id === DESKTOP_WORKSPACE_ID)
          return fail('not-found', 'no such project')
        for (const c of listAllChats()) {
          if (c.workspaceId !== p.data.id) continue
          const s = findSessionByChat(c.id)
          if (s) stopAgent(s.id)
        }
        deleteWorkspace(p.data.id)
        broadcastToWindows('projects:changed', {})
        pushChats()
        return { ok: true, result: { tree: listTree() } }
      }
      case 'group.create': {
        const p = groupCreate.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const id = createGroup(p.data.name ?? 'New group')
        broadcastToWindows('projects:changed', {})
        return { ok: true, result: { groupId: id, tree: listTree() } }
      }
      case 'group.rename': {
        const p = groupRename.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!updateGroup(p.data.id, { name: p.data.name }))
          return fail('not-found', 'no such group')
        broadcastToWindows('projects:changed', {})
        return { ok: true, result: { tree: listTree() } }
      }
      case 'group.delete': {
        const p = idParam.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        if (!deleteGroup(p.data.id)) return fail('unavailable', 'the last group stays')
        broadcastToWindows('projects:changed', {})
        return { ok: true, result: { tree: listTree() } }
      }
      case 'fs.dirs': {
        const p = dirsParams.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message)
        const dir = insideHome(p.data.path ?? homedir())
        if (!dir) return fail('bad-params', 'only folders under your home directory')
        return { ok: true, result: { path: dir, dirs: listDirs(dir) } }
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
/**
 * The digest of the last frame each mirror was sent. A mirror polls about once
 * a second; a page or a simulator that is not moving produced an identical
 * JPEG every time and every one of them crossed the relay. That is how a day's
 * byte budget went in an evening, and on the free plan it is also 4% of a
 * day's Durable Object requests for one person watching a still page.
 */
const lastFrameSent = new Map<string, string>()

/** True when this frame differs from the last one sent for that mirror. */
function frameIsNew(key: string, payload: string): boolean {
  const digest = createHash('sha1').update(payload).digest('hex')
  if (lastFrameSent.get(key) === digest) return false
  lastFrameSent.set(key, digest)
  return true
}

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
  // A PDF goes over whole, in slices: the phone renders it with PDFKit, which
  // keeps the text selectable and searchable — pictures of pages would not.
  if (extname(abs).toLowerCase() === '.pdf' && size > 0 && size <= FILE_CHUNK_MAX_BYTES) {
    return { kind: 'pdf', path: rel, size, chunks: Math.ceil(size / FILE_CHUNK_BYTES) }
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

/** One slice of a file's bytes, base64. Read at an offset rather than loading
 *  the whole file, so a big PDF costs one chunk of memory, not all of it. */
function readChunk(abs: string, rel: string, index: number): WireFileChunk | null {
  let size = 0
  try {
    size = statSync(abs).size
  } catch {
    return null
  }
  if (size <= 0 || size > FILE_CHUNK_MAX_BYTES) return null
  const chunks = Math.ceil(size / FILE_CHUNK_BYTES)
  if (index >= chunks) return null
  const offset = index * FILE_CHUNK_BYTES
  const length = Math.min(FILE_CHUNK_BYTES, size - offset)
  const buf = Buffer.alloc(length)
  let fd: number | null = null
  try {
    fd = openSync(abs, 'r')
    readSync(fd, buf, 0, length, offset)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return { path: rel, index, chunks, data: buf.toString('base64') }
}

/** A path a phone may name: absolute, under the home directory, no escapes. */
function insideHome(path: string): string | null {
  const home = resolve(homedir())
  const full = resolve(path.startsWith('~') ? home + path.slice(1) : path)
  return full === home || full.startsWith(home + sep) ? full : null
}

/** A path inside one of the open projects' folders, or null. */
function insideProject(path: string): string | null {
  const full = resolve(path)
  for (const w of getTree().flatMap((g) => g.workspaces)) {
    const root = resolve(w.path)
    if (full === root || full.startsWith(root + sep)) return full
  }
  return null
}

/** Visible sub-folders of one directory, repos flagged, as the Mac's picker would show. */
function listDirs(dir: string): WireDir[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => {
        const path = `${dir}${sep}${e.name}`
        return { name: e.name, path, repo: existsSync(`${path}${sep}.git`) }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 400)
  } catch {
    return []
  }
}
const SKIP_DIRS = new Set([
  'node_modules',
  'Library',
  'Applications',
  'Music',
  'Movies',
  'Pictures'
])

/**
 * The sidebar, as the phone sees it — same rows in the same order: the
 * Computer entry first, then the browser tabs group, then every project group
 * with each project's nested repos.
 */
export function listTree(): WireGroup[] {
  const statuses = workspaceStatuses()
  const groups: WireGroup[] = getTree().map((g) => ({
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
      browserUrl: w.browserUrl ?? null,
      subrepos: w.kind === 'app' ? gitSubrepos(w.path) : []
    }))
  }))
  // The Computer row exists on the Mac from its first click; a phone may be first.
  ensureDesktopWorkspace()
  const computer = getWorkspace(DESKTOP_WORKSPACE_ID)
  if (computer) {
    groups.unshift({
      id: 'computer',
      name: 'Computer',
      color: '',
      workspaces: [
        {
          id: DESKTOP_WORKSPACE_ID,
          name: 'Computer',
          path: computer.path,
          kind: 'desktop',
          status: statuses.get(DESKTOP_WORKSPACE_ID) ?? 'idle',
          branch: null,
          browserUrl: null,
          subrepos: []
        }
      ]
    })
  }
  // The tabs group keeps its internal name; the phone labels it like the Mac does.
  return groups.map((g) => (g.name === TABS_GROUP ? { ...g, name: TABS_GROUP } : g))
}

export function listChats(): WireChat[] {
  return listAllChats().map((c) => ({
    id: c.id,
    workspaceId: c.workspaceId,
    title: c.title,
    updatedAt: c.updatedAt,
    live: isGenerating(c.id),
    preview: lastChatPreview(c.id)
  }))
}

/**
 * Send a prompt into a chat, starting its agent first if nothing is running —
 * the same options the window would have used, read from the store.
 */
async function sendToChat(p: ChatSendParams): Promise<Awaited<RpcResult>> {
  const chat = getChat(p.chatId)
  if (!chat) return fail('not-found', 'no such chat')
  // First message on a git project: cut this chat its own copy, named from what
  // was asked for. Without it a chat from the phone runs in the project folder,
  // beside whatever else is working there.
  //
  // Only a chat that was opened as a NEW conversation, though. The chat in the
  // project folder has no cwd either, and branching it took the conversation
  // out from under the project row and left an empty one in its place — from
  // the phone, writing a message appeared to create a second chat.
  if (!chat.cwd && takePendingBranch(chat.id)) {
    const ws = getWorkspace(chat.workspaceId)
    if (ws && ws.kind !== 'browser' && gitBranch(ws.path) !== null) {
      const cwd = await ensureChatBranch(ws.path, p.text)
      if (cwd) {
        setChatCwd(chat.id, cwd)
        broadcastToWindows('projects:changed', {})
      }
    }
  }
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

/** Internals the companion tests reach for; not part of the RPC surface. */
export const __testing = { readForPhone, readChunk }
