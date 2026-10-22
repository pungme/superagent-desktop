import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state'
import {
  SPLIT_GAP,
  MIN_TILE_H,
  MIN_TILE_W,
  layoutRects,
  neighbour,
  resized,
  splitRects,
  type Rect,
  type SplitTile
} from '../lib/split'
import { dropTarget, focusComposerSoon, planAt } from '../lib/split-drag'

/**
 * What sits over the windows of a split: the gaps you drag to resize, the
 * preview of where a dragged chat will land, and the keys that move between
 * windows. `canvas` is where the windows are, in the content area's pixels.
 */
export function SplitLayer({ canvas }: { canvas: Rect }): React.JSX.Element | null {
  const split = useStore((s) => s.split)
  const drag = useStore((s) => s.splitDrag)
  const notice = useStore((s) => s.splitNotice)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => useStore.setState({ splitNotice: null }), 2600)
    return () => clearTimeout(t)
  }, [notice])
  const chatsByWs = useStore((s) => s.chats)
  const tree = useStore((s) => s.tree)
  const enterOverlay = useStore((s) => s.enterOverlay)
  const exitOverlay = useStore((s) => s.exitOverlay)
  const dropRef = useRef<HTMLDivElement>(null)
  const [resizing, setResizing] = useState<number | null>(null)

  const label = (t: SplitTile): { project: string; chat: string } => {
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.id === t.ws)
    const c = chatsByWs[t.ws]?.find((x) => x.id === t.chat)
    return { project: ws?.name ?? '', chat: c?.title || 'New chat' }
  }

  // A native page or simulator paints above everything; while a chat is being
  // dragged the preview has to be seen, so they step aside (the same lock a
  // menu over the page takes).
  const dragging = !!drag
  useEffect(() => {
    if (!dragging) return
    enterOverlay()
    return () => exitOverlay()
  }, [dragging, enterOverlay, exitOverlay])
  useEffect(() => {
    dropTarget.rect = () => dropRef.current?.getBoundingClientRect() ?? null
    return () => {
      dropTarget.rect = () => null
    }
  }, [])
  const plan = drag ? planAt(drag.tile, drag.x, drag.y) : null

  // Keys that move between windows. Only while there is a split.
  useEffect(() => {
    if (!split) return
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const sp = s.split
      if (!sp) return
      const n = sp.tiles.length
      const go = (i: number): void => {
        e.preventDefault()
        e.stopPropagation()
        if (i < 0 || i >= n) return
        s.focusTile(i)
        focusComposerSoon()
      }
      // ⌘1–4, and ⌃⇧1–4 as in Arc.
      const digit = /^Digit([1-4])$/.exec(e.code)?.[1]
      if (
        digit &&
        ((e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey) ||
          (e.ctrlKey && e.shiftKey && !e.metaKey))
      ) {
        if (Number(digit) <= n) go(Number(digit) - 1)
        return
      }
      if (e.ctrlKey && !e.metaKey && e.key === 'Tab')
        return go((sp.focus + (e.shiftKey ? n - 1 : 1)) % n)
      if (e.metaKey && e.altKey && !e.shiftKey && e.key.startsWith('Arrow')) {
        const dir = e.key.slice(5)
        const rects = splitRects(sp, canvas.w, canvas.h)
        const to = neighbour(
          rects,
          sp.focus,
          dir === 'Left' ? -1 : dir === 'Right' ? 1 : 0,
          dir === 'Up' ? -1 : dir === 'Down' ? 1 : 0
        )
        if (to >= 0) go(to)
        return
      }
      if (e.metaKey && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        s.zoomTile(sp.zoom === null ? sp.focus : null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [split, canvas.w, canvas.h])

  // Holding ⌘ shows every window's number large in its header, so ⌘1–4 can be
  // read off the screen (CSS keys off this class).
  useEffect(() => {
    if (!split) return
    let t: ReturnType<typeof setTimeout> | null = null
    const root = document.documentElement
    const off = (): void => {
      if (t) clearTimeout(t)
      t = null
      root.classList.remove('split-numbers')
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Meta' && !e.repeat)
        t = setTimeout(() => root.classList.add('split-numbers'), 350)
      else off()
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') off()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', off)
    return () => {
      off()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', off)
    }
  }, [split])

  const rects =
    split && split.zoom === null
      ? layoutRects(split.tiles.length, canvas.w, canvas.h, split.orient, split.fr)
      : []
  const gaps = split && split.zoom === null && split.tiles.length <= 3 ? rects.slice(0, -1) : []

  const onGapDown = (k: number) => (e: React.PointerEvent) => {
    if (!split) return
    e.preventDefault()
    const col = split.orient === 'col'
    const start = col ? e.clientY : e.clientX
    const fr0 = split.fr
    const n = split.tiles.length
    const total = col ? canvas.h : canvas.w
    setResizing(k)
    document.documentElement.classList.add('split-resizing')
    const move = (ev: PointerEvent): void => {
      const px = (col ? ev.clientY : ev.clientX) - start
      useStore.getState().setSplitFr(resized(fr0, n, k, px, total, col ? MIN_TILE_H : MIN_TILE_W))
    }
    const up = (): void => {
      setResizing(null)
      document.documentElement.classList.remove('split-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const preview =
    plan?.kind === 'insert'
      ? layoutRects(plan.tiles.length, canvas.w, canvas.h, plan.orient, null).map((r, i) => ({
          r,
          t: plan.tiles[i],
          isNew: i === plan.at
        }))
      : []

  return (
    <>
      {gaps.map((r, k) => {
        const col = split?.orient === 'col'
        return (
          <div
            key={k}
            className={`split-gap ${col ? 'h' : 'v'} ${resizing === k ? 'on' : ''}`}
            role="separator"
            aria-label="Resize windows"
            style={
              col
                ? { left: canvas.x, width: canvas.w, top: canvas.y + r.y + r.h, height: SPLIT_GAP }
                : { top: canvas.y, height: canvas.h, left: canvas.x + r.x + r.w, width: SPLIT_GAP }
            }
            onPointerDown={onGapDown(k)}
            onDoubleClick={() => useStore.getState().setSplitFr(null)}
          />
        )
      })}
      {/* Always there (empty) so a drag can measure where the windows are. */}
      <div
        ref={dropRef}
        className={`split-drop${drag ? ' on' : ''}`}
        style={{ left: canvas.x, top: canvas.y, width: canvas.w, height: canvas.h }}
      >
        {drag &&
          preview.map(({ r, t, isNew }) => {
            const l = label(t)
            return (
              <div
                key={`${t.ws}:${t.chat}`}
                className={`split-ghost ${isNew ? 'new' : ''}`}
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
              >
                <span className="split-ghost-label">
                  {isNew ? 'Open here' : `${l.project} › ${l.chat}`}
                </span>
              </div>
            )
          })}
        {drag && plan?.kind === 'full' && (
          <div className="split-note">Four is the most · close one first</div>
        )}
      </div>
      {notice && (
        <div className="split-notice" role="status">
          {notice}
        </div>
      )}
      {drag && (
        <div className="split-pill" style={{ left: drag.x, top: drag.y }}>
          {label(drag.tile).chat}
        </div>
      )}
    </>
  )
}
