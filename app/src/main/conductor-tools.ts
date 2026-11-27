import { execFileSync } from 'child_process'
import type { EventEmitter } from 'events'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { buildManifest, autoTitle, ticketLabel, type ConductorSession } from '../shared/conductor'
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
  listChatEvents,
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
        if (text && conductorOfWorker(getDb(), chatId)) setSummary(getDb(), chatId, summaryOf(text))
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

/** Commits on a worker's branch that its project's main branch lacks; null when it has no branch. */
function unmergedCount(cwd: string | null): number | null {
  if (!cwd) return null
  for (const base of ['main', 'master']) {
    try {
      const n = execFileSync('git', ['-C', cwd, 'rev-list', '--count', `${base}..HEAD`], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return Number(n.trim()) || 0
    } catch {
      // not this base, or not a repository
    }
  }
  return null
}

/** Files a worker has changed against the main branch, committed or not. */
function changedFiles(cwd: string | null): string[] | undefined {
  if (!cwd) return undefined
  const run = (args: string[]): string[] | null => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .split('\n')
        .filter(Boolean)
    } catch {
      return null
    }
  }
  let files: string[] | null = null
  for (const base of ['main', 'master']) {
    files = run(['diff', '--name-only', `${base}...HEAD`])
    if (files) break
  }
  if (!files) return undefined
  const dirty = run(['status', '--porcelain']) ?? []
  const all = new Set([...files, ...dirty.map((l) => l.slice(3).replace(/^.* -> /, ''))])
  return [...all].sort()
}

function branchOf(cwd: string | null): string | undefined {
  if (!cwd) return undefined
  try {
    const b = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return b && b !== 'HEAD' ? b : undefined
  } catch {
    return undefined
  }
}

/** The project's sessions as the Conductor sees them (title, ticket, status, branch, summary). */
export function sessionsOf(info: ConductorInfo, includeClosed = false): ConductorSession[] {
  const db = getDb()
  return listSessions(db, info.workspaceId, { includeClosed }).map((r) => {
    const cwd = getChat(r.chatId)?.cwd ?? null
    return {
      chatId: r.chatId,
      title: r.title,
      ticket: r.ticket,
      summary: r.summary,
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
      branch: branchOf(cwd),
      unmerged: unmergedCount(cwd) ?? undefined,
      files: changedFiles(cwd)
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

/** A readable digest of the end of a worker's conversation. */
function digest(chatId: string, turns: number): string {
  const all = listChatEvents(chatId, 0, 100000)
  const tail = all.slice(-Math.max(20, turns * 12))
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
      if (!includeClosed) return said(manifestFor(c))
      const s = sessionsOf(c, true)
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
      const unmerged = unmergedCount(chat?.cwd ?? null)
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
      refresh()
      return said(`Closed ${s.ticket != null ? ticketLabel(s.ticket) : s.title}.`)
    }
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
      if (!chat?.cwd || !unmergedCount(chat.cwd)) return said(`${label} has nothing to merge.`)
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

const changed = (workspaceId: string): void => {
  broadcastToWindows('conductor:changed', { workspaceId })
  broadcastToWindows('projects:changed', {})
}

export function registerConductorIpc(): void {
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
  ipcMain.handle('conductor:enable', (_e, ws: string, adopt: unknown) => {
    const workspaceId = String(ws)
    if (!getWorkspace(workspaceId)) return null
    enableConductor(getDb(), workspaceId, {
      adoptChatIds: Array.isArray(adopt) ? adopt.map(String) : [],
      makeMain: () => createChat(workspaceId)
    })
    changed(workspaceId)
    return stateOf(workspaceId)
  })
  ipcMain.handle('conductor:set-routing', (_e, ws: string, mode: unknown) => {
    setRouting(getDb(), String(ws), mode === 'auto' ? 'auto' : 'confirm')
    changed(String(ws))
  })
  ipcMain.handle('conductor:connect', (_e, ws: string, chatId: string) => {
    const t = connectChat(getDb(), String(ws), String(chatId))
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
  return enableConductor(db, workspaceId, {
    adoptChatIds: some && response === 1 ? existing : [],
    makeMain: () => createChat(workspaceId)
  })
}
