import { useEffect, useState } from 'react'
import type { BrowserChoice } from '../../../preload'

/**
 * Which browser a conversation's agent uses, kept current when it's changed
 * anywhere. Per conversation: pass its pane id ("project::chat"). It was per
 * project, and one chat switching to Brave switched all the others.
 */
export function useChatBrowser(workspaceId: string, chatId?: string | null): BrowserChoice {
  const scope = chatId ? `${workspaceId}::${chatId}` : workspaceId
  const [choice, setChoice] = useState<BrowserChoice>('builtin')
  useEffect(() => {
    let alive = true
    void window.cove.browsersGet?.(scope).then((c) => {
      if (alive) setChoice(c)
    })
    const off = window.cove.onBrowsersChanged?.((c) => {
      if (c.scope === scope) setChoice(c.id)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [scope])
  return choice
}
