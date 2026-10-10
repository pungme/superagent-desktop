import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { bringAppForward } from './app-hotkey'
import { dotProjects } from './dot-projects'
import { broadcastToWindows } from './util'
import { findProject } from '../shared/find-project'
import { rankChats, searchWords, type FindableChat } from '../shared/find-chat'
import { requestApproval } from './hooks'
import {
  createChat,
  DESKTOP_WORKSPACE_ID,
  ensureDesktopWorkspace,
  getChat,
  getWorkspace,
  listAllChats,
  markPendingBranch,
  searchChats,
  setChatPinned,
  setChatTitle
} from './store'
import { isGenerating } from './companion/log'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
const said = (text: string, isError = false): Result => ({
  ...(isError ? { isError } : {}),
  content: [{ type: 'text', text }]
})

/** When something was last used, in words short enough for a list. */
function ago(at: number, now = Date.now()): string {
  if (!at) return 'not used yet'
  const min = Math.round((now - at) / 60_000)
  if (min < 60) return min <= 1 ? 'just now' : `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/**
 * The agent's tools for Superagent itself: which projects there are, and
 * putting one in front of the user. "Open wepush", said to the dot or in any
 * chat, is the app's own window changing, not something to describe.
 */
/** Every chat as something a description can be matched against. */
function findable(words: string[]): (FindableChat & { running: boolean })[] {
  const projects = new Map(dotProjects().map((p) => [p.id, p.name]))
  const home = ensureDesktopWorkspace().workspaceId
  // What was said in each chat, a word at a time: which words, and one line.
  const said = new Map<string, { words: Set<string>; snippet: string }>()
  for (const w of words)
    for (const hit of searchChats(w, 40)) {
      const s = said.get(hit.chatId) ?? { words: new Set<string>(), snippet: hit.snippet }
      s.words.add(w)
      said.set(hit.chatId, s)
    }
  return listAllChats()
    .filter((c) => c.title || said.has(c.id))
    .map((c) => ({
      id: c.id,
      title: c.title ?? 'New chat',
      projectId: c.workspaceId,
      projectName:
        c.workspaceId === home || c.workspaceId === DESKTOP_WORKSPACE_ID
          ? 'Computer'
          : (projects.get(c.workspaceId) ?? ''),
      updatedAt: c.updatedAt,
      saidWords: [...(said.get(c.id)?.words ?? [])],
      snippet: said.get(c.id)?.snippet,
      running: isGenerating(c.id)
    }))
    .filter((c) => c.projectName)
}

const chatLine = (c: FindableChat & { running: boolean }): string =>
  `${c.id}  ·  "${c.title}"  ·  ${c.projectName}  ·  ${ago(c.updatedAt)}${c.running ? '  ·  working now' : ''}${c.snippet ? `\n    “${c.snippet.slice(0, 140)}”` : ''}`

/** Put a conversation in front of the user. */
function showChat(workspaceId: string, chatId: string): void {
  // A quiet test run has no window to raise, and must not raise one.
  if (process.env.COVE_E2E_QUIET !== '1') bringAppForward()
  broadcastToWindows('dot:open-chat', { workspaceId, chatId })
}

export interface AppToolsContext {
  workspaceId: string
  /** The chat calling, or its pane: who a question to the user comes from. */
  sessionId: string
  chatId: string | null
}

export function registerAppTools(server: McpServer, ctx: AppToolsContext): void {
  server.registerTool(
    'app_list_projects',
    {
      description:
        "The projects in Superagent, most recently used first, with the Computer (the Mac's own chat) at the top. Use it when the user names a project you are not sure of.",
      inputSchema: {}
    },
    async () =>
      said(
        dotProjects()
          .map((p) => `${p.name}${p.path ? `  (${p.path})` : ''}  ·  ${ago(p.usedAt)}`)
          .join('\n') || 'There are no projects yet.'
      )
  )

  server.registerTool(
    'app_open_project',
    {
      description:
        'Switch Superagent to a project and bring its window to the front, when the user asks to open, go to, switch to or show a project ("open wepush", "take me to the portal"). Takes the name as they said it; part of a name is enough when only one project fits. This changes what the user is looking at, so only call it when they asked for that.',
      inputSchema: { name: z.string().min(1).max(200) }
    },
    async ({ name }) => {
      const { match, candidates } = findProject(dotProjects(), name)
      if (!match)
        return said(
          candidates.length
            ? `More than one project fits "${name}": ${candidates.map((p) => p.name).join(', ')}. Ask the user which.`
            : `No project is called "${name}". The projects are: ${dotProjects()
                .map((p) => p.name)
                .join(', ')}.`,
          true
        )
      // A quiet test run has no window to raise, and must not raise one.
      if (process.env.COVE_E2E_QUIET !== '1') bringAppForward()
      broadcastToWindows('dot:open-chat', { workspaceId: match.id, chatId: '' })
      return said(`Superagent is now showing ${match.name}.`)
    }
  )

  server.registerTool(
    'app_find_chats',
    {
      description:
        'Find conversations in Superagent from how the user describes one: its topic, its project, something said in it ("the wepush chat about e2e testing", "where we fixed the header"). Returns the best fits with each one\'s id, title, project and when it was last used. Call this before app_open_chat, app_send_message or app_stop_chat when you were not given an id.',
      inputSchema: { query: z.string().min(1).max(300) }
    },
    async ({ query }) => {
      const found = rankChats(findable(searchWords(query)), query)
      return said(
        found.length
          ? found.map(chatLine).join('\n')
          : `No conversation fits "${query}". app_list_projects says which projects there are; a new one can be started with app_new_chat.`
      )
    }
  )

  server.registerTool(
    'app_open_chat',
    {
      description:
        'Switch Superagent to a conversation and bring its window to the front, by the id app_find_chats gave. When the user describes a chat and one result clearly fits, open it without asking; when several fit equally, ask which.',
      inputSchema: { chatId: z.string().min(1).max(100) }
    },
    async ({ chatId }) => {
      const chat = getChat(chatId)
      if (!chat) return said(`There is no conversation with the id "${chatId}".`, true)
      showChat(chat.workspaceId, chat.id)
      return said(`Superagent is now showing "${chat.title ?? 'New chat'}".`)
    }
  )

  server.registerTool(
    'app_status',
    {
      description:
        'What is going on in Superagent right now: the conversations whose agents are working, and the most recently used ones. Use it for "what is running?", "what was I doing?", "is the wepush one done?".',
      inputSchema: {}
    },
    async () => {
      const all = findable([]).filter((c) => c.id !== ctx.chatId)
      const running = all.filter((c) => c.running)
      const recent = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
      return said(
        `Working now (${running.length}):\n${running.map(chatLine).join('\n') || '  nothing'}\n\nRecently used:\n${recent.map(chatLine).join('\n') || '  nothing yet'}`
      )
    }
  )

  server.registerTool(
    'app_new_chat',
    {
      description:
        'Start a new conversation in a project (or in "Computer" for one that belongs to no project) and show it. With `message`, that is sent as its first message, so its own agent starts on it: use this to hand a job to a project ("start a chat in wepush to run the e2e tests"). Sending a message asks the user first.',
      inputSchema: {
        project: z.string().min(1).max(200),
        message: z.string().max(8000).optional()
      }
    },
    async ({ project, message }) => {
      const { match, candidates } = findProject(dotProjects(), project)
      if (!match)
        return said(
          candidates.length
            ? `More than one project fits "${project}": ${candidates.map((p) => p.name).join(', ')}. Ask the user which.`
            : `No project is called "${project}".`,
          true
        )
      const text = message?.trim()
      if (text && !(await mayMessage(`a new chat in ${match.name}`, text)))
        return said('The user did not allow that message. Do not send it another way.', true)
      const wsId =
        match.id === DESKTOP_WORKSPACE_ID ? ensureDesktopWorkspace().workspaceId : match.id
      if (!getWorkspace(wsId)) return said('That project is gone.', true)
      const chatId = createChat(wsId)
      if (wsId !== DESKTOP_WORKSPACE_ID) markPendingBranch(chatId)
      broadcastToWindows('projects:changed', {})
      showChat(wsId, chatId)
      if (!text) return said(`Started a new conversation in ${match.name} (id ${chatId}).`)
      const { askFromDot } = await import('./companion/rpc')
      const sent = await askFromDot(chatId, text)
      return sent.ok
        ? said(`Started a conversation in ${match.name} (id ${chatId}) and its agent is on it.`)
        : said(
            `The conversation was started (id ${chatId}) but the message was not sent: ${sent.error}`,
            true
          )
    }
  )

  /** A message to another conversation's agent is the user speaking: they are asked. */
  const mayMessage = (where: string, text: string): Promise<boolean> =>
    requestApproval(
      ctx.workspaceId,
      ctx.sessionId,
      'mcp__cove-browser__app_send_message',
      `Send to ${where}:\n${text.slice(0, 600)}`,
      'permission'
    )

  server.registerTool(
    'app_send_message',
    {
      description:
        'Send a message into another conversation, as the user would type it there, so that conversation\'s agent acts on it ("tell the wepush chat to rerun the tests"). The user is asked to allow each one. Not for this conversation itself.',
      inputSchema: { chatId: z.string().min(1).max(100), text: z.string().min(1).max(8000) }
    },
    async ({ chatId, text }) => {
      const chat = getChat(chatId)
      if (!chat) return said(`There is no conversation with the id "${chatId}".`, true)
      if (chatId === ctx.chatId) return said('That is this conversation: just answer here.', true)
      if (!(await mayMessage(`"${chat.title ?? 'New chat'}"`, text.trim())))
        return said('The user did not allow that message. Do not send it another way.', true)
      const { askFromDot } = await import('./companion/rpc')
      const sent = await askFromDot(chatId, text.trim())
      return sent.ok
        ? said(
            `Sent to "${chat.title ?? 'New chat'}". Its agent is working on it; app_status says when it is done.`
          )
        : said(`Not sent: ${sent.error}`, true)
    }
  )

  server.registerTool(
    'app_stop_chat',
    {
      description:
        'Stop the agent that is working in another conversation, as its Stop button does.',
      inputSchema: { chatId: z.string().min(1).max(100) }
    },
    async ({ chatId }) => {
      const chat = getChat(chatId)
      if (!chat) return said(`There is no conversation with the id "${chatId}".`, true)
      const { stopFromDot } = await import('./companion/rpc')
      const stopped = await stopFromDot(chatId)
      return said(
        stopped
          ? `Stopped "${chat.title ?? 'New chat'}".`
          : `"${chat.title ?? 'New chat'}" was not working, so there was nothing to stop.`
      )
    }
  )

  server.registerTool(
    'app_rename_chat',
    {
      description: 'Give a conversation a new name.',
      inputSchema: { chatId: z.string().min(1).max(100), title: z.string().min(1).max(120) }
    },
    async ({ chatId, title }) => {
      if (!getChat(chatId)) return said(`There is no conversation with the id "${chatId}".`, true)
      setChatTitle(chatId, title.trim())
      broadcastToWindows('projects:changed', {})
      return said(`Renamed to "${title.trim()}".`)
    }
  )

  server.registerTool(
    'app_pin_chat',
    {
      description: 'Pin a conversation to the top of the sidebar, or unpin it.',
      inputSchema: { chatId: z.string().min(1).max(100), pinned: z.boolean() }
    },
    async ({ chatId, pinned }) => {
      const chat = getChat(chatId)
      if (!chat) return said(`There is no conversation with the id "${chatId}".`, true)
      setChatPinned(chatId, pinned)
      broadcastToWindows('projects:changed', {})
      return said(`${pinned ? 'Pinned' : 'Unpinned'} "${chat.title ?? 'New chat'}".`)
    }
  )

  server.registerTool(
    'app_open_view',
    {
      description:
        'Show one of Superagent\'s own screens: "settings", "computer" (the desktop with its Dashboard, Skills and Routines) or "chats" (conversations that belong to no project).',
      inputSchema: { view: z.enum(['settings', 'computer', 'chats']) }
    },
    async ({ view }) => {
      if (process.env.COVE_E2E_QUIET !== '1') bringAppForward()
      broadcastToWindows('app:open-view', { view })
      return said(
        `Superagent is now showing ${view === 'settings' ? 'Settings' : view === 'computer' ? 'the Computer' : 'Chats'}.`
      )
    }
  )
}
