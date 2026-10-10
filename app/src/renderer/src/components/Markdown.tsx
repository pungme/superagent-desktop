import { useEffect, useState, useMemo, memo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
// Core + a curated language set keeps the bundle small vs. the full 190-language build.
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, lang] of Object.entries({
  javascript,
  typescript,
  python,
  bash,
  json,
  xml,
  css,
  markdown,
  go,
  rust,
  java,
  sql,
  yaml
})) {
  hljs.registerLanguage(name, lang)
}
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['html'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })

function CodeBlock({
  code,
  lang,
  streaming
}: {
  code: string
  lang?: string
  streaming?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    window.cove.clipboardWrite(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const highlighted = useMemo(() => {
    // While the message is still streaming, `code` grows every frame — and
    // highlightAuto (which tries every registered language) re-ran on the whole
    // growing block each time, a top CPU cost whenever the agent streams code.
    // Plain text until the block settles; one real highlight at the end.
    if (streaming) return null
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      }
      return hljs.highlightAuto(code).value
    } catch {
      return null
    }
  }, [code, lang, streaming])

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'code'}</span>
        <button className="md-code-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {highlighted ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  )
}

const isWebImage = (src: string): boolean => /^(https?|data|blob):/i.test(src)

/**
 * An image in a reply. A web address loads as it is; a file on this Mac — what
 * an agent means by "here are the screenshots" — is read by main and shown the
 * same way. The window cannot point an <img> at a path on disk itself.
 */
function MdImage({
  src,
  alt,
  baseDir,
  onImage
}: {
  src: string
  alt: string
  baseDir?: string
  /** The picture as shown, and what the agent wrote for it: the file to save. */
  onImage?: (src: string, origin?: string) => void
}): React.JSX.Element | null {
  const web = isWebImage(src)
  const [local, setLocal] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (web) return
    let alive = true
    void window.cove
      .fileThumbnail(src, { base: baseDir, width: 1600 })
      .then((r) => {
        if (alive) setLocal(r ? `data:${r.mediaType};base64,${r.data}` : null)
      })
      .catch(() => {
        if (alive) setLocal(null)
      })
    return () => {
      alive = false
    }
  }, [src, baseDir, web])
  const shown = web ? src : local
  if (shown === undefined) return <span className="md-img-loading" aria-hidden="true" />
  // Not a picture we could read: say which, rather than a broken-image icon.
  if (shown === null)
    return (
      <span className="md-img-missing" title={src}>
        🖼 {alt || src.split('/').pop()}
      </span>
    )
  if (!onImage) return <img className="md-img" src={shown} alt={alt} />
  return (
    <button
      className="md-img-thumb"
      onClick={() => onImage(shown, src)}
      title={alt ? `${alt} — click to enlarge` : 'Click to enlarge'}
    >
      <img src={shown} alt={alt} />
    </button>
  )
}

/** Renders assistant text as GitHub-flavored markdown, with copyable code blocks. */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  onImage,
  baseDir
}: {
  /** The chat's folder: where a relative image path in a reply is looked for. */
  baseDir?: string
  text: string
  /** The bubble is still receiving tokens — defer expensive syntax highlight. */
  streaming?: boolean
  /** Show images as a small thumbnail that calls this with the full image —
   *  the chat's lightbox. Without it (a file viewer) they render full width. */
  onImage?: (src: string, origin?: string) => void
}): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // The default drops file:// and bare paths from image sources; those are
        // exactly the ones MdImage reads from disk. Links keep the safe default.
        urlTransform={(url, key) => (key === 'src' ? url : defaultUrlTransform(url))}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const raw = String(children).replace(/\n$/, '')
            // Fenced blocks contain a newline or carry a language; inline code stays inline.
            const isBlock = match || raw.includes('\n')
            if (isBlock) return <CodeBlock code={raw} lang={match?.[1]} streaming={streaming} />
            return (
              <code className="md-inline-code" {...props}>
                {children}
              </code>
            )
          },
          // A screenshot in a reply used to fill the whole bubble width, pushing
          // the text around it apart. In the chat it is a preview; the click
          // opens it full size.
          img({ src, alt }) {
            if (typeof src !== 'string' || !src) return null
            return <MdImage src={src} alt={alt ?? ''} baseDir={baseDir} onImage={onImage} />
          },
          a({ children, href }) {
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
