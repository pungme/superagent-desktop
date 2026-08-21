import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../state'

interface FileTreeProps {
  cwd: string
  workspaceId: string
}

interface TreeNode {
  name: string
  path: string // relative to cwd
  dir: boolean
  children: TreeNode[]
}

/** Assemble a nested tree from the flat, sorted list of relative file paths. */
function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] }
  for (const p of paths) {
    // A trailing slash means the listing named this directory itself, rather
    // than us inferring it from a file inside — which is what lets a folder
    // whose contents were beyond the listing's budget still show up.
    const isDirEntry = p.endsWith('/')
    const parts = (isDirEntry ? p.slice(0, -1) : p).split('/')
    let node = root
    parts.forEach((part, i) => {
      const isFile = !isDirEntry && i === parts.length - 1
      let child = node.children.find((c) => c.name === part && c.dir === !isFile)
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), dir: !isFile, children: [] }
        node.children.push(child)
      }
      node = child
    })
  }
  const sort = (n: TreeNode): void => {
    // Folders first, then files; each group alphabetical.
    n.children.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)))
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}

function fileIcon(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'].includes(ext)) return '🖼'
  if (['pdf'].includes(ext)) return '📕'
  if (['md', 'mdx', 'txt'].includes(ext)) return '📄'
  if (['json', 'yml', 'yaml', 'toml', 'ini', 'conf'].includes(ext)) return '⚙'
  if (['css', 'scss', 'less'].includes(ext)) return '🎨'
  if (['zip', 'tar', 'gz', 'dmg'].includes(ext)) return '🗜'
  // Never '›' — a chevron here is indistinguishable from a collapsed-folder caret.
  return '📄'
}

/** Absolute paths of files dragged in from Finder (empty for in-app drags). */
function droppedPaths(e: React.DragEvent): string[] {
  return Array.from(e.dataTransfer.files)
    .map((f) => window.cove.getPathForFile(f))
    .filter(Boolean)
}

export function FileTree({ cwd, workspaceId }: FileTreeProps): React.JSX.Element {
  const openPath = useStore((s) => s.openPath)
  const [paths, setPaths] = useState<string[]>([])
  // Which folders are open, remembered per project. Reopening Files (or
  // restarting) puts you back where you were instead of fully collapsed.
  const expandKey = `fileTree:expanded:${workspaceId}`
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(expandKey)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const [loading, setLoading] = useState(true)
  // Finder drag hovering the tree ('' = root) or a specific folder row.
  const [dropDir, setDropDir] = useState<string | null>(null)

  // The file open in the viewer (per active chat) — so the tree can highlight it
  // and auto-reveal the folders leading to it. Path is relative to cwd, matching
  // the node paths.
  const openAbs = useStore((s) => s.openFile[s.activeChatId[workspaceId] ?? workspaceId] ?? '')
  const openRel = openAbs && openAbs.startsWith(`${cwd}/`) ? openAbs.slice(cwd.length + 1) : ''
  const openAncestors = useMemo(() => {
    const set = new Set<string>()
    if (!openRel) return set
    const parts = openRel.split('/')
    parts.pop() // drop the file name; keep the folders above it
    let acc = ''
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p
      set.add(acc)
    }
    return set
  }, [openRel])

  const load = useCallback(() => {
    // `loading` starts true, so we don't set it synchronously here (that would
    // fire a setState inside the mount effect); we only clear it when done.
    window.cove
      .filesList(cwd)
      .then((list) => setPaths(list))
      .finally(() => setLoading(false))
  }, [cwd])

  useEffect(() => {
    load()
    // Refresh when Claude finishes a turn (files may have changed).
    const onIdle = (e: Event): void => {
      const detail = (e as CustomEvent).detail
      if (detail?.workspaceId === workspaceId) load()
    }
    window.addEventListener('cove:workspace-idle', onIdle)
    return () => window.removeEventListener('cove:workspace-idle', onIdle)
  }, [load, workspaceId])

  // The tree is for browsing, so dotfiles (.DS_Store, .claude, .gitignore) stay out
  // of it. @-mention completion reads the unfiltered list, so they're still reachable.
  const tree = useMemo(
    () => buildTree(paths.filter((p) => !p.split('/').some((seg) => seg.startsWith('.')))),
    [paths]
  )

  const importTo = async (relDir: string, e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDropDir(null)
    const sources = droppedPaths(e)
    if (!sources.length) return
    const dest = relDir ? `${cwd}/${relDir}` : cwd
    await window.cove.filesImport(dest, sources)
    load()
  }

  const toggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      try {
        localStorage.setItem(expandKey, JSON.stringify([...next]))
      } catch {
        /* storage disabled — expansion just won't persist */
      }
      return next
    })

  // Routing (text → in-app viewer, PDF/image → pane, else → OS) lives in the store
  // so the agent's open_file tool opens files exactly the same way.
  const open = (relPath: string): void => openPath(workspaceId, `${cwd}/${relPath}`)

  const rows: React.JSX.Element[] = []
  const render = (nodes: TreeNode[], depth: number): void => {
    for (const node of nodes) {
      const pad = { paddingLeft: `${8 + depth * 14}px` }
      if (node.dir) {
        // Reveal folders leading to the open file, on top of the user's own picks.
        const open = expanded.has(node.path) || openAncestors.has(node.path)
        rows.push(
          <button
            key={node.path}
            className={`file-tree-row file-tree-dir ${dropDir === node.path ? 'drop-target' : ''}`}
            style={pad}
            onClick={() => toggle(node.path)}
            onContextMenu={(e) => {
              e.preventDefault()
              window.cove.filesMenu(`${cwd}/${node.path}`)
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault()
                e.stopPropagation()
                setDropDir(node.path)
              }
            }}
            onDragLeave={() => setDropDir((d) => (d === node.path ? '' : d))}
            title={node.path}
          >
            <span className={`file-tree-caret ${open ? 'open' : ''}`}>▸</span>
            <span className="file-tree-name">{node.name}</span>
          </button>
        )
        if (open) render(node.children, depth + 1)
      } else {
        rows.push(
          <button
            key={node.path}
            className={`file-tree-row file-tree-file ${node.path === openRel ? 'selected' : ''}`}
            style={pad}
            onClick={() => open(node.path)}
            onContextMenu={(e) => {
              e.preventDefault()
              window.cove.filesMenu(`${cwd}/${node.path}`)
            }}
            title={`Open ${node.path}`}
          >
            <span className="file-tree-icon">{fileIcon(node.name)}</span>
            <span className="file-tree-name">{node.name}</span>
          </button>
        )
      }
    }
  }
  render(tree, 0)

  return (
    <div
      className={`file-tree ${dropDir === '' ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          if (dropDir === null) setDropDir('')
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropDir(null)
      }}
      onDrop={(e) => void importTo(dropDir ?? '', e)}
    >
      <div className="file-tree-header">
        <span className="file-tree-title">Files</span>
        <button className="file-tree-refresh" onClick={load} title="Refresh">
          ↻
        </button>
      </div>
      <div className="file-tree-scroll">
        {loading && paths.length === 0 ? (
          <div className="file-tree-empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="file-tree-empty">No files found.</div>
        ) : (
          rows
        )}
      </div>
    </div>
  )
}
