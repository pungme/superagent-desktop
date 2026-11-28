import type { EventEmitter } from 'events'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { buildManifest, autoTitle, ticketLabel, type ConductorSession } from '../shared/conductor'
import { cachedGit, forgetGit, freshGit, setGitUpdateHandler } from './session-git'
import { MEMORY_KINDS, forget, memoryIndex, recall, remember } from './conductor-store'
import {
  closeSession,
  conductorOfMain,
  conductorOfWorker,
  connectChat,
  findSession,
  listSessions,
  listUnlinked,
  reopenSession,
  setSummary,
  type ConductorInfo
} from './conductor-store'
import {
  createChat,
  getChat,
  getDb,
  getWorkspace,
  lastChatPreview,
  listChatEvents,
  tailChatEvents,
  openCards,
  markPendingBranch,
  setChatTitle
} from './store'
import { broadcastToWindows } from './util'
import { conductorPrompt } from '../shared/conductor'
import { setConductorProbe } from './prompts'

/**
 * Whether a chat's agent is working. Handed in by index.ts rather than imported: the event log
 * reaches the agents, which reach this module through the MCP server, and the cycle broke start-up.
 */
let isGenerating: (chatId: string) => boolean = () => false
export function setGeneratingProbe(fn: (chatId: string) => boolean): void {
  isGenerating = fn
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
const said = (text: string, isError = false): Result => ({
  ...(isError ? { isError } : {}),
  content: [{ type: 'text', text }]
})

/** Chats waiting on a yes or no from the person (an approval is open). */
const needsYou = new Set<string>()
const approvalChat = new Map<string, string>()
/** Each open approval of a session: what it asks. The latest of a chat is the one shown. */
const approvalInfo = new Map<string, { chatId: string; preview: string }>()

/** The first sentence of a reply, without Markdown, as the one-line summary. */
export function summaryOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const first = /^.{20,}?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain
  return first.length > 200 ? first.slice(0, 197).trimEnd() + '…' : first
}

/**
 * Keep the panel's picture current without a word from the workers to Main: a worker that
 * finishes a turn leaves a one-line summary, and one that is waiting on an approval shows as
 * "Needs you". The emitters are handed in (index.ts), not imported: see setGeneratingProbe.
 */
export function watchConductor(logBus: EventEmitter, hookBus: EventEmitter): void {
  const lastReply = new Map<string, string>()
  const touch = (chatId: string): void => {
    const c = conductorOfWorker(getDb(), chatId)
    if (c) broadcastToWindows('conductor:changed', { workspaceId: c.workspaceId })
  }
  logBus.on('event', (({
    event
  }: {
    event: { chatId: string; data: { kind: string; text?: string } }
  }) => {
    const { chatId, data } = event
    if (data.kind === 'assistant' && data.text) lastReply.set(chatId, data.text)
    if (data.kind === 'turn_end') {
      const text = lastReply.get(chatId)
      lastReply.delete(chatId)
      try {
        if (text && conductorOfWorker(getDb(), chatId)) {
          setSummary(getDb(), chatId, summaryOf(text))
          recordSession(chatId)
        }
        touch(chatId)
      } catch {
        // the store is gone (quitting)
      }
    }
  }) as never)
  hookBus.on('approval', (({
    requestId,
    sessionId,
    preview
  }: {
    requestId: string
    sessionId: string
    preview?: string
  }) => {
    approvalChat.set(requestId, sessionId)
    approvalInfo.set(requestId, { chatId: sessionId, preview: String(preview ?? '').slice(0, 400) })
    needsYou.add(sessionId)
    touch(sessionId)
  }) as never)
  hookBus.on('approval-end', (({ requestId }: { requestId: string }) => {
    const chat = approvalChat.get(requestId)
    approvalChat.delete(requestId)
    approvalInfo.delete(requestId)
    if (!chat) return
    if (![...approvalChat.values()].includes(chat)) needsYou.delete(chat)
    touch(chat)
  }) as never)
}

function openApproval(chatId: string): { requestId: string; preview: string } | undefined {
  let found: { requestId: string; preview: string } | undefined
  for (const [requestId, a] of approvalInfo)
    if (a.chatId === chatId) found = { requestId, preview: a.preview }
  return found
}

const countCache = new Map<string, { at: number; n: number }>()
/** Messages in a conversation (the person's and the agent's), counted at most every 10 s. */
function messageCount(chatId: string): number {
  const hit = countCache.get(chatId)
  if (hit && Date.now() - hit.at < 10_000) return hit.n
  try {
    const r = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_events WHERE chatId = ? AND kind IN ('user', 'assistant')"
      )
      .get(chatId) as { n: number }
    countCache.set(chatId, { at: Date.now(), n: r.n })
    return r.n
  } catch {
    return 0
  }
}

/** Like sessionsOf, but waits for git to answer for every session first: for what an agent asks. */
export async function sessionsOfFresh(
  info: ConductorInfo,
  includeClosed = false
): Promise<ConductorSession[]> {
  const rows = listSessions(getDb(), info.workspaceId, { includeClosed })
  await Promise.all(
    rows.flatMap((r) => {
      const cwd = getChat(r.chatId)?.cwd
      return cwd ? [freshGit(cwd)] : []
    })
  )
  return sessionsOf(info, includeClosed)
}

/** A session's last message, read at most every 30 s: the list is asked for every few seconds and
 *  a chat's events table can be large. */
const previews = new Map<string, { at: number; text: string | undefined }>()
function previewOf(chatId: string): string | undefined {
  const hit = previews.get(chatId)
  const now = Date.now()
  if (hit && now - hit.at < 30_000) return hit.text
  const text = lastChatPreview(chatId) ?? undefined
  previews.set(chatId, { at: now, text })
  return text
}

/** The project's sessions as the Conductor sees them (title, ticket, status, branch, summary). */
export function sessionsOf(info: ConductorInfo, includeClosed = false): ConductorSession[] {
  const db = getDb()
  return listSessions(db, info.workspaceId, { includeClosed }).map((r) => {
    const cwd = getChat(r.chatId)?.cwd ?? null
    // A session that is not at work changes slowly: look at it less often.
    const git = cachedGit(
      cwd,
      r.closedAt != null ? 60_000 : isGenerating(r.chatId) ? 5_000 : 20_000
    )
    return {
      chatId: r.chatId,
      title: r.title,
      ticket: r.ticket,
      summary: r.summary,
      // Sessions from before summaries were kept still say something: their last message.
      preview: r.summary ? undefined : previewOf(r.chatId),
      approval: openApproval(r.chatId),
      status:
        r.closedAt != null
          ? 'closed'
          : needsYou.has(r.chatId)
            ? 'needs-you'
            : isGenerating(r.chatId)
              ? 'working'
              : 'idle',
      updatedAt: r.updatedAt,
      // From the cache, at once; a read in the background tells the windows when it finds more.
      branch: git.branch,
      unmerged: git.unmerged,
      files: git.files,
      messages: messageCount(r.chatId)
    }
  })
}

/** The compact picture of a project's sessions, for the Conductor's briefing. */
export function manifestFor(info: ConductorInfo): string {
  const ws = getWorkspace(info.workspaceId)
  return buildManifest({
    project: ws?.name ?? 'this project',
    routing: info.routing,
    sessions: sessionsOf(info),
    unlinked: listUnlinked(getDb(), info.workspaceId)
  })
}

function openCardsFor(workspaceId: string): string[] {
  return openCards()
    .filter((c) => c.workspaceId === workspaceId)
    .map((c) => c.title)
}

/**
 * Superagent's own record of a session, kept in Main's memory whatever the model does: its task,
 * branch, the files it changed and where it stands. Updated on every turn it finishes, so "what was
 * #3 doing / where is the campaign code" can be answered from saved facts, not from recollection.
 */
/** One record per session, under a key that survives renaming it. */
function sessionKey(chatId: string): string {
  return `session ${chatId.slice(0, 8)}`
}

/** What was first asked in a chat: the task of a session that was connected rather than started. */
function firstAsk(chatId: string): string | null {
  for (const e of listChatEvents(chatId, 0, 200)) {
    try {
      const d = JSON.parse(e.data) as { kind?: string; text?: string }
      if (d.kind === 'user' && d.text?.trim()) return d.text.trim()
    } catch {
      // skip
    }
  }
  return null
}

/** Every session of a project has a record in Main's memory; the ones that lack one get it now. */
export function backfillSessionRecords(workspaceId: string): number {
  const have = new Set(
    recall(getDb(), workspaceId, { kind: 'history', limit: 1000 }).map((r) => r.key)
  )
  let n = 0
  for (const r of listSessions(getDb(), workspaceId, { includeClosed: true })) {
    const chat = getChat(r.chatId)
    if (!chat || have.has(sessionKey(r.chatId))) continue
    recordSession(r.chatId)
    n++
  }
  return n
}

export function recordSession(chatId: string, extra: { task?: string } = {}): void {
  const info = conductorOfWorker(getDb(), chatId)
  const chat = getChat(chatId)
  if (!info || !chat) return
  const key = sessionKey(chatId)
  const before = recall(getDb(), info.workspaceId, { limit: 500 }).find((r) => r.key === key)
  const task = extra.task ?? before?.text.match(/^Task: (.*)$/m)?.[1] ?? firstAsk(chatId) ?? ''
  const row = listSessions(getDb(), info.workspaceId, { includeClosed: true }).find(
    (r) => r.chatId === chatId
  )
  const cwd = chat.cwd ?? null
  const facts = cachedGit(cwd, 30_000)
  const files = facts.files
  const lines = [
    `Title: ${chat.title || 'Untitled'}`,
    task ? `Task: ${task.replace(/\s+/g, ' ').slice(0, 600)}` : '',
    facts.branch ? `Branch: ${facts.branch}` : '',
    files?.length ? `Files: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ' …' : ''}` : '',
    row?.summary ? `Latest: ${row.summary}` : ''
  ].filter(Boolean)
  // Always a record, even for a chat with nothing in it yet: Main knows the session exists.
  if (lines.length === 1) lines.push('No work in it yet.')
  remember(getDb(), info.workspaceId, key, 'history', lines.join('\n'))
}

/**
 * What goes in front of each message to Main, for its agent only (never the transcript): the
 * session list as it is now, the project's git state and open to-dos, and the index of what it
 * has saved. So Main never works from a stale picture, and its own memory survives compaction.
 */
export function conductorTurnPrefix(chatId: string, message = ''): string {
  const info = conductorOfMain(getDb(), chatId)
  if (!info) return ''
  const ws = getWorkspace(info.workspaceId)
  // Sessions connected from existing chats have no record yet: give each one before Main reads.
  try {
    backfillSessionRecords(info.workspaceId)
  } catch {
    // memory is a help, never a blocker
  }
  const parts = [manifestFor(info)]
  if (ws?.path) {
    // From the cache: this runs in front of every message, and git must never hold one up.
    const g = cachedGit(ws.path, 15_000)
    if (g.branch)
      parts.push(
        `Project git: ${g.branch}${g.files?.length ? `, ${g.files.length} file(s) changed against main` : ', nothing changed against main'}.`
      )
  }
  try {
    const todos = openCardsFor(info.workspaceId)
    if (todos.length)
      parts.push(
        `Open to-dos (${todos.length}): ${todos.slice(0, 6).join('; ')}${todos.length > 6 ? ' …' : ''}`
      )
  } catch {
    // no board
  }
  // Recall done for it: the saved entries that match what the person just wrote, in full.
  const relevant = message.trim()
    ? recall(getDb(), info.workspaceId, { query: message, limit: 5 })
    : []
  if (relevant.length)
    parts.push(
      `From your saved memory, matching this message:\n${relevant
        .map((r) => `[${r.kind}] ${r.key}\n${r.text.slice(0, 1200)}`)
        .join('\n\n')}`
    )
  const mem = memoryIndex(getDb(), info.workspaceId)
  parts.push(
    mem
      ? `Your saved memory (conductor_recall reads an entry in full):\n${mem}`
      : 'Your saved memory is empty. Save decisions, facts, preferences and data structures with conductor_remember.'
  )
  return `[Conductor state, as of this message]\n${parts.join('\n')}\n[End of Conductor state]\n\n`
}

/** manifestFor, after git has answered for every session (what an agent's tool call gets). */
export async function manifestForFresh(info: ConductorInfo): Promise<string> {
  const ws = getWorkspace(info.workspaceId)
  return buildManifest({
    project: ws?.name ?? 'this project',
    routing: info.routing,
    sessions: await sessionsOfFresh(info),
    unlinked: listUnlinked(getDb(), info.workspaceId)
  })
}

/** A readable digest of the end of a worker's conversation. */
function digest(chatId: string, turns: number): string {
  const tail = tailChatEvents(chatId, Math.max(20, turns * 12))
  const lines: string[] = []
  for (const e of tail) {
    let d: {
      kind?: string
      text?: string
      name?: string
      detail?: string
      ok?: boolean
      summary?: string
    }
    try {
      d = JSON.parse(e.data)
    } catch {
      continue
    }
    if (d.kind === 'user') lines.push(`USER: ${(d.text ?? '').slice(0, 500)}`)
    else if (d.kind === 'assistant') lines.push(`AGENT: ${(d.text ?? '').slice(0, 900)}`)
    else if (d.kind === 'tool')
      lines.push(`  · ${d.name ?? 'tool'} ${(d.detail ?? '').slice(0, 100)}`)
    else if (d.kind === 'tool_result' && d.ok === false)
      lines.push(`  ✗ failed: ${(d.summary ?? '').slice(0, 200)}`)
  }
  return lines.join('\n').slice(-6000) || 'Nothing in that conversation yet.'
}

/**
 * The Conductor's tools: only for the Main chat of a project (a project's other chats and every
 * other conversation never see them), and only for that project's own sessions. Starting and
 * messaging the project's own workers is the Conductor's job, so no permission dialog each time.
 */
export function registerConductorTools(server: McpServer, ctx: { chatId: string | null }): void {
  if (!ctx.chatId) return
  const info = conductorOfMain(getDb(), ctx.chatId)
  if (!info) return
  // Read again at each call: the routing mode and the numbering change while this runs.
  const now = (): ConductorInfo => conductorOfMain(getDb(), ctx.chatId!) ?? info
  const ws = info.workspaceId
  // The Sessions tab and the sidebar both follow a change made by Main's own tools.
  const refresh = (): void => {
    broadcastToWindows('conductor:changed', { workspaceId: ws })
    broadcastToWindows('projects:changed', {})
  }

  const sessionRef = {
    ticket: z.number().int().optional().describe('The session number, like 101 for #101'),
    chatId: z.string().max(100).optional().describe('The session’s chat id, instead of its number')
  }
  const find = (ref: { ticket?: number; chatId?: string }): ReturnType<typeof findSession> =>
    findSession(getDb(), ws, ref)
  const notFound = (): Result =>
    said(
      'No session of this project has that number or id. conductor_list_sessions shows them.',
      true
    )

  server.registerTool(
    'conductor_list_sessions',
    {
      description:
        "This project's sessions: number, title, status (Working / Idle / Closed), branch, unmerged commits, the files it changed (an Overlap line when two sessions touch the same file), and a one-line summary of where each stands, plus chats not connected to Main. Call it at the start of a turn when you need to know where things stand.",
      inputSchema: { includeClosed: z.boolean().optional() }
    },
    async ({ includeClosed }) => {
      const c = now()
      if (!includeClosed) return said(await manifestForFresh(c))
      const s = await sessionsOfFresh(c, true)
      return said(
        s
          .map(
            (x) =>
              `${x.ticket != null ? ticketLabel(x.ticket) : '—'} · ${x.title || 'Untitled'} · ${x.status}${x.branch ? ` · ${x.branch}` : ''}${x.summary ? ` · ${x.summary}` : ''}`
          )
          .join('\n') || 'No sessions yet.'
      )
    }
  )

  server.registerTool(
    'conductor_spawn_session',
    {
      description:
        'Start a worker session in this project on its own branch and give it its first message. It gets the next number (#101…) and the title you give it: 3 to 6 words naming the work, with a tracker id in front if the person gave one ("WD-284 Fix header wrap"); without one it is cut from the task. Use it for work: editing, building, investigating. Returns the number and chat id.',
      inputSchema: {
        task: z
          .string()
          .min(1)
          .max(8000)
          .describe('The first message the worker receives: the whole brief'),
        title: z
          .string()
          .max(80)
          .optional()
          .describe('3 to 6 words naming the work, e.g. "Pricing page redesign"')
      }
    },
    async ({ task, title }) => {
      const c = now()
      if (!getWorkspace(c.workspaceId)) return said('That project is gone.', true)
      const chatId = createChat(c.workspaceId)
      markPendingBranch(chatId)
      setChatTitle(chatId, (title ?? '').trim() || autoTitle(task))
      const ticket = connectChat(getDb(), c.workspaceId, chatId)
      recordSession(chatId, { task })
      refresh()
      const { askFromDot } = await import('./companion/rpc')
      const sent = await askFromDot(chatId, task)
      if (!sent.ok)
        return said(
          `Session ${ticket != null ? ticketLabel(ticket) : ''} was created (id ${chatId}) but the brief was not sent: ${sent.error}`,
          true
        )
      return said(
        `Started ${ticket != null ? ticketLabel(ticket) : 'a session'} (id ${chatId}). Its agent is on it.`
      )
    }
  )

  server.registerTool(
    'conductor_send_to_session',
    {
      description:
        "Send a follow-up or an instruction to one of this project's sessions, as the person would type it there. Say which session you sent it to when you answer.",
      inputSchema: { ...sessionRef, text: z.string().min(1).max(8000) }
    },
    async ({ ticket, chatId, text }) => {
      const s = find({ ticket, chatId })
      if (!s || s.closedAt != null) return notFound()
      const { askFromDot } = await import('./companion/rpc')
      const sent = await askFromDot(s.chatId, text)
      return sent.ok
        ? said(`Sent to ${s.ticket != null ? ticketLabel(s.ticket) : s.title}.`)
        : said(`Not sent: ${sent.error}`, true)
    }
  )

  server.registerTool(
    'conductor_inspect_session',
    {
      description:
        "Read the end of one session's conversation (what was asked, what the agent answered, which tools failed) so you can answer about it without holding it in this chat.",
      inputSchema: { ...sessionRef, turns: z.number().int().min(1).max(20).optional() }
    },
    async ({ ticket, chatId, turns }) => {
      const s = find({ ticket, chatId })
      if (!s) return notFound()
      return said(
        `${s.ticket != null ? ticketLabel(s.ticket) : ''} ${s.title}\n\n${digest(s.chatId, turns ?? 6)}`
      )
    }
  )

  server.registerTool(
    'conductor_adopt_session',
    {
      description:
        "Connect an existing chat of this project (one conductor_list_sessions lists under 'not connected') to Main, giving it a number. A chat that was connected before gets its old number back.",
      inputSchema: { chatId: z.string().min(1).max(100) }
    },
    async ({ chatId }) => {
      const t = connectChat(getDb(), ws, chatId)
      recordSession(chatId)
      if (t == null) return said('That chat is not in this project, or cannot be connected.', true)
      refresh()
      return said(`Connected as ${ticketLabel(t)}.`)
    }
  )

  server.registerTool(
    'conductor_close_session',
    {
      description:
        "Close a session. If its branch has commits not in the project's main branch, nothing is closed until you pass `how`: 'merge' (land them, then close), 'keep' (close, leave the branch as it is), or 'discard' (throw its changes away: only when the person said so). Ask the person which first. Stops its agent if it is working.",
      inputSchema: { ...sessionRef, how: z.enum(['merge', 'keep', 'discard']).optional() }
    },
    async ({ ticket, chatId, how }) => {
      const s = find({ ticket, chatId })
      if (!s) return notFound()
      const chat = getChat(s.chatId)
      const unmerged = chat?.cwd ? ((await freshGit(chat.cwd)).unmerged ?? 0) : 0
      if (unmerged && !how)
        return said(
          `${s.ticket != null ? ticketLabel(s.ticket) : s.title} has ${unmerged} commit(s) not in the main branch. Ask the person: merge them and close, or close and keep the branch. Then call this again with how.`,
          true
        )
      if (how === 'merge' && chat?.cwd) {
        const wsRow = getWorkspace(ws)
        if (!wsRow) return said('That project is gone.', true)
        const { mergeCopy } = await import('./chat-copy')
        const r = await mergeCopy(wsRow.path, chat.cwd, s.title || 'Conductor session')
        if (!r.ok && r.reason !== 'nothing')
          return said(`Could not merge it (${r.reason}). Nothing was closed.`, true)
        forgetGit(chat.cwd)
      }
      if (isGenerating(s.chatId)) {
        const { stopFromDot } = await import('./companion/rpc')
        await stopFromDot(s.chatId)
      }
      if (how === 'discard' && chat?.cwd) {
        const wsRow = getWorkspace(ws)
        if (wsRow) {
          const { removeCopy } = await import('./chat-copy')
          await removeCopy(wsRow.path, chat.cwd)
        }
      }
      closeSession(getDb(), s.chatId)
      // What it did stays known after it is gone from the list: its record, plus how it ended.
      recordSession(s.chatId)
      const prev = recall(getDb(), ws, { kind: 'history', limit: 1000 }).find(
        (r) => r.key === sessionKey(s.chatId)
      )
      remember(
        getDb(),
        ws,
        sessionKey(s.chatId),
        'history',
        `${prev?.text ?? `Title: ${s.title}`}\nStatus: ${how === 'merge' ? 'merged and closed' : how === 'discard' ? 'discarded and closed' : 'closed'} on ${new Date().toISOString().slice(0, 10)}`
      )
      refresh()
      return said(`Closed ${s.ticket != null ? ticketLabel(s.ticket) : s.title}.`)
    }
  )

  server.registerTool(
    'conductor_remember',
    {
      description:
        "Save something to this project's memory so you still know it in later turns, after this conversation is compacted, and after a restart: decisions the person made, facts about the project, their preferences, data structures and schemas (with field names), where things live, and plans. One entry per key; saving the same key again updates it. Keep each entry short and precise.",
      inputSchema: {
        key: z.string().min(1).max(120),
        kind: z.enum(MEMORY_KINDS),
        text: z.string().min(1).max(8000)
      }
    },
    async ({ key, kind, text }) => {
      remember(getDb(), ws, key, kind, text)
      return said(`Remembered "${key}".`)
    }
  )

  server.registerTool(
    'conductor_recall',
    {
      description:
        "Look up what you saved in this project's memory: by words (any of them, in the key or the text) and/or by kind. The index of keys is in every message's Conductor state; recall reads the full text.",
      inputSchema: {
        query: z.string().max(400).optional(),
        kind: z.enum(MEMORY_KINDS).optional()
      }
    },
    async ({ query, kind }) => {
      const hits = recall(getDb(), ws, { query, kind })
      return said(
        hits.length
          ? hits.map((h) => `[${h.kind}] ${h.key}\n${h.text}`).join('\n\n')
          : 'Nothing saved matches that.'
      )
    }
  )

  server.registerTool(
    'conductor_forget',
    {
      description:
        "Remove an entry from this project's memory, when it is wrong or no longer true.",
      inputSchema: { key: z.string().min(1).max(120) }
    },
    async ({ key }) =>
      said(forget(getDb(), ws, key) ? `Forgot "${key}".` : `Nothing saved under "${key}".`)
  )

  server.registerTool(
    'conductor_merge_session',
    {
      description:
        "Merge a session's commits into the project's main branch and keep the session open. Only after the person agreed. Refuses while the session is working.",
      inputSchema: sessionRef
    },
    async ({ ticket, chatId }) => {
      const s = find({ ticket, chatId })
      if (!s) return notFound()
      const label = s.ticket != null ? ticketLabel(s.ticket) : s.title
      if (isGenerating(s.chatId))
        return said(`${label} is still working. Merge when it is done.`, true)
      const chat = getChat(s.chatId)
      if (!chat?.cwd || !((await freshGit(chat.cwd)).unmerged ?? 0))
        return said(`${label} has nothing to merge.`)
      const wsRow = getWorkspace(ws)
      if (!wsRow) return said('That project is gone.', true)
      const { mergeCopy } = await import('./chat-copy')
      const r = await mergeCopy(wsRow.path, chat.cwd, s.title || 'Conductor session')
      if (!r.ok && r.reason !== 'nothing')
        return said(`Could not merge ${label} (${r.reason}).`, true)
      refresh()
      return said(`Merged ${label} into the main branch. The session stays open.`)
    }
  )

  server.registerTool(
    'conductor_reopen_session',
    {
      description: 'Bring a closed session back among the active ones.',
      inputSchema: sessionRef
    },
    async ({ ticket, chatId }) => {
      const s = find({ ticket, chatId })
      if (!s) return notFound()
      reopenSession(getDb(), s.chatId)
      refresh()
      return said(`Reopened ${s.ticket != null ? ticketLabel(s.ticket) : s.title}.`)
    }
  )

  server.registerTool(
    'conductor_note_session',
    {
      description:
        'Write the one-line summary shown for a session in the list (where it stands). Use it after a worker reports back.',
      inputSchema: { ...sessionRef, summary: z.string().min(1).max(400) }
    },
    async ({ ticket, chatId, summary }) => {
      const s = find({ ticket, chatId })
      if (!s) return notFound()
      setSummary(getDb(), s.chatId, summary)
      recordSession(s.chatId)
      return said('Noted.')
    }
  )
}

/** What goes in front of a Main chat's agent: its job and the sessions now. */
setConductorProbe((chatId) => {
  if (!chatId) return ''
  try {
    const info = conductorOfMain(getDb(), chatId)
    return info ? `${conductorPrompt(info.routing)}\n\nSessions now:\n${manifestFor(info)}` : ''
  } catch {
    return ''
  }
})

// --- The window's side: what the Conductor panel reads and does ------------------------------

import { ipcMain } from 'electron'
import { disconnectChat, enableConductor, getConductor, setRouting } from './conductor-store'
import type { ConductorRouting } from '../shared/conductor'

export interface ConductorState {
  chatId: string
  routing: ConductorRouting
  sessions: ConductorSession[]
  unlinked: { chatId: string; title: string }[]
}

function stateOf(workspaceId: string): ConductorState | null {
  const info = getConductor(getDb(), workspaceId)
  if (!info) return null
  return {
    chatId: info.chatId,
    routing: info.routing,
    sessions: sessionsOf(info, true),
    unlinked: listUnlinked(getDb(), workspaceId)
  }
}

/** For clients that are not this window (the phone): the same picture the Sessions tab shows. */
export function conductorStateFor(workspaceId: string): ConductorState | null {
  return stateOf(workspaceId)
}

/** Confirm or Auto, from the phone. */
export function setConductorRouting(workspaceId: string, mode: 'auto' | 'confirm'): boolean {
  if (!getConductor(getDb(), workspaceId)) return false
  setRouting(getDb(), workspaceId, mode)
  changed(workspaceId)
  return true
}

/** Start a Conductor in a project from the phone (a clean Main, or connecting its chats). */
export function conductorEnableFor(workspaceId: string, adopt: string[]): ConductorState | null {
  if (!getWorkspace(workspaceId)) return null
  enableConductor(getDb(), workspaceId, {
    adoptChatIds: adopt,
    makeMain: () => createChat(workspaceId)
  })
  backfillSessionRecords(workspaceId)
  changed(workspaceId)
  return stateOf(workspaceId)
}

/** Close, reopen, connect or disconnect a session, from the phone. */
export function conductorSessionAction(
  workspaceId: string,
  chatId: string,
  action: 'close' | 'reopen' | 'connect' | 'disconnect'
): boolean {
  const db = getDb()
  if (!getConductor(db, workspaceId)) return false
  if (action === 'connect') {
    connectChat(db, workspaceId, chatId)
    recordSession(chatId)
  } else {
    if (!conductorOfWorker(db, chatId)) return false
    if (action === 'close') closeSession(db, chatId)
    else if (action === 'reopen') reopenSession(db, chatId)
    else disconnectChat(db, chatId)
  }
  changed(workspaceId)
  return true
}

/** What Main has saved to remember (decisions, structures, plans), for the phone's Memory view. */
export function conductorMemoryFor(workspaceId: string): ReturnType<typeof recall> | null {
  if (!getConductor(getDb(), workspaceId)) return null
  return recall(getDb(), workspaceId, { limit: 200 })
}

/** Forget one saved memory, from the phone. */
export function conductorForgetFor(workspaceId: string, key: string): boolean {
  return getConductor(getDb(), workspaceId) ? forget(getDb(), workspaceId, key) : false
}

/** Merge a session's commits into the project's main branch (the session stays open). */
export async function conductorMergeFor(
  workspaceId: string,
  chatId: string
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  if (!getConductor(db, workspaceId) || !conductorOfWorker(db, chatId))
    return { ok: false, error: 'not a session of this Conductor' }
  if (isGenerating(chatId)) return { ok: false, error: 'it is still working' }
  const chat = getChat(chatId)
  const wsRow = getWorkspace(workspaceId)
  if (!chat?.cwd || !wsRow) return { ok: false, error: 'no folder to merge' }
  if (!((await freshGit(chat.cwd)).unmerged ?? 0)) return { ok: false, error: 'nothing to merge' }
  const { mergeCopy } = await import('./chat-copy')
  const r = await mergeCopy(wsRow.path, chat.cwd, chat.title || 'Conductor session')
  if (!r.ok && r.reason !== 'nothing') return { ok: false, error: String(r.reason) }
  changed(workspaceId)
  return { ok: true }
}

/** A session's latest messages, for the phone's inspector (only sessions of a Conductor). */
export function conductorMessagesFor(chatId: string): InspectMessage[] | null {
  return conductorOfWorker(getDb(), chatId) ? sessionMessages(chatId) : null
}

const changed = (workspaceId: string): void => {
  broadcastToWindows('conductor:changed', { workspaceId })
  broadcastToWindows('projects:changed', {})
}

/** Every project that has a Conductor, with how many of its sessions need you or are working: the
 *  sidebar's Conductor row. No git, so it is cheap enough to ask every few seconds. */
export interface ConductorOverview {
  workspaceId: string
  name: string
  mainChatId: string
  total: number
  needsYou: number
  working: number
}
export function conductorOverview(): ConductorOverview[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, name FROM workspaces WHERE conductorChatId IS NOT NULL')
    .all() as { id: string; name: string }[]
  const out: ConductorOverview[] = []
  for (const w of rows) {
    const info = getConductor(db, w.id)
    if (!info) continue
    const live = listSessions(db, w.id, { includeClosed: false })
    out.push({
      workspaceId: w.id,
      name: w.name,
      mainChatId: info.chatId,
      total: live.length,
      needsYou: live.filter((r) => needsYou.has(r.chatId)).length,
      working: live.filter((r) => !needsYou.has(r.chatId) && isGenerating(r.chatId)).length
    })
  }
  return out
}

/** A session's latest messages for the inspector: what was asked, what the agent said, its tools. */
export interface InspectMessage {
  role: 'user' | 'agent' | 'tool'
  text: string
  failed?: boolean
}
export function sessionMessages(chatId: string, max = 40): InspectMessage[] {
  const out: InspectMessage[] = []
  for (const e of tailChatEvents(chatId, max * 4)) {
    let d: {
      kind?: string
      text?: string
      name?: string
      detail?: string
      ok?: boolean
      summary?: string
    }
    try {
      d = JSON.parse(e.data)
    } catch {
      continue
    }
    if (d.kind === 'user' && d.text) out.push({ role: 'user', text: d.text.slice(0, 4000) })
    else if (d.kind === 'assistant' && d.text)
      out.push({ role: 'agent', text: d.text.slice(0, 8000) })
    else if (d.kind === 'tool')
      out.push({
        role: 'tool',
        text: `${d.name ?? 'tool'} ${(d.detail ?? '').slice(0, 140)}`.trim()
      })
    else if (d.kind === 'tool_result' && d.ok === false)
      out.push({ role: 'tool', text: `failed: ${(d.summary ?? '').slice(0, 200)}`, failed: true })
  }
  return out.slice(-max)
}

export function registerConductorIpc(): void {
  // A background git read that found a session changed: every open Conductor looks again.
  setGitUpdateHandler(() => {
    for (const o of conductorOverview()) changed(o.workspaceId)
  })
  ipcMain.handle('conductor:peek', (_e, chatId: string) => digest(String(chatId), 3))
  ipcMain.handle(
    'conductor:answer',
    async (_e, ws: string, requestId: string, approve: unknown) => {
      // Only an approval that belongs to a session of this project's Conductor.
      const a = approvalInfo.get(String(requestId))
      if (!a || !conductorOfWorker(getDb(), a.chatId)) return false
      const { resolveGate } = await import('./hooks')
      const ok = resolveGate(String(requestId), approve === true, false, 'desktop')
      changed(String(ws))
      return ok
    }
  )
  ipcMain.handle('conductor:get', (_e, ws: string) => stateOf(String(ws)))
  ipcMain.handle('conductor:overview', () => conductorOverview())
  // Which chat is a project's Main (a lookup, no git): what every desk asks.
  ipcMain.handle(
    'conductor:main-id',
    (_e, ws: string) => getConductor(getDb(), String(ws))?.chatId ?? null
  )
  // The inspector: a session's conversation, and a message to it, from the Sessions column.
  ipcMain.handle('conductor:messages', (_e, chatId: string) =>
    conductorOfWorker(getDb(), String(chatId)) ? sessionMessages(String(chatId)) : []
  )
  ipcMain.handle('conductor:send', async (_e, chatId: string, text: string) => {
    if (!conductorOfWorker(getDb(), String(chatId))) return { ok: false, error: 'not a session' }
    const t = String(text ?? '').trim()
    if (!t) return { ok: false, error: 'empty' }
    const { askFromDot } = await import('./companion/rpc')
    return askFromDot(String(chatId), t.slice(0, 20_000))
  })
  ipcMain.handle('conductor:enable', (_e, ws: string, adopt: unknown) => {
    const workspaceId = String(ws)
    if (!getWorkspace(workspaceId)) return null
    enableConductor(getDb(), workspaceId, {
      adoptChatIds: Array.isArray(adopt) ? adopt.map(String) : [],
      makeMain: () => createChat(workspaceId)
    })
    backfillSessionRecords(workspaceId)
    changed(workspaceId)
    return stateOf(workspaceId)
  })
  ipcMain.handle('conductor:set-routing', (_e, ws: string, mode: unknown) => {
    setRouting(getDb(), String(ws), mode === 'auto' ? 'auto' : 'confirm')
    changed(String(ws))
  })
  ipcMain.handle('conductor:connect', (_e, ws: string, chatId: string) => {
    const t = connectChat(getDb(), String(ws), String(chatId))
    recordSession(String(chatId))
    changed(String(ws))
    return t
  })
  ipcMain.handle('conductor:disconnect', (_e, ws: string, chatId: string) => {
    disconnectChat(getDb(), String(chatId))
    changed(String(ws))
  })
  ipcMain.handle('conductor:close', (_e, ws: string, chatId: string) => {
    closeSession(getDb(), String(chatId))
    changed(String(ws))
  })
  ipcMain.handle('conductor:reopen', (_e, ws: string, chatId: string) => {
    reopenSession(getDb(), String(chatId))
    changed(String(ws))
  })
}

/**
 * "Start Conductor…" from a project's right-click menu: ask, then turn it on (and connect the
 * project's existing chats if that was chosen). `ask` shows the question and returns the index of
 * the button pressed, so a test can answer it. Returns the Conductor, or null when cancelled.
 */
export async function startConductorDialog(
  workspaceId: string,
  ask: (options: {
    type: 'question'
    buttons: string[]
    defaultId: number
    cancelId: number
    message: string
    detail: string
  }) => Promise<number>
): Promise<ConductorInfo | null> {
  const db = getDb()
  const existing = (
    db
      .prepare('SELECT id FROM chats WHERE workspaceId = ? AND incognito = 0 ORDER BY position')
      .all(workspaceId) as { id: string }[]
  ).map((r) => r.id)
  const some = existing.length > 0
  const response = await ask({
    type: 'question',
    buttons: some
      ? ['Start clean', `Connect the ${existing.length} existing chats`, 'Cancel']
      : ['Start', 'Cancel'],
    defaultId: 0,
    cancelId: some ? 2 : 1,
    message: 'Start a Conductor for this project?',
    detail:
      'It adds one Main chat. You write to Main; it starts a session for each piece of work, sends your follow-ups to the right one, and asks when it is not sure. Nothing in your existing chats changes.'
  })
  if (response === (some ? 2 : 1)) return null
  const info = enableConductor(db, workspaceId, {
    adoptChatIds: some && response === 1 ? existing : [],
    makeMain: () => createChat(workspaceId)
  })
  try {
    backfillSessionRecords(workspaceId)
  } catch {
    // the records are filled on Main's next message anyway
  }
  return info
}
