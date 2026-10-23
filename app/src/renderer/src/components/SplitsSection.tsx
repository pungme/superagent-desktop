import { useState } from 'react'
import { useStore } from '../state'
import { useProjectIcon } from '../hooks/useProjectIcon'
import { ProjectIcon } from './ProjectIcon'
import type { Workspace } from '../../../preload'
import { layoutRects, type Split } from '../lib/split'

/** The thumbnail's size: the split's windows drawn as they sit, at this scale. */
const THUMB_W = 52
const THUMB_H = 34

function TileIcon({ ws, size }: { ws: Workspace; size: number }): React.JSX.Element {
  const icon = useProjectIcon(ws.id, ws.path, ws.kind)
  return <ProjectIcon icon={icon} kind={ws.kind} size={size} />
}

/**
 * A small picture of the split: its windows laid out as they are on screen
 * (three across, two over two…), each holding its project's logo.
 */
function SplitThumb({
  sp,
  wsOf
}: {
  sp: Split
  wsOf: (id: string) => Workspace | undefined
}): React.JSX.Element {
  // Laid out on a window-shaped canvas, then scaled down to the thumbnail.
  const W = 1320
  const H = 900
  const rects = layoutRects(sp.tiles.length, W, H, sp.orient, sp.fr)
  return (
    <span className="split-thumb" aria-hidden="true">
      <span className="split-thumb-in">
        {sp.tiles.map((t, i) => {
          const r = rects[i]
          if (!r) return null
          const ws = wsOf(t.ws)
          const w = (r.w / W) * (THUMB_W - 4)
          const h = (r.h / H) * (THUMB_H - 4)
          const size = Math.max(9, Math.min(18, Math.floor(Math.min(w, h) - 2)))
          return (
            <span
              key={`${t.ws}:${t.chat}`}
              className="split-thumb-cell"
              style={{
                left: `${(r.x / W) * 100}%`,
                top: `${(r.y / H) * 100}%`,
                width: `${(r.w / W) * 100}%`,
                height: `${(r.h / H) * 100}%`
              }}
            >
              {ws && <TileIcon ws={ws} size={size} />}
            </span>
          )
        })}
      </span>
    </span>
  )
}

/**
 * The Splits rows at the top of the sidebar, as in Arc: a split is one row —
 * its projects' icons and names — that you leave by opening any other chat and
 * come back to by clicking it. × separates it into its chats again.
 */
export function SplitsSection(): React.JSX.Element | null {
  const splits = useStore((s) => s.splits)
  const current = useStore((s) => s.split?.id ?? null)
  const overlay = useStore((s) => s.overlay)
  const tree = useStore((s) => s.tree)
  const chats = useStore((s) => s.chats)
  const openSplit = useStore((s) => s.openSplit)
  const separateSplit = useStore((s) => s.separateSplit)
  const renameSplit = useStore((s) => s.renameSplit)
  const busy = useStore((s) => s.busy)
  const asks = useStore((s) => s.guardrailAsks)
  const [editing, setEditing] = useState<string | null>(null)
  if (splits.length === 0) return null
  /** Whether a chat of the split needs you (first) or is working. */
  const statusOf = (sp: Split): 'needs-you' | 'working' | null => {
    if (sp.tiles.some((t) => asks.some((a) => a.sessionId === t.chat))) return 'needs-you'
    if (sp.tiles.some((t) => busy[t.chat]?.generating)) return 'working'
    return null
  }
  const titleOf = (sp: Split, i: number): string => {
    const t = sp.tiles[i]
    return chats[t.ws]?.find((c) => c.id === t.chat)?.title || 'New chat'
  }
  const wsOf = (id: string): Workspace | undefined =>
    tree.flatMap((g) => g.workspaces).find((w) => w.id === id)
  const describe = (sp: Split): { names: string; detail: string } => {
    const names = sp.tiles
      .map((t) => wsOf(t.ws)?.name ?? '')
      .filter((n, i, a) => n && a.indexOf(n) === i)
      .join(' · ')
    const detail = sp.tiles
      .map(
        (t) =>
          `${wsOf(t.ws)?.name ?? ''} › ${chats[t.ws]?.find((c) => c.id === t.chat)?.title || 'New chat'}`
      )
      .join('\n')
    return { names, detail }
  }
  return (
    <div className="sidebar-splits" aria-label="Splits">
      <div className="pinned-section-label">Splits</div>
      {splits.map((sp) => {
        const on = sp.id === current && overlay === null
        const { names, detail } = describe(sp)
        const status = statusOf(sp)
        const chatNames = sp.tiles.map((_, i) => titleOf(sp, i)).join(' · ')
        return (
          <div
            key={sp.id}
            className={`split-row ${on ? 'on' : ''}`}
            role="button"
            tabIndex={0}
            title={`${sp.name ? `${sp.name}\n` : ''}${detail}\nDouble-click to rename`}
            aria-label={`Split: ${names}`}
            data-split-id={sp.id}
            onClick={() => editing !== sp.id && openSplit(sp.id)}
            onDoubleClick={() => setEditing(sp.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openSplit(sp.id)
              }
            }}
          >
            <SplitThumb sp={sp} wsOf={wsOf} />
            <span className="split-row-name">
              {editing === sp.id ? (
                <input
                  autoFocus
                  defaultValue={sp.name ?? ''}
                  placeholder={names || 'Name this split'}
                  aria-label="Split name"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') {
                      renameSplit(sp.id, (e.target as HTMLInputElement).value)
                      setEditing(null)
                    } else if (e.key === 'Escape') {
                      // Put the old name back first: the blur that follows saves what is there.
                      ;(e.target as HTMLInputElement).value = sp.name ?? ''
                      setEditing(null)
                    }
                  }}
                  onBlur={(e) => {
                    renameSplit(sp.id, e.target.value)
                    setEditing(null)
                  }}
                />
              ) : (
                <>
                  <span className="split-row-title">{sp.name || names || 'Split'}</span>
                  {/* Which conversations: two splits of one project otherwise
                      read the same. */}
                  <span className="split-row-chats">{chatNames}</span>
                </>
              )}
            </span>
            {status ? (
              <span
                className={`split-row-status ${status}`}
                title={status === 'working' ? 'A chat here is working' : 'A chat here needs you'}
              />
            ) : (
              <span className="split-row-count">{sp.tiles.length}</span>
            )}
            <button
              className="split-row-x"
              title="Separate: each chat on its own again"
              aria-label="Separate this split"
              onClick={(e) => {
                e.stopPropagation()
                separateSplit(sp.id)
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
