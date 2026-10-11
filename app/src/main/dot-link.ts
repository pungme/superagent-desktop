/**
 * What the app's own tools need from the dot, without the dot itself: dot.ts
 * has the window and registers here when it starts; app-tools.ts asks through
 * this. Kept apart so that a test of the tools needs no screen (dot.ts wants
 * BrowserWindow, globalShortcut and the screen the moment it is loaded).
 */
export interface DotLink {
  /** A conversation the dot started, so a tool call in it was asked from the dot. */
  owns(chatId: string | null | undefined): boolean
  /** Move the dot's own target to a project; false when there is no dot to move. */
  switchTo(workspaceId: string): boolean
}

let link: DotLink | null = null

export function linkDot(l: DotLink | null): void {
  link = l
}

export function dotOwns(chatId: string | null | undefined): boolean {
  return !!link?.owns(chatId)
}

export function switchDotProject(workspaceId: string): boolean {
  return !!link?.switchTo(workspaceId)
}
