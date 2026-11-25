import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Contact, ContactEdit, FieldDef } from '../../../preload'
import {
  CONTACT_STATUSES,
  STATUS_LABEL,
  addDays,
  fieldKey,
  isDue,
  matches,
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
type DetailKey = (typeof DETAILS)[number]['key']

function shortDay(day: string, today: string): string {
  if (!day) return ''
  if (day === today) return 'Today'
  if (day === addDays(Date.parse(today + 'T12:00:00'), 1)) return 'Tomorrow'
  return new Date(day + 'T12:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' })
}

const monthDay = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''

/** "Anna Lee anna@x.org" → a name and an email, whichever were given. */
export function quickContact(text: string): { name: string; email: string } {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(text)?.[0] ?? ''
  const name = text
    .replace(email, '')
    .replace(/[<>(),;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { name: name || email.split('@')[0] || '', email: email.toLowerCase() }
}

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

  // How things stand, and the filter: each part is a button, the total clears it.
  const parts = (
    [
      { key: 'due', text: `${counts.due} due`, tone: 'due' },
      { key: 'replied', text: `${counts.replied} replied` },
      { key: 'sent', text: `${counts.sent} waiting` },
      { key: 'not_sent', text: `${counts.not_sent} not sent` },
      { key: 'yes', text: `${counts.yes} yes`, tone: 'yes' },
      { key: 'no', text: `${counts.no} no` }
    ] as { key: ContactFilter; text: string; tone?: string }[]
  ).filter((p) => counts[p.key as 'due'] > 0 || p.key === filter)

  return (
    <div className="cx" data-testid="contacts-panel">
      <div className="cx-line">
        <button
          className={`cx-part ${filter === 'all' ? 'on' : ''}`}
          onClick={() => setFilter('all')}
        >
          {counts.all === 0 ? 'No one yet' : counts.all === 1 ? '1 person' : `${counts.all} people`}
        </button>
        {parts.map((p) => (
          <button
            key={p.key}
            className={`cx-part ${p.tone ?? ''} ${filter === p.key ? 'on' : ''}`}
            data-testid={p.key === 'due' ? 'contacts-due' : undefined}
            onClick={() => setFilter(filter === p.key ? 'all' : p.key)}
          >
            {p.text}
          </button>
        ))}
        {list.length >= 8 && (
          <input
            className="cx-search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

      <input
        className="cx-add"
        placeholder="Add a person"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void add()}
        data-testid="contact-new"
      />

      {list.length === 0 && (
        <p className="cx-hint">
          Type a name above, or ask the agent to “put everyone in my outreach list into contacts”.
        </p>
      )}

      <div className="cx-rows">
        {shown.map((c) => {
          const late = isDue(c, today)
          const settled = c.status === 'yes' || c.status === 'no'
          const sub = c.ask || c.org || c.email || c.channel
          const tag = defs.map((f) => c.fields[f.key]).find(Boolean)
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
                  <b>{c.name}</b>
                  {sub && <span>{sub}</span>}
                </span>
                {tag && <span className="cx-tag">{tag}</span>}
                <span className={`cx-state ${late ? 'due' : c.status}`}>
                  {late ? 'Follow up' : STATUS_LABEL[c.status]}
                </span>
                <span className={`cx-when ${late ? 'due' : ''}`}>
                  {settled ? monthDay(c.lastContactAt) : shortDay(c.followUp, today)}
                </span>
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
  const [asked, setAsked] = useState<DetailKey[]>([])
  const [askedFields, setAskedFields] = useState<string[]>([])
  const [allHistory, setAllHistory] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const save = (input: ContactEdit, line?: string): void =>
    void window.cove.contactsUpdate(c.id, input, line)

  const has = (k: DetailKey): boolean => !!c[k] || asked.includes(k)
  const offered = [
    ...DETAILS.filter((d) => !has(d.key)).map((d) => ({
      key: d.key as string,
      label: d.label,
      take: () => setAsked((a) => [...a, d.key])
    })),
    ...defs
      .filter((f) => !c.fields[f.key] && !askedFields.includes(f.key))
      .map((f) => ({
        key: f.key,
        label: f.label,
        take: () => setAskedFields((a) => [...a, f.key])
      }))
  ]
  const late = isDue(c, today)
  const history = [...c.history].reverse()
  const visible = allHistory ? history : history.slice(0, 3)

  return (
    <div className="cx-detail" data-testid="contact-detail">
      {renaming && (
        <Quiet
          className="cx-name"
          value={c.name}
          onSave={(v) => {
            if (v.trim()) save({ name: v })
            setRenaming(false)
          }}
        />
      )}

      <div className="cx-status">
        {CONTACT_STATUSES.map((s) => (
          <button
            key={s}
            className={`${s} ${c.status === s ? 'on' : ''}`}
            onClick={() => c.status !== s && save({ status: s as ContactStatus })}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {DETAILS.filter((d) => has(d.key)).map((d) => (
        <div key={d.key} className="cx-field" data-testid={`detail-${d.key}`}>
          <label>{d.label}</label>
          {d.key === 'followUp' ? (
            <span className="cx-follow">
              <Quiet type="date" value={c.followUp} onSave={(v) => save({ followUp: v })} />
              {late && <em>due</em>}
              <button onClick={() => save({ followUp: addDays(Date.now(), 7) })}>+1 week</button>
            </span>
          ) : (
            <Quiet value={c[d.key]} onSave={(v) => save({ [d.key]: v })} />
          )}
        </div>
      ))}
      {defs
        .filter((f) => c.fields[f.key] || askedFields.includes(f.key))
        .map((f) => (
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
              value={c.fields[f.key] ?? ''}
              type={f.type === 'date' ? 'date' : 'text'}
              onSave={(v) => save({ fields: { [f.label]: v } })}
            />
          </div>
        ))}

      <div className="cx-offer">
        {offered.map((o) => (
          <button key={o.key} onClick={o.take}>
            {o.label}
          </button>
        ))}
        {!renaming && (
          <button className="plain" onClick={() => setRenaming(true)}>
            Rename
          </button>
        )}
        {newField === null ? (
          <button data-testid="add-field" onClick={() => setNewField('')}>
            New field
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
                setAskedFields((a) => [...a, fieldKey(newField.trim())])
                setNewField(null)
              }
            }}
            onBlur={() => !newField.trim() && setNewField(null)}
          />
        )}
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
        {history.length > 3 && (
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
