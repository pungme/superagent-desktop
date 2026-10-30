import { useEffect, useRef, useState } from 'react'
import type { Account } from '../../../preload'
import { useStore } from '../state'
import { AGENT_PROVIDERS, PROVIDER_LABEL, type AgentProvider } from '../../../shared/agent-provider'
import { ProviderLogo } from './ProviderLogo'
import { resetLabel } from '../../../shared/usage-reset'

/** Asked of a chat's own view: move it to this account (EasyChat restarts its agent). */
export const PICK_ACCOUNT_EVENT = 'cove:pick-account'

type Lists = Record<AgentProvider, Account[]>

/** The fullest window still running, 0–100, or null when nothing has been read. */
function fullest(a: Account | undefined): number | null {
  return fullestWindow(a)?.percent ?? null
}

/** Which window that is, so the foot can say whether it is the 5-hour or the week. */
function fullestWindow(
  a: Account | undefined
): { label: string; percent: number; resetsAt: number | null } | null {
  const now = Date.now()
  // One model's own week (Fable's) is listed, but running it out only moves a
  // chat to the next model, so it does not make the account look full.
  const live = (a?.usage?.windows ?? []).filter(
    (w) => !w.model && (!w.resetsAt || w.resetsAt > now)
  )
  if (!live.length) return null
  return live.reduce((m, w) => (w.percent > m.percent ? w : m))
}

/** "5h" or "Week": short enough for the foot of the sidebar. */
const shortWindow = (label: string): string =>
  label === '5-hour' ? '5h' : label === 'Weekly' ? 'Week' : label.replace(/ weekly$/, ' week')

const level = (pct: number | null): string =>
  pct === null ? '' : pct >= 90 ? 'high' : pct >= 75 ? 'warn' : ''

/**
 * How much of the allowance is left, at the foot of the sidebar: the account
 * the chat on screen is on (or, with none, the one a new chat would start on),
 * and on hover every account connected, each with its windows. One of the same
 * agent can be picked there to move the chat to it.
 */
export function UsageFooter(): React.JSX.Element | null {
  const workspaceId = useStore((s) => s.activeWorkspaceId)
  const chatId = useStore((s) => (s.activeWorkspaceId ? s.activeChatId[s.activeWorkspaceId] : null))
  const provider = useStore((s) =>
    s.activeWorkspaceId && chatId ? s.chatProvider(s.activeWorkspaceId, chatId) : s.provider
  )
  const [lists, setLists] = useState<Lists | null>(null)
  const [current, setCurrent] = useState<Account | null>(null)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void Promise.all([
        window.cove.accountsList(),
        window.cove.accountsForChat(provider, chatId ?? '')
      ]).then(([list, acct]) => {
        if (!alive) return
        setLists({ claude: list.claude, codex: list.codex, antigravity: list.antigravity })
        setCurrent(acct)
      })
    }
    load()
    const off = window.cove.onAccountsChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [provider, chatId])

  // Read once at launch, then every few minutes while the app is open: the
  // numbers move as you work, and nobody opens Settings to watch them.
  useEffect(() => {
    void window.cove.accountsRefreshUsage()
    const t = window.setInterval(() => void window.cove.accountsRefreshUsage(), 5 * 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
        setPinned(false)
      }
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        setPinned(false)
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [])

  if (!current) return null
  const pct = fullest(current)
  const which = fullestWindow(current)
  const show = (): void => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    if (!open) void window.cove.accountsRefreshUsage()
    setOpen(true)
  }
  const hide = (): void => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      if (!pinned) setOpen(false)
    }, 180)
  }
  const pick = (a: Account): void => {
    if (!chatId || !workspaceId || a.id === current.id || a.provider !== provider) return
    window.dispatchEvent(
      new CustomEvent(PICK_ACCOUNT_EVENT, { detail: { chatId, accountId: a.id } })
    )
    setOpen(false)
    setPinned(false)
  }

  return (
    <div ref={root} className="usage-footer" onMouseEnter={show} onMouseLeave={hide}>
      <button
        className={`usage-footer-btn ${open ? 'open' : ''}`}
        onClick={() => {
          setPinned(!pinned)
          if (pinned) setOpen(false)
          else show()
        }}
        aria-expanded={open}
        title="Allowance left — hover to preview, click to keep open"
      >
        <ProviderLogo provider={current.provider} size={12} />
        <span className="usage-footer-name">{current.name.replace(/^Your (.*) login$/, '$1')}</span>
        <span className={`usage-footer-bar ${level(pct)}`} aria-hidden>
          <i style={{ width: `${pct === null ? 0 : Math.max(0, 100 - pct)}%` }} />
        </span>
        <span className={`usage-footer-pct ${level(pct)}`}>
          {pct === null ? '—' : `${Math.max(0, 100 - pct)}% left`}
        </span>
        {which && <span className="usage-footer-which">{shortWindow(which.label)}</span>}
      </button>
      {open && lists && (
        <div className="usage-popover" role="region" aria-label="Account allowance">
          {AGENT_PROVIDERS.filter((p) =>
            lists[p].some((a) => a.usage || a.kind !== 'login' || p === provider)
          ).map((p) => (
            <div key={p} className="usage-popover-group">
              <div className="usage-popover-head">
                <ProviderLogo provider={p} size={12} />
                {PROVIDER_LABEL[p]}
              </div>
              {lists[p].map((a) => {
                const here = a.id === current.id
                const can = !!chatId && p === provider && !here && !a.needsAuth
                const limit = fullestWindow(a)
                const used = limit?.percent ?? null
                const left = used === null ? null : Math.max(0, 100 - used)
                const blocked = (used !== null && used >= 100) || (a.limitedUntil ?? 0) > Date.now()
                const reset =
                  a.limitedUntil && a.limitedUntil > Date.now() ? a.limitedUntil : limit?.resetsAt
                const details = expanded === a.id || hovered === a.id
                return (
                  <div
                    key={a.id}
                    className={`usage-popover-row ${here ? 'on' : ''}`}
                    onMouseEnter={() => setHovered(a.id)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <button
                      className="usage-account-toggle"
                      aria-expanded={details}
                      onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                    >
                      <span className="usage-popover-name">
                        {here && <span className="usage-popover-tick">✓</span>}
                        {a.name}
                      </span>
                      <span aria-hidden>{details ? '▾' : '▸'}</span>
                    </button>
                    <span
                      className={`usage-account-status ${blocked || a.needsAuth ? 'blocked' : ''}`}
                    >
                      {a.needsAuth
                        ? 'Needs sign-in'
                        : blocked
                          ? `Blocked · ${reset ? 'resets ' + resetLabel(reset, Date.now()) : 'waiting for reset'}`
                          : left === null
                            ? 'Usage not read yet'
                            : `${left}% left · ${limit?.label}`}
                    </span>
                    {left !== null && (
                      <span className={`usage-popover-window ${level(used)}`}>
                        <span className="usage-popover-bar">
                          <i style={{ width: `${left}%` }} />
                        </span>
                      </span>
                    )}
                    {details && (
                      <div className="usage-account-details">
                        <div className="usage-popover-windows">
                          {a.usage?.windows.map((w) => {
                            const now = Date.now()
                            const over = !!w.resetsAt && w.resetsAt <= now
                            const v = over ? 0 : Math.min(100, Math.max(0, w.percent))
                            return (
                              <div key={w.label} className={`usage-popover-window ${level(v)}`}>
                                <span>{w.label}</span>
                                <span className="usage-popover-bar">
                                  <i style={{ width: `${100 - v}%` }} />
                                </span>
                                <b>{100 - v}% left</b>
                                <span className="usage-popover-reset">
                                  {w.resetsAt && !over
                                    ? `resets ${resetLabel(w.resetsAt, now)}`
                                    : ''}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                        {can && (
                          <button className="usage-account-switch" onClick={() => pick(a)}>
                            Use this account
                          </button>
                        )}
                        {here && <span className="usage-popover-note">This chat’s account</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {!chatId && (
            <div className="usage-popover-note">Open a chat to move it to another account.</div>
          )}
        </div>
      )}
    </div>
  )
}
