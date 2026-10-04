import { useEffect, useRef, useState } from 'react'
import type { Account } from '../../../preload'
import { useStore } from '../state'
import { AGENT_PROVIDERS, PROVIDER_LABEL, type AgentProvider } from '../../../shared/agent-provider'
import { ProviderLogo } from './ProviderLogo'

/** Asked of a chat's own view: move it to this account (EasyChat restarts its agent). */
export const PICK_ACCOUNT_EVENT = 'cove:pick-account'

type Lists = Record<AgentProvider, Account[]>

/** The fullest window still running, 0–100, or null when nothing has been read. */
function fullest(a: Account | undefined): number | null {
  return fullestWindow(a)?.percent ?? null
}

/** Which window that is, so the foot can say whether it is the 5-hour or the week. */
function fullestWindow(a: Account | undefined): { label: string; percent: number } | null {
  const now = Date.now()
  const live = (a?.usage?.windows ?? []).filter((w) => !w.resetsAt || w.resetsAt > now)
  if (!live.length) return null
  return live.reduce((m, w) => (w.percent > m.percent ? w : m))
}

/** "5h" or "Week": short enough for the foot of the sidebar. */
const shortWindow = (label: string): string =>
  label === '5-hour' ? '5h' : label === 'Weekly' ? 'Week' : label.replace(/ weekly$/, ' week')

const level = (pct: number | null): string =>
  pct === null ? '' : pct >= 90 ? 'high' : pct >= 75 ? 'warn' : ''

/**
 * How much of the allowance is used, at the foot of the sidebar: the account
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
    closeTimer.current = window.setTimeout(() => setOpen(false), 180)
  }
  const pick = (a: Account): void => {
    if (!chatId || !workspaceId || a.id === current.id || a.provider !== provider) return
    window.dispatchEvent(
      new CustomEvent(PICK_ACCOUNT_EVENT, { detail: { chatId, accountId: a.id } })
    )
    setOpen(false)
  }

  return (
    <div className="usage-footer" onMouseEnter={show} onMouseLeave={hide}>
      <button
        className={`usage-footer-btn ${open ? 'open' : ''}`}
        onClick={() => (open ? setOpen(false) : show())}
        title="How much of your allowance is used"
      >
        <ProviderLogo provider={current.provider} size={12} />
        <span className="usage-footer-name">{current.name.replace(/^Your (.*) login$/, '$1')}</span>
        <span className={`usage-footer-bar ${level(pct)}`} aria-hidden>
          <i style={{ width: `${pct ?? 0}%` }} />
        </span>
        <span className={`usage-footer-pct ${level(pct)}`}>{pct === null ? '—' : `${pct}%`}</span>
        {which && <span className="usage-footer-which">{shortWindow(which.label)}</span>}
      </button>
      {open && lists && (
        <div className="usage-popover" role="menu">
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
                return (
                  <button
                    key={a.id}
                    role="menuitem"
                    className={`usage-popover-row ${here ? 'on' : ''}`}
                    disabled={!can}
                    onClick={() => pick(a)}
                    title={
                      here
                        ? 'This chat runs on this account'
                        : can
                          ? 'Move this chat to this account'
                          : undefined
                    }
                  >
                    <span className="usage-popover-name">
                      {here && <span className="usage-popover-tick">✓</span>}
                      {a.name}
                    </span>
                    <span className="usage-popover-windows">
                      {a.needsAuth
                        ? 'needs sign-in'
                        : a.usage
                          ? a.usage.windows.map((w) => {
                              const v = w.resetsAt && w.resetsAt <= Date.now() ? 0 : w.percent
                              return (
                                <span key={w.label} className={`usage-popover-window ${level(v)}`}>
                                  {w.label} <b>{v}%</b>
                                </span>
                              )
                            })
                          : 'not read yet'}
                    </span>
                  </button>
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
