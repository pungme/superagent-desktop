import type { AgentProvider } from '../../../shared/agent-provider'

/**
 * The mark for each agent, so you can see at a glance which backend a chat runs
 * on — in the picker and on the selected pill.
 *
 * Deliberately the brand marks, not our own icon: the point is instant "this is
 * Claude / this is OpenAI" recognition. Claude is Anthropic's sunburst in its
 * rust orange; Codex is OpenAI's blossom. Both are drawn inline so they inherit
 * crispness at any size and need no asset pipeline.
 */
export function ProviderLogo({
  provider,
  size = 14
}: {
  provider: AgentProvider
  size?: number
}): React.JSX.Element {
  if (provider === 'codex') {
    // OpenAI blossom.
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        style={{ flex: '0 0 auto' }}
      >
        <path
          fill="currentColor"
          d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-3.99 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9 5.98 5.98 0 0 0 4.51 2.01 6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 3.99-2.9 6.05 6.05 0 0 0-.75-7.07zM13.5 21.1a4.49 4.49 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.78.78 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.06v5.58a4.5 4.5 0 0 1-4.49 4.49zM3.84 16.97a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.78.78 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.07l-4.83 2.79a4.5 4.5 0 0 1-6.14-1.65zM2.58 7.83a4.49 4.49 0 0 1 2.34-1.97v5.68a.78.78 0 0 0 .39.68l5.83 3.36-2.02 1.17a.07.07 0 0 1-.07 0l-4.83-2.79a4.5 4.5 0 0 1-1.65-6.14zm16.6 3.86-5.84-3.37 2.02-1.17a.07.07 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.78.78 0 0 0-.4-.67zm2.01-3.03-.14-.09-4.77-2.77a.78.78 0 0 0-.79 0L9.66 9.17V6.84a.07.07 0 0 1 .03-.07l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.56 12.83l-2.02-1.17a.07.07 0 0 1-.04-.06V6.02a4.5 4.5 0 0 1 7.37-3.45l-.14.08L8.95 5.4a.78.78 0 0 0-.39.68zm1.1-2.36L12.26 8.97l2.6 1.5v3l-2.6 1.5-2.6-1.5z"
        />
      </svg>
    )
  }
  // Claude — Anthropic sunburst, in its rust orange.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: '0 0 auto' }}>
      <g fill="none" stroke="#d97757" strokeWidth="2.1" strokeLinecap="round">
        <line x1="12" y1="4" x2="12" y2="20" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="6.3" y1="6.3" x2="17.7" y2="17.7" />
        <line x1="17.7" y1="6.3" x2="6.3" y2="17.7" />
      </g>
    </svg>
  )
}
