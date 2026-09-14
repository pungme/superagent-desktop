import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, useOverlayLock } from '../state'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { fuzzyFilter } from '../lib/fuzzy'

interface PaletteItem {
  id: string
  label: string
  subtitle?: string
  shortcut?: string
  /** Extra text a query can match beyond the visible label. */
  keywords?: string
  run: () => void
}

interface Group {
  title: string
  items: PaletteItem[]
}

const dispatch = (name: string): void => {
  window.dispatchEvent(new CustomEvent(name))
}

/**
 * ⌘K. Superhuman's shape: everything the app can do is one search away, every
 * result shows the direct shortcut it already has (or could have), and typing
 * a name jumps straight to a project or a conversation — so the palette is
 * both a fast path AND how you learn the fast paths that don't need it.
 */
export function CommandPalette({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const tree = useStore((s) => s.tree)
  const chats = useStore((s) => s.chats)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const activeChatId = useStore((s) => s.activeChatId)

  useOverlayLock(open)
  useEscapeClose(onClose, open)

  // Reset when the palette opens — during render, not an effect: an effect's
  // setState runs a beat after the render that flipped `open`, so the very
  // first frame showed the previous session's leftover query and selection.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setSelected(0)
    }
  }

  useEffect(() => {
    if (!open) return
    // A frame late: the portal has to be in the DOM first.
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const workspaces = useMemo(() => tree.flatMap((g) => g.workspaces), [tree])
  const currentWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const currentChatId = activeWorkspaceId ? activeChatId[activeWorkspaceId] : undefined

  const allChats = useMemo(
    () =>
      Object.entries(chats).flatMap(([workspaceId, list]) =>
        list.map((c) => ({ ...c, workspaceId }))
      ),
    [chats]
  )

  const projectNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const w of workspaces) m.set(w.id, w.name)
    return m
  }, [workspaces])

  const currentChatCommands = useMemo<PaletteItem[]>(() => {
    if (!currentWorkspace) return []
    const items: PaletteItem[] = [
      {
        id: 'cmd.new-chat',
        label: 'New chat',
        subtitle: currentWorkspace.name,
        run: () => void useStore.getState().newChat(currentWorkspace.id)
      }
    ]
    if (currentChatId) {
      items.push(
        {
          id: 'cmd.focus-composer',
          label: 'Focus composer',
          shortcut: '⌘J',
          run: () => dispatch('cove:command-focus-composer')
        },
        {
          id: 'cmd.stop-agent',
          label: 'Stop agent',
          shortcut: '⌘.',
          run: () => dispatch('cove:command-stop-agent')
        },
        {
          id: 'cmd.open-simulator',
          label: 'Open simulator',
          run: () => dispatch('cove:command-open-simulator')
        },
        {
          id: 'cmd.toggle-board',
          label: 'Toggle todo board',
          keywords: 'todo tasks',
          run: () => dispatch('cove:command-toggle-board')
        }
      )
    }
    return items
  }, [currentWorkspace, currentChatId])

  const navigateCommands = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = []
    if (currentWorkspace) {
      items.push(
        {
          id: 'nav.files',
          label: 'Files',
          run: () => useStore.getState().toggleFiles(currentWorkspace.id)
        },
        {
          id: 'nav.browser',
          label: 'Browser',
          run: () => useStore.getState().toggleBrowser(currentWorkspace.id)
        }
      )
    }
    items.push(
      { id: 'nav.settings', label: 'Settings', run: () => dispatch('cove:open-settings') },
      { id: 'nav.skills', label: 'Skills', run: () => dispatch('cove:open-skills') },
      { id: 'nav.routines', label: 'Routines', run: () => dispatch('cove:open-routines') },
      {
        id: 'nav.dashboard',
        label: 'Computer',
        keywords: 'dashboard',
        run: () => dispatch('cove:open-dashboard')
      }
    )
    return items
  }, [currentWorkspace])

  // Recency for "Recent": chats carry their own updatedAt; a project's is the
  // newest of its own chats, so an active-but-chatless project never outranks
  // one you were just in.
  const projectRecency = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of allChats) m.set(c.workspaceId, Math.max(m.get(c.workspaceId) ?? 0, c.updatedAt))
    return m
  }, [allChats])

  const recentItems = useMemo<PaletteItem[]>(() => {
    const chatEntries = allChats.map((c) => ({
      updatedAt: c.updatedAt,
      item: {
        id: `recent.chat.${c.id}`,
        label: c.title || 'New chat',
        subtitle: projectNames.get(c.workspaceId),
        run: () => {
          useStore.getState().setActive(c.workspaceId)
          useStore.getState().selectChat(c.workspaceId, c.id)
        }
      } as PaletteItem
    }))
    const projectEntries = workspaces
      .filter((w) => projectRecency.has(w.id))
      .map((w) => ({
        updatedAt: projectRecency.get(w.id)!,
        item: {
          id: `recent.project.${w.id}`,
          label: w.name,
          subtitle: 'Project',
          run: () => useStore.getState().setActive(w.id)
        } as PaletteItem
      }))
    return [...chatEntries, ...projectEntries]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((e) => e.item)
  }, [allChats, workspaces, projectRecency, projectNames])

  // Everything, for search — a project or chat you haven't touched recently
  // still has to be reachable by typing its name.
  const searchableItems = useMemo<PaletteItem[]>(() => {
    const projects = workspaces.map((w) => ({
      id: `project.${w.id}`,
      label: w.name,
      subtitle: 'Project',
      run: () => useStore.getState().setActive(w.id)
    }))
    const chatItems = allChats.map((c) => ({
      id: `chat.${c.id}`,
      label: c.title || 'New chat',
      subtitle: projectNames.get(c.workspaceId),
      run: () => {
        useStore.getState().setActive(c.workspaceId)
        useStore.getState().selectChat(c.workspaceId, c.id)
      }
    }))
    return [...currentChatCommands, ...navigateCommands, ...projects, ...chatItems]
  }, [currentChatCommands, navigateCommands, workspaces, allChats, projectNames])

  const groups = useMemo<Group[]>(() => {
    if (!query.trim()) {
      return [
        { title: 'Recent', items: recentItems },
        { title: 'Current chat', items: currentChatCommands },
        { title: 'Navigate', items: navigateCommands }
      ].filter((g) => g.items.length > 0)
    }
    const ranked = fuzzyFilter(searchableItems, query, (i) => `${i.label} ${i.keywords ?? ''}`)
    return ranked.length ? [{ title: 'Results', items: ranked }] : []
  }, [query, recentItems, currentChatCommands, navigateCommands, searchableItems])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  // Clamped at read time rather than written back with setState-in-an-effect:
  // the list shrinks on every keystroke that narrows the results, and state
  // that chases a derived value one render behind is exactly what a plain
  // derivation avoids.
  const activeIndex = flat.length === 0 ? 0 : Math.min(selected, flat.length - 1)

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const run = (item: PaletteItem): void => {
    item.run()
    onClose()
  }

  return createPortal(
    <div
      className="cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="cmdk-panel">
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Search projects, chats, and commands…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelected(Math.min(activeIndex + 1, flat.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelected(Math.max(activeIndex - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const item = flat[activeIndex]
              if (item) run(item)
            }
          }}
        />
        <div className="cmdk-list" ref={listRef}>
          {flat.length === 0 && <div className="cmdk-empty">No matches</div>}
          {groups.map((g) => (
            <div className="cmdk-section" key={g.title}>
              <div className="cmdk-section-label">{g.title}</div>
              {g.items.map((item) => {
                const idx = flat.indexOf(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-idx={idx}
                    className={`cmdk-item${idx === activeIndex ? ' active' : ''}`}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => run(item)}
                  >
                    <span className="cmdk-item-label">{item.label}</span>
                    {item.subtitle && <span className="cmdk-item-subtitle">{item.subtitle}</span>}
                    {item.shortcut && <span className="cmdk-item-shortcut">{item.shortcut}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
