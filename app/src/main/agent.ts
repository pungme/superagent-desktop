import { ipcMain, WebContents } from 'electron'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import os from 'os'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { writeWorkspaceMcpConfig } from './mcp'
import { loadChatItems, getChatProvider, setChatSession } from './store'
import type { LegacyItem } from './transcript'
import { startClaudeSession, suggestTitleWithClaude } from './claude/session'
import { startCodexSession, suggestTitleWithCodex } from './codex/session'
import type {
  AgentBackend,
  AgentImage,
  AgentStartOptions,
  SessionContext,
  SessionHost
} from './agent-backend'
import { DEFAULT_PROVIDER, PROVIDER_LABEL, type AgentProvider } from '../shared/agent-provider'

export type { AgentBackend, AgentImage, AgentStartOptions } from './agent-backend'

/**
 * A chat's agent session — whichever backend is behind it.
 *
 * This file owns what every session shares no matter which CLI runs it: the
 * registry, which window owns a session and what happens when that window goes
 * away, the recap for a session that lost its memory, images pasted into a
 * message, and the bus the renderer, the phone and the transcript all read.
 *
 * It owns nothing about a CLI. Claude Code lives in `claude/session.ts`, Codex
 * in `codex/`, behind the `AgentBackend` seam in `agent-backend.ts`; they do not
 * import each other, and the only line where they meet is the `if` at the end of
 * startAgent. A change to one backend cannot regress the other.
 */

interface AgentSession {
  id: string
  backend: AgentBackend
  /**
   * The window that drives this session, if any. A session the phone started
   * has none until a window opens its chat and adopts it (see agent:start).
   */
  owner: WebContents | null
  killed?: boolean
  chatId?: string
  workspaceId?: string
  opts: AgentStartOptions
  /** The last `system/init` event, replayed to a window that adopts the session. */
  lastInit?: Record<string, unknown>
}

const sessions = new Map<string, AgentSession>()

/**
 * Everything a session says, for anyone in main who cares — the companion's
 * event log first of all. The renderer bridge below is just one subscriber.
 *
 *  - 'event'       { id, chatId, workspaceId, event }   raw stream-json object
 *  - 'stderr'      { id, chatId, workspaceId, text }
 *  - 'exit'        { id, chatId, workspaceId, code }
 *  - 'resume-lost' { id, chatId, workspaceId }
 *  - 'user'        { id, chatId, workspaceId, text, images, from, localId }
 *  - 'started'     { id, chatId, workspaceId }
 */
export const agentBus = new EventEmitter()
agentBus.setMaxListeners(50)

export interface AgentSessionInfo {
  id: string
  chatId?: string
  workspaceId?: string
  owned: boolean
}

export function findSessionByChat(chatId: string): AgentSessionInfo | undefined {
  for (const s of sessions.values()) {
    if (s.chatId === chatId)
      return { id: s.id, chatId: s.chatId, workspaceId: s.workspaceId, owned: !!s.owner }
  }
  return undefined
}

/** What a session was started with — to tell whether a requested change needs a restart. */
export function getSessionOpts(id: string): AgentStartOptions | undefined {
  return sessions.get(id)?.opts
}

export function listSessions(): AgentSessionInfo[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    chatId: s.chatId,
    workspaceId: s.workspaceId,
    owned: !!s.owner
  }))
}

/**
 * A window takes over a session that was running without one (started from
 * the phone). From here on it streams to that window like any other session,
 * and dies with it on reload — the renderer's own lifecycle rules apply.
 */
function adoptSession(session: AgentSession, owner: WebContents): void {
  session.owner = owner
  watchOwner(owner)
  const init = session.lastInit
  if (init) {
    // The renderer waits for init to enable its composer; it already happened.
    setTimeout(() => {
      if (!owner.isDestroyed()) owner.send(`agent:event:${session.id}`, init)
    }, 0)
  }
}

/**
 * Kill every session a renderer owns. A reload tears the page down without running
 * React's effect cleanups, so the chats never get to call agent:stop and their
 * `claude` processes are orphaned — alive, idle on stdin, and unreachable, since
 * the new page has no idea they exist. Left alone each reload (or renderer crash)
 * strands one process per open chat for the life of the app.
 */
function killSessionsOwnedBy(owner: WebContents): void {
  for (const [id, session] of [...sessions]) {
    if (session.owner === owner) stopAgent(id)
  }
}

/**
 * Sessions that died before anyone could hear about it.
 *
 * startAgent returns the id over IPC and the renderer subscribes to
 * agent:exit:<id> only once that round trip lands — but a spawn failure
 * (missing binary, a project folder that no longer exists) arrives on the very
 * next tick, before the subscription exists, so the event went nowhere and the
 * chat span forever saying "Working". Record it here and let the renderer ask.
 */
const deadSessions = new Map<string, { code: number; reason?: string }>()

function markDead(id: string, code: number, reason?: string): void {
  deadSessions.set(id, { code, reason })
  // Long enough for the renderer to ask, short enough not to be a leak.
  setTimeout(() => deadSessions.delete(id), 60_000)
}

/**
 * Same race as deadSessions, for resume-lost: the resume proc can fail before
 * the renderer has subscribed to agent:resume-lost:<id>, dropping the event — so
 * the chat silently continues context-blind with no recap and no notice. Record
 * it so the renderer can ask, exactly like it already asks agent:died.
 */
const resumeLostSessions = new Set<string>()

function markResumeLost(id: string): void {
  resumeLostSessions.add(id)
  setTimeout(() => resumeLostSessions.delete(id), 60_000)
}

/** Renderers we've already wired the teardown handlers onto. */
const watchedOwners = new WeakSet<WebContents>()

function watchOwner(owner: WebContents): void {
  if (watchedOwners.has(owner)) return
  watchedOwners.add(owner)
  // A reload or a navigation away replaces the page that owned these sessions.
  // Same-document navigations (hash changes) keep the page, so they're excluded.
  owner.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) killSessionsOwnedBy(owner)
  })
  owner.on('render-process-gone', () => killSessionsOwnedBy(owner))
  owner.on('destroyed', () => killSessionsOwnedBy(owner))
}

/**
 * Chats whose agent has no memory of what is on screen.
 *
 * A conversation resumes by session id, and Claude comes back with the whole
 * thing. When that session is gone — cleaned up, reinstalled — the fallback is
 * a fresh one, which is better than a dead chat but remembers nothing, while
 * the transcript above it still shows everything. The next message out carries
 * a recap so the reply is not "I don't have prior context".
 *
 * This used to live in the window, which meant a message sent from the phone —
 * companion RPC → main → agent, never through the window — arrived with no
 * history at all. It lives here now, on the one path both clients take.
 */
const contextLost = new Set<string>()

export function markContextLost(chatId: string): void {
  contextLost.add(chatId)
}

/**
 * A compact recap of the conversation so far, to re-seed a session that lost
 * its memory. Recent turns only, each clipped — enough for "continue" to mean
 * something without blowing the context window.
 */
/**
 * The recap to put in front of the next message, if this chat's agent has lost
 * its memory — and only in front of ONE message, so the conversation is not
 * re-sent on every turn. Empty when there is nothing to catch up on.
 */
export function takeRecap(chatId: string | undefined): string {
  if (!chatId || !contextLost.delete(chatId)) return ''
  const recap = buildRecap(chatId)
  if (!recap) return ''
  return (
    '[The earlier session for this conversation was lost, so you have no memory of ' +
    'it. Here is a recap of what was said before — treat it as the conversation so ' +
    'far and continue from it.]\n\n' +
    recap +
    '\n\n---\n\n'
  )
}

export function buildRecap(chatId: string): string {
  // Name the speaker as whichever agent actually said it, so a recap handed to a
  // new backend reads as a transcript rather than as a claim about who it is.
  const label = PROVIDER_LABEL[safeChatProvider(chatId)]
  let items: LegacyItem[] = []
  try {
    items = loadChatItems(chatId) as LegacyItem[]
  } catch {
    return ''
  }
  const lines: string[] = []
  for (const it of items) {
    if (it.kind !== 'msg') continue
    const m = it.msg
    if (m.system || !m.text || !m.text.trim()) continue
    lines.push(
      `${m.role === 'user' ? 'User' : label}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 700)}`
    )
  }
  if (lines.length === 0) return ''
  return lines.slice(-24).join('\n')
}

/** The chat's recorded backend, tolerating a chat row that isn't there yet. */
function safeChatProvider(chatId: string): AgentProvider {
  try {
    return getChatProvider(chatId)
  } catch {
    return DEFAULT_PROVIDER
  }
}

export function startAgent(owner: WebContents | null, opts: AgentStartOptions): string {
  if (owner) watchOwner(owner)
  const id = randomUUID()
  const meta = { id, chatId: opts.chatId, workspaceId: opts.workspaceId }
  // A project folder that has been moved or deleted fails as a spawn ENOENT
  // naming the *binary*, which reads as "Claude Code is broken" when it isn't.
  // Catch it here so the chat can say what actually happened.
  if (opts.cwd && !existsSync(opts.cwd)) {
    markDead(id, 1, 'missing-cwd')
    setTimeout(() => {
      agentBus.emit('exit', { ...meta, code: 1 })
      if (owner && !owner.isDestroyed()) owner.send(`agent:exit:${id}`, 1)
    }, 0)
    return id
  }
  const mcpConfig =
    opts.mcpConfigPath ||
    (opts.workspaceId ? writeWorkspaceMcpConfig(opts.workspaceId, opts.chatId) : undefined)

  // No session to resume, but this chat already has a reply in it: this process
  // starts blank underneath an existing conversation. That is the silent
  // context loss — nothing failed, so nothing said so. Gate on an ASSISTANT
  // reply rather than any message: a brand-new chat's first send is already in
  // the transcript by now, so "some message exists" is true on the most common
  // path there is.
  if (!opts.resumeSessionId && opts.chatId) {
    const items = (() => {
      try {
        return loadChatItems(opts.chatId) as LegacyItem[]
      } catch {
        return [] as LegacyItem[]
      }
    })()
    if (items.some((it) => it.kind === 'msg' && it.msg.role === 'assistant' && !it.msg.system)) {
      markContextLost(opts.chatId)
    }
  }

  const provider = opts.provider ?? (opts.chatId ? safeChatProvider(opts.chatId) : DEFAULT_PROVIDER)

  const host: SessionHost = {
    ready(backend) {
      const existing = sessions.get(id)
      // A backend that retried (resume → fresh) hands back a second one; the
      // session is the same conversation, so it adopts it rather than doubling.
      if (existing) {
        existing.backend = backend
        return
      }
      sessions.set(id, {
        id,
        backend,
        owner,
        chatId: opts.chatId,
        workspaceId: opts.workspaceId,
        opts
      })
      agentBus.emit('started', meta)
    },
    event(event) {
      const session = sessions.get(id)
      if (event?.type === 'system' && event?.subtype === 'init') {
        if (session) session.lastInit = event
        // Stamp the backend onto the chat alongside the session id it just
        // issued: a Codex thread id resumed with `claude --resume` finds
        // nothing, and the conversation silently starts over.
        const sid = event.session_id
        if (opts.chatId && typeof sid === 'string' && sid) {
          try {
            setChatSession(opts.chatId, sid, provider)
          } catch {
            // A chat row that no longer exists is not worth failing a turn over.
          }
        }
      }
      agentBus.emit('event', { ...meta, event })
      const o = session?.owner
      if (o && !o.isDestroyed()) o.send(`agent:event:${id}`, event)
    },
    stderr(text) {
      agentBus.emit('stderr', { ...meta, text })
      const o = sessions.get(id)?.owner
      if (o && !o.isDestroyed()) o.send(`agent:stderr:${id}`, text)
    },
    exit(code, reason) {
      const session = sessions.get(id)
      sessions.delete(id)
      if (session?.killed) return
      markDead(id, code, reason)
      agentBus.emit('exit', { ...meta, code })
      const o = session?.owner ?? owner
      if (o && !o.isDestroyed()) o.send(`agent:exit:${id}`, code)
    },
    resumeLost() {
      notifyResumeLost(sessions.get(id)?.owner ?? owner, meta)
    }
  }

  const ctx: SessionContext = { mcpConfigPath: mcpConfig }
  // The one place the two backends meet. Below this line nothing is shared:
  // each starter owns its own process, its own wire format and its own retry.
  if (provider === 'codex') startCodexSession(opts, ctx, host)
  else startClaudeSession(opts, ctx, host)
  return id
}

/**
 * Put a pasted image on disk and hand back the path.
 *
 * The image also travels inline, which is the fast path and normally all that
 * is needed. But an inline image is attached to one message: if that message
 * arrives mid-turn, or the session is later resumed, the agent can end up
 * unable to see the picture the user is plainly talking about — it went
 * looking for "wherever the app saved it" and there was nothing there. Now
 * there is, and the path travels as text, which nothing drops.
 */
function saveImageForAgent(im: AgentImage): string | null {
  try {
    const dir = join(os.tmpdir(), 'superagent-pasted')
    mkdirSync(dir, { recursive: true })
    const ext = (im.mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    const file = join(dir, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`)
    writeFileSync(file, Buffer.from(im.data, 'base64'))
    return file
  } catch {
    return null
  }
}

/**
 * Say when a conversation could not be resumed.
 *
 * Falling back to a fresh session is the right move — better than a dead chat —
 * but it happened silently, so the window went on showing a conversation the
 * model behind it no longer had any of. The one case where "does it still
 * remember?" has a surprising answer, and nothing said so.
 */
function notifyResumeLost(
  owner: WebContents | null,
  meta: { id: string; chatId?: string; workspaceId?: string }
): void {
  markResumeLost(meta.id)
  if (meta.chatId) markContextLost(meta.chatId)
  agentBus.emit('resume-lost', meta)
  if (owner && !owner.isDestroyed()) owner.send(`agent:resume-lost:${meta.id}`)
}

/**
 * The quote a reply carries, as the agent is told about it.
 *
 * Built here rather than by each caller, so the desktop and the phone say the
 * same thing to the agent and both record the same clean text beside it. The
 * blockquote is for the agent; devices draw the quote from `replyTo` on the
 * event, which is why this never goes into the transcript.
 */
export function replyPrefix(reply: { role: 'user' | 'assistant'; text: string }): string {
  const quoted = reply.text.replace(/\s+/g, ' ').trim().slice(0, 400)
  return `> Replying to ${reply.role === 'user' ? 'my' : 'your'} earlier message:\n> "${quoted}"\n\n`
}

export function sendToAgent(
  id: string,
  text: string,
  images: AgentImage[] = [],
  origin: {
    from: 'desktop' | 'ios'
    localId?: string
    /** WhatsApp-style quote. The agent gets a blockquote; the log gets this. */
    replyTo?: { role: 'user' | 'assistant'; text: string }
  } = { from: 'desktop' }
): boolean {
  const session = sessions.get(id)
  if (!session || !session.backend.writable) return false
  // Announce before writing, so the log has the prompt ahead of any reply.
  agentBus.emit('user', {
    id,
    chatId: session.chatId,
    workspaceId: session.workspaceId,
    text,
    images: images.map((im) => ({ mediaType: im.mediaType, size: im.data.length })),
    // The bytes ride along to the listener only so it can keep a thumbnail
    // under the id it is about to mint. They do not go into the log.
    raw: images,
    from: origin.from,
    localId: origin.localId,
    replyTo: origin.replyTo
  })
  // A prompt from the phone also has to reach the window showing this chat.
  if (origin.from !== 'desktop') {
    const o = session.owner
    if (o && !o.isDestroyed()) o.send(`agent:user:${id}`, { text, from: origin.from })
  }
  // The agent behind this chat has no memory of what is on screen. Hand it the
  // conversation, once, ahead of the message. The `user` event above already
  // carries your words alone, so the recap goes to the agent and not into the
  // transcript.
  // The quote goes to the agent only. `text` above — the words in the log and
  // on every screen — is what the person typed and nothing else.
  if (origin.replyTo) text = replyPrefix(origin.replyTo) + text
  text = takeRecap(session.chatId) + text
  let paths: string[] = []
  if (images.length > 0) {
    paths = images.map((im) => saveImageForAgent(im)).filter((p): p is string => !!p)
    if (paths.length > 0) {
      const many = paths.length > 1
      // The inline image below is the fast path, but it does NOT survive a
      // mid-turn message or a resumed session (see saveImageForAgent) — which is
      // when the model would otherwise say "the image didn't come through". So
      // the saved copy is authoritative: instruct a Read, not a maybe-read.
      text =
        `${text}${text ? '\n\n' : ''}[The user attached ${many ? 'images' : 'an image'}, ` +
        `saved to disk. If you cannot see ${many ? 'them' : 'it'} inline, Read ${many ? 'these paths' : 'this path'} ` +
        `now to see what the user is referring to — do not say the image didn't come through:\n${paths.join('\n')}]`
    }
  }
  return session.backend.send(text, images, paths)
}

/** Interrupt the current generation without ending the session (keeps context). */
export function interruptAgent(id: string): void {
  sessions.get(id)?.backend.interrupt()
}

/**
 * Interrupt that works even mid-tool-call, so a mid-turn message is never left
 * waiting on a step that will not finish for another quarter of an hour.
 */
export async function hardInterruptAgent(id: string): Promise<boolean> {
  const session = sessions.get(id)
  if (!session) return true
  session.killed = true // a deliberate interrupt is not a crash
  const ended = await session.backend.hardInterrupt()
  if (ended) sessions.delete(id)
  return ended
}

export function stopAgent(id: string): void {
  const session = sessions.get(id)
  if (session) {
    session.killed = true // don't trigger the resume→fresh fallback on a deliberate stop
    sessions.delete(id)
    session.backend.kill()
  }
}

export function killAllAgents(): void {
  for (const id of [...sessions.keys()]) stopAgent(id)
}

/**
 * Names a conversation the way its own agent would describe it, via a throwaway
 * one-shot run of that chat's own CLI. Deliberately separate from the chat's
 * session so the request never lands in the transcript, and a failure is silent:
 * the caller keeps its fallback title.
 */
export function suggestTitle(
  cwd: string,
  excerpt: string,
  provider: AgentProvider = DEFAULT_PROVIDER
): Promise<string | null> {
  return provider === 'codex'
    ? suggestTitleWithCodex(cwd, excerpt)
    : suggestTitleWithClaude(cwd, excerpt)
}

/**
 * A one-shot title is text in, text out — so it never needs the app server. The
 * simpler `codex exec` is the right tool for it, and for routines.
 */

export function registerAgentIpc(): void {
  ipcMain.handle(
    'agent:suggestTitle',
    (_e, cwd: string, excerpt: string, provider?: AgentProvider) =>
      suggestTitle(cwd, excerpt, provider ?? DEFAULT_PROVIDER)
  )
  ipcMain.handle('agent:start', (e, opts: AgentStartOptions) => {
    // The phone may already be running this chat's agent. Adopt it rather than
    // spawning a second claude on the same conversation.
    if (opts.chatId) {
      for (const s of sessions.values()) {
        if (s.chatId === opts.chatId && !s.owner) {
          adoptSession(s, e.sender)
          return s.id
        }
      }
    }
    return startAgent(e.sender, opts)
  })
  // Asked once, right after the renderer subscribes: did this session already
  // die in the gap? Returns the exit code, or null if it's alive.
  ipcMain.handle('agent:died', (_e, id: string) => deadSessions.get(id) ?? null)
  // Same catch-up question for a resume that failed before the renderer could
  // subscribe: consume it (delete) so a later re-query doesn't re-fire it.
  ipcMain.handle('agent:resume-lost-check', (_e, id: string) => {
    const lost = resumeLostSessions.has(id)
    resumeLostSessions.delete(id)
    return lost
  })
  ipcMain.on(
    'agent:send',
    (
      _e,
      id: string,
      text: string,
      images?: AgentImage[],
      replyTo?: { role: 'user' | 'assistant'; text: string }
    ) => sendToAgent(id, text, images ?? [], { from: 'desktop', replyTo })
  )
  ipcMain.on('agent:interrupt', (_e, id: string) => interruptAgent(id))
  ipcMain.on('agent:stop', (_e, id: string) => stopAgent(id))
  ipcMain.handle('agent:hard-interrupt', (_e, id: string) => hardInterruptAgent(id))
}
