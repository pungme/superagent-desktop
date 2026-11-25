import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Contact, ContactEdit, FieldDef } from '../../../preload'
import {
  CONTACT_STATUSES,
  STATUS_LABEL,
  addDays,
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
 * Follow-ups that are due come first and are called out at the top. Click a row
 * to see and change it; the agent keeps the same list with its contacts_* tools,
 * and an email sent to someone here updates them by itself.
 */

const FILTERS: { key: ContactFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'due', label: 'Follow-up due' },
  { key: 'sent', label: 'Waiting' },
  { key: 'replied', label: 'Replied' },
  { key: 'not_sent', label: 'Not sent' },
  { key: 'yes', label: 'Yes' },
  { key: 'no', label: 'No' }
]

function shortDay(day: string, today: string): string {
  if (!day) return ''
  if (day === today) return 'Today'
  if (day === addDays(Date.parse(today + 'T12:00:00'), 1)) return 'Tomorrow'
  const d = new Date(day + 'T12:00:00')
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function ago(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function ContactsPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [list, setList] = useState<Contact[]>([])
  const [defs, setDefs] = useState<FieldDef[]>([])
  const [filter, setFilter] = useState<ContactFilter>('all')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
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
  const open = list.find((c) => c.id === openId) ?? null
  const due = list.filter((c) => isDue(c, today))

  return (
    <div className={`contacts ${open ? 'has-detail' : ''}`} data-testid="contacts-panel">
      <div className="contacts-main">
        <div className="contacts-head">
          <span className="contacts-sub">
            {list.length === 0
              ? 'The people this project is reaching out to'
              : `${counts.all} ${counts.all === 1 ? 'person' : 'people'} · ${counts.sent} waiting · ${counts.yes} yes`}
          </span>
          <button className="contacts-add-btn" onClick={() => setAdding(true)}>
            + Add
          </button>
        </div>
        {due.length > 0 && (
          <div className="contacts-due" data-testid="contacts-due">
            <span>
              <b>{due.length === 1 ? '1 follow-up is due' : `${due.length} follow-ups are due`}:</b>{' '}
              {due
                .slice(0, 3)
                .map((c) => c.name)
                .join(', ')}
              {due.length > 3 ? ` and ${due.length - 3} more` : ''}
            </span>
            <button className="contacts-link" onClick={() => setFilter('due')}>
              Show them
            </button>
          </div>
        )}
        {adding && (
          <AddContact
            onDone={() => setAdding(false)}
            onAdd={async (input) => {
              const c = await window.cove.contactsAdd(workspaceId, input)
              setAdding(false)
              if (c) setOpenId(c.id)
            }}
          />
        )}
        {list.length > 0 && (
          <div className="contacts-filters">
            {FILTERS.map((f) => {
              const n = f.key === 'all' ? counts.all : counts[f.key]
              if (f.key !== 'all' && f.key !== filter && n === 0) return null
              return (
                <button
                  key={f.key}
                  className={`contacts-chip ${filter === f.key ? 'on' : ''}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label} <i>{n}</i>
                </button>
              )
            })}
            <input
              className="contacts-search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {list.length === 0 && !adding && (
          <div className="contacts-empty">
            <p>No contacts yet.</p>
            <p>
              Add people here, or ask the agent: “put everyone in my outreach list into contacts”.
              It keeps their status as you go, and an email sent to one of them marks them as
              waiting, with a follow-up a week later.
            </p>
          </div>
        )}
        <div className="contacts-rows">
          {shown.map((c) => {
            const late = isDue(c, today)
            return (
              <button
                key={c.id}
                className={`contacts-row ${openId === c.id ? 'sel' : ''}`}
                data-testid="contact-row"
                onClick={() => setOpenId(openId === c.id ? null : c.id)}
              >
                <span className="contacts-who">
                  <b>{c.name}</b>
                  <span>{[c.org, c.email || c.channel].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="contacts-ask">
                  {c.ask}
                  {defs
                    .filter((f) => c.fields[f.key])
                    .slice(0, 2)
                    .map((f) => (
                      <em key={f.key} className="contacts-tag" title={f.label}>
                        {c.fields[f.key]}
                      </em>
                    ))}
                </span>
                <span className={`contacts-pill s-${late ? 'due' : c.status}`}>
                  {late ? 'Follow up' : STATUS_LABEL[c.status]}
                </span>
                <span className={`contacts-next ${late ? 'late' : ''}`}>
                  {c.status === 'yes' || c.status === 'no'
                    ? ago(c.lastContactAt)
                    : shortDay(c.followUp, today) || ago(c.lastContactAt)}
                </span>
              </button>
            )
          })}
          {list.length > 0 && shown.length === 0 && (
            <div className="contacts-empty">Nobody here with that filter.</div>
          )}
        </div>
      </div>
      {open && (
        <ContactDetail
          key={open.id}
          contact={open}
          defs={defs}
          workspaceId={workspaceId}
          today={today}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}

function AddContact({
  onAdd,
  onDone
}: {
  onAdd: (input: ContactEdit) => Promise<void>
  onDone: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [ask, setAsk] = useState('')
  const submit = (): void => {
    if (name.trim()) void onAdd({ name, email, ask })
  }
  return (
    <div className="contacts-new" data-testid="contact-new">
      <input
        autoFocus
        placeholder="Name or organisation"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onDone()
        }}
      />
      <input
        placeholder="Email (optional)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        placeholder="What you are asking for (optional)"
        value={ask}
        onChange={(e) => setAsk(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button className="contacts-btn primary" disabled={!name.trim()} onClick={submit}>
        Add
      </button>
      <button className="contacts-btn" onClick={onDone}>
        Cancel
      </button>
    </div>
  )
}

function ContactDetail({
  contact: c,
  defs,
  workspaceId,
  today,
  onClose
}: {
  contact: Contact
  defs: FieldDef[]
  workspaceId: string
  today: string
  onClose: () => void
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const [newField, setNewField] = useState<string | null>(null)
  const save = (input: ContactEdit, line?: string): void =>
    void window.cove.contactsUpdate(c.id, input, line)
  const field = (
    key: 'name' | 'org' | 'email' | 'channel' | 'ask',
    label: string
  ): React.JSX.Element => (
    <label className="contacts-field">
      <span>{label}</span>
      <input
        defaultValue={c[key]}
        onBlur={(e) => {
          if (e.target.value.trim() !== c[key]) save({ [key]: e.target.value })
        }}
      />
    </label>
  )
  return (
    <aside className="contacts-detail" data-testid="contact-detail">
      <div className="contacts-detail-head">
        <h3>{c.name}</h3>
        <button className="contacts-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="contacts-status">
        {CONTACT_STATUSES.map((s) => (
          <button
            key={s}
            className={`contacts-pill s-${s} ${c.status === s ? 'on' : 'off'}`}
            onClick={() => c.status !== s && save({ status: s as ContactStatus })}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      <label className="contacts-field">
        <span>Follow up</span>
        <span className="contacts-follow">
          <input
            type="date"
            value={c.followUp}
            onChange={(e) => save({ followUp: e.target.value })}
          />
          {isDue(c, today) && <em>due</em>}
          <button
            className="contacts-link"
            onClick={() => save({ followUp: addDays(Date.now(), 7) })}
          >
            in a week
          </button>
        </span>
      </label>
      {field('name', 'Name')}
      {field('org', 'Who')}
      {field('email', 'Email')}
      {field('channel', 'Other way')}
      {field('ask', 'Ask')}
      <label className="contacts-field">
        <span>Notes</span>
        <textarea
          rows={3}
          defaultValue={c.notes}
          onBlur={(e) => e.target.value.trim() !== c.notes && save({ notes: e.target.value })}
        />
      </label>
      {(defs.length > 0 || newField !== null) && <div className="contacts-sec">Details</div>}
      {defs.map((f) => (
        <label key={f.key} className="contacts-field" data-testid={`field-${f.key}`}>
          <span className="contacts-field-label">
            {f.label}
            <button
              className="contacts-link"
              title={`Remove "${f.label}" from every contact`}
              onClick={(e) => {
                e.preventDefault()
                if (window.confirm(`Remove the field "${f.label}" from every contact?`))
                  void window.cove.contactsRemoveField(workspaceId, f.key)
              }}
            >
              remove
            </button>
          </span>
          <input
            defaultValue={c.fields[f.key] ?? ''}
            type={f.type === 'date' ? 'date' : 'text'}
            onBlur={(e) => {
              if (e.target.value.trim() !== (c.fields[f.key] ?? ''))
                save({ fields: { [f.label]: e.target.value } })
            }}
          />
        </label>
      ))}
      {newField === null ? (
        <button className="contacts-link" data-testid="add-field" onClick={() => setNewField('')}>
          + Add a field
        </button>
      ) : (
        <div className="contacts-newfield">
          <input
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
          />
        </div>
      )}
      <div className="contacts-sec">History</div>
      <ol className="contacts-history">
        {[...c.history].reverse().map((e, i) => (
          <li key={i} className={`by-${e.by}`}>
            {e.text}
            <small>
              {new Date(e.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
              {e.by === 'agent' ? ' · agent' : e.by === 'mail' ? ' · Mail' : ''}
            </small>
          </li>
        ))}
      </ol>
      <div className="contacts-note">
        <input
          placeholder="Add a note (what they said, what's next)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && note.trim()) {
              save({}, note)
              setNote('')
            }
          }}
        />
      </div>
      <button
        className="contacts-delete"
        onClick={() => {
          if (window.confirm(`Remove ${c.name} from contacts?`)) {
            void window.cove.contactsDelete(c.id)
            onClose()
          }
        }}
      >
        Remove
      </button>
    </aside>
  )
}
