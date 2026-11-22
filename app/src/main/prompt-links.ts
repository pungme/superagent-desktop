import { app, ipcMain } from 'electron'
import os from 'os'
import { join } from 'path'
import { askToOpen } from './open-request'
import { bringAppForward } from './app-hotkey'
import { dotProjects } from './dot-projects'
import { saveDraft } from './drafts'
import { findProject } from '../shared/find-project'
import { parsePromptLink, PROMPT_LINK_SCHEME } from '../shared/prompt-link'
import { createChat, ensureDesktopWorkspace, getWorkspace, markPendingBranch } from './store'
import { broadcastToWindows } from './util'

/**
 * A new conversation with `text` waiting in its message box, never sent: in the
 * project named (by name, or a repository's last part), else a chat of its own
 * on the Chats page. Prompt links and "Diagnose Superagent" both open one.
 */
export function openDraftChat(text: string, project?: string): { chatId: string; where: string } {
  let match: { id: string; name: string } | null = null
  if (project) {
    const projects = dotProjects()
    match =
      findProject(projects, project).match ??
      findProject(projects, project.split('/').pop() ?? project).match ??
      null
  }
  const wsId = match && getWorkspace(match.id) ? match.id : ensureDesktopWorkspace().workspaceId
  const chatId = createChat(wsId)
  if (match) markPendingBranch(chatId)
  saveDraft(chatId, text, null)
  broadcastToWindows('projects:changed', {})
  if (process.env.COVE_E2E_QUIET !== '1') bringAppForward()
  askToOpen(wsId, chatId)
  return { chatId, where: match?.name ?? 'Chats' }
}

/** Open a `superagent://prompt?…` link. False for anything else. */
export function openPromptLink(url: string): boolean {
  const link = parsePromptLink(url)
  if (!link) return false
  openDraftChat(link.text, link.project)
  return true
}

/**
 * What "Diagnose Superagent" puts in the box: where everything is, what to do
 * with it, and room for the user to say what went wrong. The agent reads; it
 * asks before it changes anything or posts anything.
 */
export function diagnosePrompt(): string {
  const data = app.getPath('userData')
  const v = app.getVersion()
  const logs = ['agents.log', 'memory.log', 'updater.log', 'screenshots.log', 'pane-debug.log']
  return [
    `Diagnose Superagent ${v} on macOS ${os.release()} (Darwin) for me.`,
    '',
    'Where to look:',
    ...logs.map((l) => `- ${join(data, l)}`),
    `- ${join(data, 'phone-diagnostics')}/ (the iPhone app's freeze and crash reports, newest first)`,
    `- ~/Library/Logs/DiagnosticReports/ (macOS crash and hang reports named SuperAgent*)`,
    `- The source of this exact version: https://github.com/pungme/superagent-desktop/tree/v${v} (and the iPhone app: https://github.com/pungme/superagent-ios)`,
    '',
    'Read what is relevant to the problem below, find the cause, and explain it in plain words with the',
    'evidence (file and line). Do not change any file, setting or app, and do not post anything, until I',
    'say so. If it is a bug in Superagent, draft a GitHub issue for pungme/superagent-desktop and show it',
    'to me first. Leave out anything private (names, emails, chat contents) from what you quote.',
    '',
    'What went wrong: '
  ].join('\n')
}

let pending: string[] = []
let ready = false

/**
 * `superagent://` opens Superagent. macOS hands a link over as `open-url`,
 * possibly before the app is ready (it was what launched it): those wait.
 */
export function registerPromptLinks(): void {
  // Only a packaged app registers itself: a dev build would claim the scheme
  // for the bare Electron binary.
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROMPT_LINK_SCHEME)
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (ready) openPromptLink(url)
    else pending.push(url)
  })
  ipcMain.handle('diagnose:open', () => openDraftChat(diagnosePrompt()))
}

/** Once a window can show the chat: open what came in while starting. */
export function promptLinksReady(): void {
  ready = true
  const urls = pending
  pending = []
  for (const u of urls) openPromptLink(u)
}
