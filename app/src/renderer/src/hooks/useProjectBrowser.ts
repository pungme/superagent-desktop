import { useEffect, useState } from 'react'
import type { BrowserChoice } from '../../../preload'

/** Which browser a project's agent uses, kept current when it's changed anywhere. */
export function useProjectBrowser(workspaceId: string): BrowserChoice {
  const [choice, setChoice] = useState<BrowserChoice>('builtin')
  useEffect(() => {
    let alive = true
    void window.cove.browsersGet?.(workspaceId).then((c) => {
      if (alive) setChoice(c)
    })
    const off = window.cove.onBrowsersChanged?.((c) => {
      if (c.workspaceId === workspaceId) setChoice(c.id)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [workspaceId])
  return choice
}
