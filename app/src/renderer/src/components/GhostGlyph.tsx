/** The incognito mark: a ghost. */
export function GhostGlyph({ size = 12 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      className="incognito-glyph"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Incognito"
    >
      <path d="M3 14V7.5a5 5 0 0 1 10 0V14l-1.7-1.3L9.7 14 8 12.7 6.3 14l-1.6-1.3z" />
      <circle cx="6.2" cy="7.4" r=".6" fill="currentColor" />
      <circle cx="9.8" cy="7.4" r=".6" fill="currentColor" />
    </svg>
  )
}
