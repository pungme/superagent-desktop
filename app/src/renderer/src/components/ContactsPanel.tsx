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
  fieldKey,
  ymd,
  type ContactFilter,
  type ContactStatus
} from '../../../shared/contacts'

/**
 * A project's contacts: who it is reaching out to, and where each one stands.
 *
 * Quiet on purpose. The list is one line a person; what is due is a line above it,
 * not a box. A contact opens beside the list as plain text you click to change —
 * only what has a value is shown, and one line adds the rest. The agent keeps the
 * same list with its contacts_* tools.
 */

const FILTERS: { key: ContactFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'due', label: 'Due' },
  { key: 'sent', label: 'Waiting' },
  { key: 'replied', label: 'Replied' },
  { key: 'not_sent', label: 'Not sent' },
  { key: 'yes', label: 'Yes' },
  { key: 'no', label: 'No' }
]

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

function ago(ms: number | null): string {
  if (!ms) return ''
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
    <div className={`cq ${open ? 'has-detail' : ''}`} data-testid="contacts-panel">
      <div className="cq-main">
        <div className="cq-top">
          <div className="cq-filters">
            {list.length > 0 &&
              FILTERS.map((f) => {
                const n = f.key === 'all' ? counts.all : counts[f.key]
                if (f.key !== 'all' && f.key !== filter && n === 0) return null
                return (
                  <button
                    key={f.key}
                    className={`cq-filter ${filter === f.key ? 'on' : ''}`}
                    onClick={() => setFilter(f.key)}
                  >
                    {f.label}
                    {f.key !== 'all' && <i>{n}</i>}
                  </button>
                )
              })}
          </div>
          {list.length >= 4 && (
            <input
              className="cq-search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <button className="cq-add" onClick={() => setAdding(true)}>
            + Add
          </button>
        </div>

        {due.length > 0 && filter !== 'due' && (
          <div className="cq-due" data-testid="contacts-due">
            <b>{due.length === 1 ? '1 follow-up is due' : `${due.length} follow-ups are due`}</b>
            <span>
              {due
                .slice(0, 3)
                .map((c) => c.name)
                .join(', ')}
              {due.length > 3 ? ` +${due.length - 3}` : ''}
            </span>
            <button onClick={() => setFilter('due')}>Show</button>
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

        {list.length === 0 && !adding && (
          <div className="cq-empty">
            <p>No contacts yet.</p>
            <p>
              Add someone, or tell the agent: “put everyone in my outreach list into contacts”. An
              email sent to one of them marks them as waiting.
            </p>
          </div>
        )}

        <div className="cq-rows">
          {shown.map((c) => {
            const late = isDue(c, today)
            const state = late ? 'due' : c.status
            const sub = c.ask || c.org || c.email || c.channel
            const settled = c.status === 'yes' || c.status === 'no'
            const when = settled ? ago(c.lastContactAt) : shortDay(c.followUp, today)
            return (
              <button
                key={c.id}
                className={`cq-row ${openId === c.id ? 'sel' : ''}`}
                data-testid="contact-row"
                onClick={() => setOpenId(openId === c.id ? null : c.id)}
              >
                <span className="cq-who">
                  <b>{c.name}</b>
                  {sub && <span>{sub}</span>}
                </span>
                {!open &&
                  defs
                    .filter((f) => c.fields[f.key])
                    .slice(0, 2)
                    .map((f) => (
                      <span key={f.key} className="cq-tag" title={f.label}>
                        {c.fields[f.key]}
                      </span>
                    ))}
                <span className={`cq-state s-${state}`}>
                  <i />
                  {late ? 'Follow up' : STATUS_LABEL[c.status]}
                </span>
                <span className={`cq-when ${late ? 'late' : ''}`}>{when}</span>
              </button>
            )
          })}
          {list.length > 0 && shown.length === 0 && <div className="cq-empty">Nobody here.</div>}
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
  const key = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') onDone()
  }
  return (
    <div className="cq-new" data-testid="contact-new">
      <input
        autoFocus
        placeholder="Name or organisation"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={key}
      />
      <input
        placeholder="Email (optional)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={key}
      />
      <input
        placeholder="What you are asking for (optional)"
        value={ask}
        onChange={(e) => setAsk(e.target.value)}
        onKeyDown={key}
      />
      <button className="cq-go" disabled={!name.trim()} onClick={submit}>
        Add
      </button>
      <button className="cq-quiet" onClick={onDone}>
        Cancel
      </button>
    </div>
  )
}

/** A value that is plain text until you click it: no box until you are changing it. */
function Quiet({
  value,
  onSave,
  type = 'text',
  placeholder,
  multiline
}: {
  value: string
  onSave: (v: string) => void
  type?: 'text' | 'date'
  placeholder?: string
  multiline?: boolean
}): React.JSX.Element {
  const commit = (v: string): void => {
    if (v.trim() !== value) onSave(v)
  }
  return multiline ? (
    <textarea
      className="cq-quiet-in"
      rows={Math.min(6, Math.max(2, value.split('\n').length))}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => commit(e.target.value)}
    />
  ) : (
    <input
      className="cq-quiet-in"
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
  const [editName, setEditName] = useState(false)
  const [asked, setAsked] = useState<DetailKey[]>([])
  const [askedFields, setAskedFields] = useState<string[]>([])
  const [allHistory, setAllHistory] = useState(false)
  const save = (input: ContactEdit, line?: string): void =>
    void window.cove.contactsUpdate(c.id, input, line)

  const has = (k: DetailKey): boolean => !!c[k] || asked.includes(k)
  const missing = DETAILS.filter((d) => !has(d.key))
  const late = isDue(c, today)
  const history = [...c.history].reverse()
  const visibleHistory = allHistory ? history : history.slice(0, 3)

  return (
    <aside className="cq-detail" data-testid="contact-detail">
      <div className="cq-dhead">
        {editName ? (
          <input
            className="cq-name-in"
            autoFocus
            defaultValue={c.name}
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value.trim() !== c.name)
                save({ name: e.target.value })
              setEditName(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h3 title="Click to rename" onClick={() => setEditName(true)}>
            {c.name}
          </h3>
        )}
        <button className="cq-x" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="cq-status">
        {CONTACT_STATUSES.map((s) => (
          <button
            key={s}
            className={`cq-st s-${s} ${c.status === s ? 'on' : ''}`}
            onClick={() => c.status !== s && save({ status: s as ContactStatus })}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="cq-grid">
        {DETAILS.filter((d) => has(d.key)).map((d) => (
          <div key={d.key} className="cq-line" data-testid={`detail-${d.key}`}>
            <label>{d.label}</label>
            <div>
              {d.key === 'followUp' ? (
                <span className="cq-follow">
                  <Quiet type="date" value={c.followUp} onSave={(v) => save({ followUp: v })} />
                  {late && <em>due</em>}
                  <button onClick={() => save({ followUp: addDays(Date.now(), 7) })}>
                    +1 week
                  </button>
                </span>
              ) : (
                <Quiet value={c[d.key]} onSave={(v) => save({ [d.key]: v })} />
              )}
            </div>
          </div>
        ))}
        {defs
          .filter((f) => c.fields[f.key] || askedFields.includes(f.key))
          .map((f) => (
            <div key={f.key} className="cq-line" data-testid={`field-${f.key}`}>
              <label>
                {f.label}
                <button
                  className="cq-gone"
                  title={`Remove "${f.label}" from every contact`}
                  onClick={() => {
                    if (window.confirm(`Remove the field "${f.label}" from every contact?`))
                      void window.cove.contactsRemoveField(workspaceId, f.key)
                  }}
                >
                  ×
                </button>
              </label>
              <div>
                <Quiet
                  value={c.fields[f.key] ?? ''}
                  type={f.type === 'date' ? 'date' : 'text'}
                  onSave={(v) => save({ fields: { [f.label]: v } })}
                />
              </div>
            </div>
          ))}
      </div>

      <div className="cq-more">
        {missing.map((d) => (
          <button key={d.key} onClick={() => setAsked((a) => [...a, d.key])}>
            + {d.label}
          </button>
        ))}
        {defs
          .filter((f) => !c.fields[f.key] && !askedFields.includes(f.key))
          .map((f) => (
            <button key={f.key} onClick={() => setAskedFields((a) => [...a, f.key])}>
              + {f.label}
            </button>
          ))}
        {newField === null ? (
          <button data-testid="add-field" onClick={() => setNewField('')}>
            + Add a field
          </button>
        ) : (
          <input
            className="cq-newfield"
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

      <div className="cq-notes">
        <Quiet multiline placeholder="Notes" value={c.notes} onSave={(v) => save({ notes: v })} />
      </div>

      <div className="cq-hist">
        <ol>
          {visibleHistory.map((e, i) => (
            <li key={i}>
              <span>{e.text}</span>
              <small>
                {new Date(e.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                {e.by === 'agent' ? ' · agent' : e.by === 'mail' ? ' · Mail' : ''}
              </small>
            </li>
          ))}
        </ol>
        {history.length > 3 && (
          <button className="cq-quiet" onClick={() => setAllHistory((v) => !v)}>
            {allHistory ? 'Show less' : `Show all ${history.length}`}
          </button>
        )}
        <input
          className="cq-note-in"
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
      </div>

      <button
        className="cq-remove"
        onClick={() => {
          if (window.confirm(`Remove ${c.name} from contacts?`)) {
            void window.cove.contactsDelete(c.id)
            onClose()
          }
        }}
      >
        Remove contact
      </button>
    </aside>
  )
}
