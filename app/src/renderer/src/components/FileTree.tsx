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
    const parts = p.split('/')
    let node = root
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1
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
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return '🖼'
  if (['md', 'mdx', 'txt'].includes(ext)) return '📄'
  if (['json', 'yml', 'yaml', 'toml'].includes(ext)) return '⚙'
  if (['css', 'scss', 'less'].includes(ext)) return '🎨'
  return '›'
}

export function FileTree({ cwd, workspaceId }: FileTreeProps): React.JSX.Element {
  const [paths, setPaths] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

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

  const tree = useMemo(() => buildTree(paths), [paths])

  const toggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const reference = (relPath: string): void => {
    const s = useStore.getState()
    const text = `@${relPath} `
    if (s.easyMode) {
      window.dispatchEvent(
        new CustomEvent('cove:insert-reference', { detail: { workspaceId, text } })
      )
    } else {
      const ptyId = s.ptyIds[workspaceId]
      if (ptyId) window.cove.ptyWrite(ptyId, text)
    }
  }

  const rows: React.JSX.Element[] = []
  const render = (nodes: TreeNode[], depth: number): void => {
    for (const node of nodes) {
      const pad = { paddingLeft: `${8 + depth * 14}px` }
      if (node.dir) {
        const open = expanded.has(node.path)
        rows.push(
          <button
            key={node.path}
            className="file-tree-row file-tree-dir"
            style={pad}
            onClick={() => toggle(node.path)}
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
            className="file-tree-row file-tree-file"
            style={pad}
            onClick={() => reference(node.path)}
            title={`Reference ${node.path} in your message`}
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
    <div className="file-tree">
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
