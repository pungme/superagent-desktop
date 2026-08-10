import { useState } from 'react'
import type { ChoiceSpec } from './assistantSegments'

export function Choices({
  spec,
  onAnswer
}: {
  spec: ChoiceSpec
  onAnswer: (text: string) => void
}): React.JSX.Element {
  const multiple = !!spec.multiple
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [answered, setAnswered] = useState<string | null>(null)

  if (answered !== null) {
    return (
      <div className="easy-choices answered">
        <span className="easy-choices-check">✓</span>
        {answered}
      </div>
    )
  }

  const toggle = (label: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  const sendMulti = (): void => {
    const ans = spec.options.filter((o) => picked.has(o.label)).map((o) => o.label)
    if (!ans.length) return
    setAnswered(ans.join(', '))
    onAnswer(ans.join(', '))
  }

  return (
    <div className="easy-choices">
      {spec.question && <div className="easy-choices-q">{spec.question}</div>}
      <div className="easy-choices-opts">
        {spec.options.map((o) => (
          <button
            key={o.label}
            className={`easy-choice ${multiple && picked.has(o.label) ? 'on' : ''}`}
            onClick={() => {
              if (multiple) toggle(o.label)
              else {
                setAnswered(o.label)
                onAnswer(o.label)
              }
            }}
          >
            {multiple && (
              <span className="easy-choice-box">{picked.has(o.label) ? '☑' : '☐'}</span>
            )}
            <span className="easy-choice-label">{o.label}</span>
            {o.hint && <span className="easy-choice-hint">{o.hint}</span>}
          </button>
        ))}
      </div>
      {multiple && (
        <button className="easy-choices-send" disabled={picked.size === 0} onClick={sendMulti}>
          Send{picked.size ? ` ${picked.size}` : ''}
        </button>
      )}
    </div>
  )
}
