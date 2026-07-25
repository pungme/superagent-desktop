import { useState, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'

function CodeBlock({ code, lang }: { code: string; lang?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const highlighted = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      }
      return hljs.highlightAuto(code).value
    } catch {
      return null
    }
  }, [code, lang])

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

/** Renders assistant text as GitHub-flavored markdown, with copyable code blocks. */
export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const raw = String(children).replace(/\n$/, '')
            // Fenced blocks contain a newline or carry a language; inline code stays inline.
            const isBlock = match || raw.includes('\n')
            if (isBlock) return <CodeBlock code={raw} lang={match?.[1]} />
            return (
              <code className="md-inline-code" {...props}>
                {children}
              </code>
            )
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
