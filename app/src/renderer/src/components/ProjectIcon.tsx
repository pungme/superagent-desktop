import { useState } from 'react'
import type { ProjectIconState } from '../hooks/useProjectIcon'

export function KindIcon({ kind, size = 15 }: { kind: string; size?: number }): React.JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (kind === 'browser') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M1.8 8h12.4" />
        <ellipse cx="8" cy="8" rx="3" ry="6.2" />
      </svg>
    )
  }
  if (kind === 'screenplay') {
    return (
      <svg {...common}>
        <path d="M2 5.2 3.6 2h9.2c.8 0 1.2.8.8 1.4L12 6.4" />
        <rect x="2" y="6.4" width="12" height="7.6" rx="0.8" />
        <path d="M2 9.8h12" />
      </svg>
    )
  }
  if (kind === 'design') {
    return (
      <svg {...common}>
        <path d="M9.5 2.5 13.5 6.5 6 14H2v-4L9.5 2.5z" />
        <path d="M7.8 4.2 11.8 8.2" />
      </svg>
    )
  }
  if (kind === 'music') {
    return (
      <svg {...common}>
        <circle cx="4.3" cy="11.7" r="2" />
        <circle cx="11.3" cy="10.2" r="2" />
        <path d="M6.3 11.7V3.6L13.3 2v8.2" />
      </svg>
    )
  }
  if (kind === 'documents') {
    return (
      <svg {...common}>
        <path d="M4 1.8h5.4L12 4.4V14a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6z" />
        <path d="M5.6 7h4.8M5.6 9.4h4.8M5.6 11.8h3" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M2 4.6c0-.6.4-1 1-1h2.9l1.4 1.6H13c.6 0 1 .4 1 1v5.2c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.6z" />
    </svg>
  )
}

export function ProjectIcon({
  icon,
  kind,
  size = 18
}: {
  icon: ProjectIconState
  kind: string
  size?: number
}): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const [seenIcon, setSeenIcon] = useState(icon)
  if (seenIcon !== icon) {
    setSeenIcon(icon)
    if (broken) setBroken(false)
  }
  if (icon && icon.source !== 'kind' && !broken) {
    return (
      <img
        className="sidebar-favicon"
        src={icon.dataUri}
        alt=""
        style={size !== 18 ? { width: size, height: size } : undefined}
        // A picked/detected file that fails to render falls back to the plain glyph.
        onError={() => setBroken(true)}
      />
    )
  }
  return <KindIcon kind={icon && icon.source === 'kind' ? icon.kind : kind} size={size} />
}
