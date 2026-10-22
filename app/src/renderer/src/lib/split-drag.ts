import { useStore } from '../state'
import { dropPlan, type DropPlan, type SplitTile } from './split'

/**
 * Carrying a chat into split view: from the sidebar's list, or a window by its
 * handle. Pointer-based (not HTML drag and drop), so the sidebar's own drag —
 * which reorders chats — and a window's handle land through the same rules.
 * SplitLayer draws the preview and tells this module where the windows are.
 */

/**
 * Where the canvas is on screen and how to apply a drop there. Set by the one
 * mounted SplitLayer, so a drag that ends anywhere (the sidebar's list, a
 * window's handle) lands through the same rules.
 */
export const dropTarget: { rect: () => DOMRect | null } = { rect: () => null }

/** Where a chat dropped at this point (window coordinates) would go. */
export function planAt(tile: SplitTile, x: number, y: number): DropPlan {
  const box = dropTarget.rect()
  if (!box) return null
  const s = useStore.getState()
  const current: SplitTile[] =
    s.split?.tiles ??
    (s.activeWorkspaceId && s.activeChatId[s.activeWorkspaceId]
      ? [{ ws: s.activeWorkspaceId, chat: s.activeChatId[s.activeWorkspaceId] }]
      : [])
  return dropPlan(
    current,
    s.split?.orient ?? 'row',
    tile,
    x - box.left,
    y - box.top,
    box.width,
    box.height
  )
}

/** A chat is being dragged toward the windows; `x`/`y` in window coordinates. */
export function moveChatDrag(tile: SplitTile, x: number, y: number): void {
  useStore.getState().setSplitDrag({ tile, x, y })
}

/** The drag ended here: open the chat where the preview showed. True when it landed. */
export function finishChatDrag(x: number, y: number): boolean {
  const s = useStore.getState()
  const d = s.splitDrag
  s.setSplitDrag(null)
  if (!d) return false
  const plan = planAt(d.tile, x, y)
  if (plan?.kind !== 'insert') return false
  s.arrangeSplit(plan.tiles, plan.at, plan.orient)
  focusComposerSoon()
  return true
}

export function cancelChatDrag(): void {
  useStore.getState().setSplitDrag(null)
}

/** A window's handle: press and move to carry the window elsewhere in the split. */
export function onGripPointerDown(e: React.PointerEvent, tile: SplitTile): void {
  if (e.button !== 0) return
  e.preventDefault()
  const x0 = e.clientX
  const y0 = e.clientY
  let live = false
  const move = (ev: PointerEvent): void => {
    if (!live && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
    live = true
    moveChatDrag(tile, ev.clientX, ev.clientY)
  }
  const up = (ev: PointerEvent): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('keydown', esc)
    if (live) finishChatDrag(ev.clientX, ev.clientY)
  }
  const esc = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('keydown', esc)
    cancelChatDrag()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('keydown', esc)
}

/** Put focus in the composer of the window that is now focused, once it has rendered. */
export function focusComposerSoon(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent('cove:command-focus-composer'))
    )
  )
}
