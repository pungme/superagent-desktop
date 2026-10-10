import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { bringAppForward } from './app-hotkey'
import { dotProjects } from './dot-projects'
import { broadcastToWindows } from './util'
import { findProject } from '../shared/find-project'

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
export function registerAppTools(server: McpServer): void {
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
}
