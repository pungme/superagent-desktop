import { ipcMain } from 'electron'

/**
 * A chat's browser tabs, as the main process knows them.
 *
 * Same idea as desktop.ts's snapshot: the tabs themselves are React state in
 * the renderer (BrowserTabs.tsx), one WebContentsView per tab. This is a
 * mirror the renderer keeps current, so the browser_* MCP tools — which run
 * out here, not in a window — know which tab is in front and can ask for a
 * new one, a switch or a close without owning any of that state themselves.
 *
 * Keyed by the chat's own base pane id ("<workspace>::<chat>", or the bare
 * workspace id pre-first-chat) — never by a tab's own id, which is that base
 * id for the first tab and "<base>::t<n>" for every one after it.
 */

export interface ChatTabInfo {
  id: string
  url: string
  title: string
  active: boolean
}

const tabsByChat = new Map<string, ChatTabInfo[]>()

export function chatTabs(basePaneId: string): ChatTabInfo[] {
  return tabsByChat.get(basePaneId) ?? []
}

/**
 * The pane id of the tab in front for this chat — what browser_* tools drive.
 * Falls back to the base pane itself: before a BrowserTabs ever reports (or
 * once it unmounts), a chat has exactly the one tab it always had.
 */
export function activeChatTab(basePaneId: string): string {
  return tabsByChat.get(basePaneId)?.find((t) => t.active)?.id ?? basePaneId
}

/**
 * The tab the AGENT is working in, which is not necessarily the one in front.
 *
 * The tools used to drive whichever tab was in front. So the moment you opened
 * a tab of your own to look something up, the agent's next navigate took it
 * over and your page was gone. The agent now keeps the tab it started in until
 * it opens or switches tabs itself, or that tab is closed.
 */
const agentTabByChat = new Map<string, string>()

export function agentChatTab(basePaneId: string): string {
  const tabs = tabsByChat.get(basePaneId) ?? []
  const pinned = agentTabByChat.get(basePaneId)
  if (pinned && tabs.some((t) => t.id === pinned)) return pinned
  // First use, or its tab was closed: take the one in front, and keep it.
  const id = activeChatTab(basePaneId)
  if (tabs.length) agentTabByChat.set(basePaneId, id)
  return id
}

/** The agent opened or switched to this tab: its tools act here from now on. */
export function setAgentChatTab(basePaneId: string, tabId: string): void {
  agentTabByChat.set(basePaneId, tabId)
}

export function registerChatBrowserTabsIpc(): void {
  ipcMain.on('browser:tabs-report', (_e, basePaneId: string, tabs: ChatTabInfo[]) => {
    if (tabs.length) tabsByChat.set(basePaneId, tabs)
    else tabsByChat.delete(basePaneId)
  })
}
