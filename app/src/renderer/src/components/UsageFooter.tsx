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

/** When a window starts over, short: "11 PM", "4:30 PM", "Sat 8 AM". */
function shortReset(at: number, now: number): string {
  return resetLabel(at, now)
    .replace(/:00(?=\s?[AP]M)/i, '')
    .replace(/:00$/, '')
}

interface RowState {
  used: number | null
  out: boolean
  reset: number | null
}

const level = (pct: number | null): string =>
  pct === null ? '' : pct >= 90 ? 'high' : pct >= 75 ? 'warn' : ''

/**
 * How much of the allowance is used, at the foot of the sidebar: the account
 * the chat on screen is on (or, with none, the one a new chat would start on),
 * and on hover every account connected, one line each. The foot of the list
 * shows the limits of the row under the pointer (else this chat's account).
 * Clicking another account of the same agent moves the chat to it; one that is
 * out or signed out says why instead.
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
  /** The row under the pointer or the keyboard: the details at the foot follow it. */
  const [previewId, setPreview] = useState<string | null>(null)
  // "Now" for what is out and when it resets: read when the list opens or the
  // numbers change, not on every render.
  const [now, setNow] = useState(() => Date.now())
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
        setNow(Date.now())
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
    if (!open) {
      void window.cove.accountsRefreshUsage()
      setNow(Date.now())
    }
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
  /** What the list says about one account: how much is used, and whether it is out. */
  const state = (a: Account): RowState => {
    const limit = fullestWindow(a)
    const used = limit ? Math.min(100, Math.max(0, Math.round(limit.percent))) : null
    const out = (limit !== null && limit.percent >= 100) || (a.limitedUntil ?? 0) > now
    const reset =
      a.limitedUntil && a.limitedUntil > now ? a.limitedUntil : (limit?.resetsAt ?? null)
    return { used, out, reset }
  }
  // Out or signed out can't take the chat: the row says why rather than failing.
  const canPick = (a: Account, s: RowState): boolean =>
    !!chatId && a.provider === provider && a.id !== current.id && !a.needsAuth && !s.out
  /** Why an account can't take this chat, in a few words; null when it can (or is it). */
  const why = (a: Account, s: RowState): string | null => {
    if (a.id === current.id) return null
    if (a.needsAuth) return 'Sign in under Settings → Agents'
    if (s.out)
      return s.reset ? `Out of allowance until ${shortReset(s.reset, now)}` : 'Out of allowance'
    if (!chatId) return 'Open a chat to switch to it'
    if (a.provider !== provider) return `This chat runs on ${PROVIDER_LABEL[provider]}`
    return null
  }
  const shown = lists
    ? AGENT_PROVIDERS.filter((p) =>
        lists[p].some((a) => a.usage || a.kind !== 'login' || p === provider)
      )
    : []
  const everyone = lists ? shown.flatMap((p) => lists[p]) : []
  const detail = everyone.find((a) => a.id === previewId) ?? current
  // The details keep the height of the longest, so the rows above never move
  // under the pointer as it passes from one account to the next.
  const rows = Math.max(1, ...everyone.map((a) => a.usage?.windows.length ?? 0))

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
        // Which limit the figure is (5-hour or week) is said here and in the
        // list: a word more at the foot squeezed the account's name to a letter.
        title={`${which ? `${which.label} usage` : 'Usage'} — hover for every account, click to keep open`}
      >
        <ProviderLogo provider={current.provider} size={12} />
        <span className="usage-footer-name">{current.name.replace(/^Your (.*) login$/, '$1')}</span>
        <span className={`usage-footer-bar ${level(pct)}`} aria-hidden>
          <i style={{ width: `${pct === null ? 0 : Math.min(100, Math.round(pct))}%` }} />
        </span>
        <span className={`usage-footer-pct ${level(pct)}`}>
          {pct === null ? '—' : `${Math.min(100, Math.round(pct))}%`}
        </span>
      </button>
      {open && lists && (
        <div className="usage-popover" role="region" aria-label="Account allowance">
          {shown.map((p) => (
            <div key={p} className="usage-popover-group">
              <div className="usage-popover-head">
                <ProviderLogo provider={p} size={12} />
                {PROVIDER_LABEL[p]}
              </div>
              {lists[p].map((a) => {
                const s = state(a)
                const here = a.id === current.id
                const can = canPick(a, s)
                return (
                  <button
                    key={a.id}
                    className={`usage-popover-row ${here ? 'on' : ''} ${can ? 'can' : ''} ${
                      s.out ? 'out' : ''
                    } ${previewId === a.id ? 'seen' : ''}`}
                    aria-disabled={!can}
                    aria-current={here || undefined}
                    title={can ? undefined : (why(a, s) ?? undefined)}
                    onMouseEnter={() => setPreview(a.id)}
                    onMouseLeave={() => setPreview(null)}
                    onFocus={() => setPreview(a.id)}
                    onBlur={() => setPreview(null)}
                    onClick={() => can && pick(a)}
                  >
                    <span className="usage-popover-tick" aria-hidden>
                      {here ? '✓' : ''}
                    </span>
                    <span className="usage-popover-name">{a.name}</span>
                    <span className="usage-popover-status">
                      {a.needsAuth ? (
                        <span className="usage-popover-quiet">Needs sign-in</span>
                      ) : s.out ? (
                        <span className="usage-popover-quiet">
                          {s.reset ? `Resets ${shortReset(s.reset, now)}` : 'Out for now'}
                        </span>
                      ) : s.used === null ? (
                        <span className="usage-popover-quiet">—</span>
                      ) : (
                        <>
                          <span className={`usage-popover-bar ${level(s.used)}`} aria-hidden>
                            <i style={{ width: `${s.used}%` }} />
                          </span>
                          <span className="usage-popover-pct">{s.used}%</span>
                        </>
                      )}
                    </span>
                    {can && <span className="usage-account-switch">Use for this chat</span>}
                  </button>
                )
              })}
            </div>
          ))}
          {detail && (
            <div className="usage-popover-details" aria-live="polite">
              <div className="usage-popover-detail-head">
                <span className="usage-popover-detail-name">{detail.name}</span>
                {why(detail, state(detail)) && (
                  <span className="usage-popover-detail-why">{why(detail, state(detail))}</span>
                )}
              </div>
              <div className="usage-popover-windows" style={{ minHeight: rows * 18 }}>
                {detail.usage?.windows.length ? (
                  detail.usage.windows.map((w) => {
                    const over = !!w.resetsAt && w.resetsAt <= now
                    const v = over ? 0 : Math.min(100, Math.max(0, Math.round(w.percent)))
                    return (
                      <div key={w.label} className={`usage-popover-window ${level(v)}`}>
                        <span className="usage-popover-window-label">{w.label}</span>
                        <span className="usage-popover-bar" aria-hidden>
                          <i style={{ width: `${v}%` }} />
                        </span>
                        <b>{v}% used</b>
                        <span className="usage-popover-reset">
                          {w.resetsAt && !over ? shortReset(w.resetsAt, now) : ''}
                        </span>
                      </div>
                    )
                  })
                ) : (
                  <span className="usage-popover-empty">
                    {detail.needsAuth ? detail.needsAuth : 'Usage not read yet'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
