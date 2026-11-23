import { useEffect, useRef } from 'react'
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewOptionsCtx,
  remarkStringifyOptionsCtx
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm, remarkGFMPlugin } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { getMarkdown, replaceAll } from '@milkdown/kit/utils'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'

/** A table's rule row as most files write it: |---|:---:| rather than | - | :-: |. */
function tidy(markdown: string): string {
  return markdown.replace(/^\|(?: *:?-+:? *\|)+ *$/gm, (row) =>
    row
      .split('|')
      .slice(1, -1)
      .map((c) => {
        const t = c.trim()
        return (t.startsWith(':') ? ':' : '') + '---' + (t.length > 1 && t.endsWith(':') ? ':' : '')
      })
      .reduce((acc, c) => `${acc}${c}|`, '|')
  )
}

/**
 * Markdown edited as the formatted page (WYSIWYG): headings, lists, real
 * tables. The file stays plain Markdown underneath.
 *
 * Saving must not rewrite a file you did not touch. Writing Markdown back from
 * the document normalises it (list markers, table padding), so this only
 * reports a change once the document really differs from what was loaded, and
 * reports the original text again if you undo back to it.
 */
export function MarkdownWysiwyg({
  value,
  onChange,
  onSave,
  onBlur
}: {
  value: string
  onChange: (markdown: string) => void
  onSave: () => void
  onBlur: () => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  /** The text it was loaded with, and that text as the editor writes it back. */
  const loaded = useRef({ raw: value, normalised: value })
  /** The last text reported up, so a value coming back down is not reloaded. */
  const reported = useRef(value)
  /** Loading new text in is not an edit. */
  const quiet = useRef(false)
  const cb = useRef({ onChange, onSave, onBlur })
  useEffect(() => {
    cb.current = { onChange, onSave, onBlur }
  })

  useEffect(() => {
    const root = host.current
    if (!root) return
    let alive = true
    const made = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, loaded.current.raw)
        // Write Markdown the way people (and agents) usually write it, so a
        // save changes the lines you edited and little else: - bullets, ---
        // rules, * for emphasis, and tables without padding every column.
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({
          ...prev,
          bullet: '-' as const,
          rule: '-' as const,
          emphasis: '*' as const,
          strong: '*' as const
        }))
        ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false })
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { class: 'md fv-wysiwyg-doc', spellcheck: 'true' }
        }))
        ctx.get(listenerCtx).markdownUpdated((_ctx, written) => {
          if (quiet.current) return
          const markdown = tidy(written)
          const next = markdown === loaded.current.normalised ? loaded.current.raw : markdown
          if (next === reported.current) return
          reported.current = next
          cb.current.onChange(next)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(listener)
    made.create().then((ed) => {
      if (!alive) {
        void ed.destroy()
        return
      }
      editor.current = ed
      loaded.current.normalised = tidy(ed.action(getMarkdown()))
    })
    return () => {
      alive = false
      void editor.current?.destroy()
      editor.current = null
    }
  }, [])

  // New text from outside (an agent changed the file, or you took its version).
  useEffect(() => {
    const ed = editor.current
    if (!ed || value === reported.current) return
    quiet.current = true
    try {
      ed.action(replaceAll(value))
      loaded.current = { raw: value, normalised: tidy(ed.action(getMarkdown())) }
      reported.current = value
    } finally {
      // The listener reports after a short debounce; stay quiet past it.
      setTimeout(() => (quiet.current = false), 300)
    }
  }, [value])

  return (
    <div
      className="fv-wysiwyg"
      ref={host}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          cb.current.onSave()
        }
      }}
      onBlur={() => cb.current.onBlur()}
    />
  )
}
