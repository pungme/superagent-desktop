import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserChoice } from '../../../preload'

/**
 * "Bring sign-ins over": tick the sites whose logins the agent's browser should
 * get from the everyday one (main/sign-ins.ts). Only those come over — the point
 * of the separate profile is that email and bank logins stay out of reach.
 */
export function SignInsDialog({
  browser,
  name,
  onClose
}: {
  browser: Exclude<BrowserChoice, 'builtin'>
  name: string
  onClose: () => void
}): React.JSX.Element {
  const [sites, setSites] = useState<{ site: string; count: number }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string[] | null>(null)

  useEffect(() => {
    void window.cove.browsersSites(browser).then((r) => {
      if (r.ok) setSites(r.sites ?? [])
      else setError(r.error ?? 'Could not read your sign-ins.')
    })
  }, [browser])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (sites ?? []).filter((s) => !q || s.site.includes(q))
  }, [sites, filter])

  const toggle = (site: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(site)) next.delete(site)
      else next.add(site)
      return next
    })

  const bring = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.cove.browsersImport(browser, [...picked])
    setBusy(false)
    if (r.ok) setDone(r.sites ?? [])
    else setError(r.error ?? 'Could not bring the sign-ins over.')
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="new-project signins" role="dialog" aria-label="Bring sign-ins over">
        <h2 className="new-project-title">Bring sign-ins over from your {name}</h2>
        {done ? (
          <>
            <p className="new-project-sub">
              {done.length > 0
                ? `The agent’s ${name} is now signed in to ${done.join(', ')}.`
                : 'Nothing to bring over for those sites.'}
            </p>
            <div className="signins-actions">
              <button className="signins-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="new-project-sub">
              Only the sites you tick come over. Everything else, like your email and bank, stays in
              your everyday {name}.
            </p>
            {sites && sites.length > 0 && (
              <input
                className="signins-filter"
                placeholder="Filter sites"
                value={filter}
                autoFocus
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            <div className="signins-list">
              {!sites && !error && <div className="signins-note">Reading your sign-ins…</div>}
              {sites && sites.length === 0 && (
                <div className="signins-note">No sign-ins found in your {name}.</div>
              )}
              {shown.map((s) => (
                <label key={s.site} className="signins-row">
                  <input
                    type="checkbox"
                    checked={picked.has(s.site)}
                    onChange={() => toggle(s.site)}
                  />
                  <span>{s.site}</span>
                </label>
              ))}
            </div>
            {error && <div className="signins-error">{error}</div>}
            <div className="signins-actions">
              <button className="signins-cancel" onClick={onClose}>
                Cancel
              </button>
              <button
                className="signins-primary"
                disabled={picked.size === 0 || busy}
                onClick={() => void bring()}
              >
                {busy
                  ? 'Bringing over…'
                  : `Bring over${picked.size > 0 ? ` ${picked.size} site${picked.size > 1 ? 's' : ''}` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
