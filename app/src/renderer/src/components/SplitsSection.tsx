import { useStore } from '../state'
import { useProjectIcon } from '../hooks/useProjectIcon'
import { ProjectIcon } from './ProjectIcon'
import type { Workspace } from '../../../preload'
import type { Split } from '../lib/split'

function TileIcon({ ws }: { ws: Workspace }): React.JSX.Element {
  const icon = useProjectIcon(ws.id, ws.path, ws.kind)
  return (
    <span className="split-row-icon">
      <ProjectIcon icon={icon} kind={ws.kind} size={16} />
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
  if (splits.length === 0) return null
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
        return (
          <div
            key={sp.id}
            className={`split-row ${on ? 'on' : ''}`}
            role="button"
            tabIndex={0}
            title={detail}
            aria-label={`Split: ${names}`}
            data-split-id={sp.id}
            onClick={() => openSplit(sp.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openSplit(sp.id)
              }
            }}
          >
            <span className="split-row-icons">
              {sp.tiles.map((t) => {
                const ws = wsOf(t.ws)
                return ws ? <TileIcon key={`${t.ws}:${t.chat}`} ws={ws} /> : null
              })}
            </span>
            <span className="split-row-name">{names || 'Split'}</span>
            <span className="split-row-count">{sp.tiles.length}</span>
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
