import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Contact, ContactEdit, FieldDef } from '../../../preload'
import {
  CONTACT_STATUSES,
  STATUS_LABEL,
  addDays,
  isDue,
  matches,
  quickContact,
  sortContacts,
  summarize,
  ymd,
  type ContactFilter,
  type ContactStatus
} from '../../../shared/contacts'

/**
 * A project's contacts: who it is reaching out to, and where each one stands.
 *
 * As little as it can be. One line on top says how things stand and is also the
 * filter; one input adds a person; each person is a line, and opens in place into
 * plain text you click to change. Colour is for two things only: what is due, and
 * a yes. The agent keeps the same list with its contacts_* tools.
 */

/** The built-in details, in the order they are offered. */
const DETAILS = [
  { key: 'email', label: 'Email' },
  { key: 'org', label: 'Who' },
  { key: 'channel', label: 'Other way' },
  { key: 'ask', label: 'Ask' },
  { key: 'followUp', label: 'Follow up' }
] as const

function shortDay(day: string, today: string): string {
  if (!day) return ''
  if (day === today) return 'Today'
  if (day === addDays(Date.parse(today + 'T12:00:00'), 1)) return 'Tomorrow'
  return new Date(day + 'T12:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' })
}

const monthDay = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''

export function ContactsPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [list, setList] = useState<Contact[]>([])
  const [defs, setDefs] = useState<FieldDef[]>([])
  const [filter, setFilter] = useState<ContactFilter>('all')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [today, setToday] = useState(() => ymd(new Date()))

  const load = useCallback(() => window.cove.contactsList(workspaceId), [workspaceId])
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void load().then((l) => alive && setList(l))
      void window.cove.contactsFields(workspaceId).then((d) => alive && setDefs(d))
    }
    read()
    const off = window.cove.onContactsChanged((p) => {
      if (p.workspaceId === workspaceId) read()
    })
    const t = setInterval(() => setToday(ymd(new Date())), 60_000)
    return () => {
      alive = false
      off()
      clearInterval(t)
    }
  }, [workspaceId, load])

  const counts = useMemo(() => summarize(list, today), [list, today])
  const shown = useMemo(
    () =>
      sortContacts(
        list.filter((c) => matches(c, filter, today, query)),
        today
      ),
    [list, filter, today, query]
  )

  const add = async (): Promise<void> => {
    const q = quickContact(draft)
    if (!q.name) return
    setDraft('')
    setFilter('all')
    setQuery('')
    const c = await window.cove.contactsAdd(workspaceId, q)
    if (c) setOpenId(c.id)
  }

  const tabs = (
    [
      { key: 'all', text: 'All', n: counts.all },
      { key: 'due', text: 'Due', n: counts.due, tone: 'due' },
      { key: 'not_sent', text: 'Not sent', n: counts.not_sent },
      { key: 'sent', text: 'Waiting', n: counts.sent },
      { key: 'replied', text: 'Replied', n: counts.replied },
      { key: 'yes', text: 'Yes', n: counts.yes },
      { key: 'no', text: 'No', n: counts.no }
    ] as { key: ContactFilter; text: string; n: number; tone?: string }[]
  ).filter((t) => t.key === 'all' || t.n > 0 || t.key === filter)

  return (
    <div className="cx" data-testid="contacts-panel">
      <div className="cx-bar">
        <div className="cx-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`cx-tab ${t.tone ?? ''} ${filter === t.key ? 'on' : ''}`}
              data-testid={t.key === 'due' ? 'contacts-due' : undefined}
              onClick={() => setFilter(filter === t.key ? 'all' : t.key)}
            >
              {t.key === 'due' ? `${t.n} due` : t.text}
              {t.key !== 'due' && <i>{t.n}</i>}
            </button>
          ))}
        </div>
        <input
          className="cx-search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="cx-addbar">
        <span className="cx-plus">+</span>
        <input
          className="cx-add"
          placeholder="Add a person — name and email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          data-testid="contact-new"
        />
      </div>

      {list.length === 0 && (
        <p className="cx-hint">
          Type a name above, or ask the agent to “put everyone in my outreach list into contacts”.
        </p>
      )}

      {list.length > 0 && (
        <div className="cx-head">
          <span>Name</span>
          <span>Status</span>
          <span>Next</span>
          <span>{defs[0]?.label ?? 'Ask'}</span>
        </div>
      )}
      <div className="cx-rows">
        {shown.map((c) => {
          const late = isDue(c, today)
          const settled = c.status === 'yes' || c.status === 'no'
          const sub = c.org || c.email || c.channel
          const extra = (defs[0] && c.fields[defs[0].key]) || (defs[0] ? '' : c.ask)
          const isOpen = openId === c.id
          return (
            <div key={c.id} className={`cx-item ${isOpen ? 'open' : ''}`}>
              <button
                className="cx-row"
                data-testid="contact-row"
                aria-expanded={isOpen}
                onClick={() => setOpenId(isOpen ? null : c.id)}
              >
                <span className="cx-who">
                  <Avatar name={c.name} />
                  <span className="cx-names">
                    <b>{c.name}</b>
                    {sub && <span>{sub}</span>}
                  </span>
                </span>
                <span className={`cx-pill ${late ? 'due' : c.status}`}>
                  <i />
                  {late ? 'Follow up' : STATUS_LABEL[c.status]}
                </span>
                <span className={`cx-when ${late ? 'due' : ''}`}>
                  {settled ? monthDay(c.lastContactAt) : shortDay(c.followUp, today)}
                </span>
                <span className="cx-extra">{extra || (defs[0] ? '' : '')}</span>
              </button>
              {isOpen && (
                <ContactDetail
                  contact={c}
                  defs={defs}
                  workspaceId={workspaceId}
                  today={today}
                  onGone={() => setOpenId(null)}
                />
              )}
            </div>
          )
        })}
        {list.length > 0 && shown.length === 0 && <p className="cx-hint">No one here.</p>}
      </div>
    </div>
  )
}

const HUES = [212, 262, 152, 28, 340, 188, 48]
/** Initials on a quiet tint, the same colour for the same name. */
function Avatar({ name, big }: { name: string; big?: boolean }): React.JSX.Element {
  const words = name.trim().split(/\s+/)
  const text = (
    (words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1][0] ?? '') : '')
  ).toUpperCase()
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span
      className={`cx-av ${big ? 'big' : ''}`}
      style={{ ['--h' as string]: HUES[h % HUES.length] }}
      aria-hidden
    >
      {text}
    </span>
  )
}

/** A value that is plain text until you click it: no box until you are changing it. */
function Quiet({
  value,
  onSave,
  type = 'text',
  placeholder,
  multiline,
  className = ''
}: {
  value: string
  onSave: (v: string) => void
  type?: 'text' | 'date'
  placeholder?: string
  multiline?: boolean
  className?: string
}): React.JSX.Element {
  const commit = (v: string): void => {
    if (v.trim() !== value) onSave(v)
  }
  return multiline ? (
    <textarea
      className={`cx-in ${className}`}
      rows={Math.min(6, Math.max(2, value.split('\n').length))}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => commit(e.target.value)}
    />
  ) : (
    <input
      className={`cx-in ${className}`}
      type={type}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function ContactDetail({
  contact: c,
  defs,
  workspaceId,
  today,
  onGone
}: {
  contact: Contact
  defs: FieldDef[]
  workspaceId: string
  today: string
  onGone: () => void
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const [newField, setNewField] = useState<string | null>(null)
  const [allHistory, setAllHistory] = useState(false)
  const save = (input: ContactEdit, line?: string): void =>
    void window.cove.contactsUpdate(c.id, input, line)

  const late = isDue(c, today)
  const history = [...c.history].reverse()
  const visible = allHistory ? history : history.slice(0, 4)

  return (
    <div className="cx-detail" data-testid="contact-detail">
      <div className="cx-dhead">
        <Avatar name={c.name} big />
        <Quiet
          key={c.name}
          className="cx-name"
          value={c.name}
          onSave={(v) => v.trim() && save({ name: v })}
        />
      </div>

      <div className="cx-status">
        {CONTACT_STATUSES.map((s) => (
          <button
            key={s}
            className={`${s} ${c.status === s ? 'on' : ''}`}
            onClick={() => c.status !== s && save({ status: s as ContactStatus })}
          >
            <i />
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="cx-props">
        {DETAILS.map((d) => (
          <div key={d.key} className="cx-field" data-testid={`detail-${d.key}`}>
            <label>{d.label}</label>
            {d.key === 'followUp' ? (
              <span className="cx-follow">
                <Quiet
                  type="date"
                  placeholder="No date"
                  value={c.followUp}
                  onSave={(v) => save({ followUp: v })}
                />
                {late && <em>due</em>}
                <button onClick={() => save({ followUp: addDays(Date.now(), 7) })}>+1 week</button>
              </span>
            ) : (
              <Quiet placeholder="Empty" value={c[d.key]} onSave={(v) => save({ [d.key]: v })} />
            )}
          </div>
        ))}
        {defs.map((f) => (
          <div key={f.key} className="cx-field" data-testid={`field-${f.key}`}>
            <label>
              {f.label}
              <button
                className="cx-gone"
                title={`Remove "${f.label}" from every contact`}
                onClick={() => {
                  if (window.confirm(`Remove the field "${f.label}" from every contact?`))
                    void window.cove.contactsRemoveField(workspaceId, f.key)
                }}
              >
                ×
              </button>
            </label>
            <Quiet
              placeholder="Empty"
              value={c.fields[f.key] ?? ''}
              type={f.type === 'date' ? 'date' : 'text'}
              onSave={(v) => save({ fields: { [f.label]: v } })}
            />
          </div>
        ))}
        <div className="cx-field cx-newrow">
          {newField === null ? (
            <button className="cx-addfield" data-testid="add-field" onClick={() => setNewField('')}>
              + New field
            </button>
          ) : (
            <input
              className="cx-newfield"
              autoFocus
              placeholder="Field name, e.g. Budget"
              value={newField}
              onChange={(e) => setNewField(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewField(null)
                if (e.key === 'Enter' && newField.trim()) {
                  save({ fields: { [newField.trim()]: '' } })
                  setNewField(null)
                }
              }}
              onBlur={() => !newField.trim() && setNewField(null)}
            />
          )}
        </div>
      </div>

      <Quiet multiline placeholder="Notes" value={c.notes} onSave={(v) => save({ notes: v })} />

      <ol className="cx-hist">
        {visible.map((e, i) => (
          <li key={i}>
            <span>{e.text}</span>
            <small>
              {monthDay(e.at)}
              {e.by === 'agent' ? ' · agent' : e.by === 'mail' ? ' · Mail' : ''}
            </small>
          </li>
        ))}
      </ol>
      <div className="cx-foot">
        <input
          className="cx-note"
          placeholder="Add a note to the history"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && note.trim()) {
              save({}, note)
              setNote('')
            }
          }}
        />
        {history.length > 4 && (
          <button onClick={() => setAllHistory((v) => !v)}>
            {allHistory ? 'Less' : `All ${history.length}`}
          </button>
        )}
        <button
          className="cx-remove"
          onClick={() => {
            if (window.confirm(`Remove ${c.name} from contacts?`)) {
              void window.cove.contactsDelete(c.id)
              onGone()
            }
          }}
        >
          Remove
        </button>
      </div>
    </div>
  )
}
