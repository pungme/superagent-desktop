import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'vm'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { MAIL_SCRIPT } from './mail-script'

// Model Mail's two observed quirks, not a stub of the TypeScript call result:
// the synthetic account container and JXA rejecting a one-element _and.
function fixture(
  nested = false,
  realAccountNamedMailbox = false,
  shadowAccountFolder = false
): {
  run: (input: object) => Record<string, unknown>
  whose: ReturnType<typeof vi.fn>
} {
  const missing = { exists: () => false }
  const collection = (entries: Record<string, unknown>): object => ({
    byName: (name: string) => entries[name] ?? missing
  })
  const root = { name: () => 'Work', container: () => missing, exists: () => true }
  const parent = {
    name: () => (realAccountNamedMailbox ? 'Work' : 'Projects'),
    container: () => root,
    exists: () => true,
    mailboxes: {}
  }
  const account = { id: () => 'account-1', name: () => 'Work', exists: () => true, mailboxes: {} }
  const mailbox = {
    name: () => 'Inbox',
    container: () => (nested ? parent : root),
    account: () => account,
    messages: { byId: (id: number) => ({ exists: () => id === 42 }) },
    exists: () => true
  }
  parent.mailboxes = collection({ Inbox: mailbox })
  account.mailboxes = collection(nested ? { [parent.name()]: parent } : { Inbox: mailbox })
  if (shadowAccountFolder)
    account.mailboxes = collection({
      Inbox: mailbox,
      Work: {
        exists: () => true,
        mailboxes: collection({ Inbox: { exists: () => true, messages: { byId: () => missing } } })
      }
    })
  const message = {
    mailbox: () => mailbox,
    id: () => 42,
    subject: () => 'test',
    sender: () => 'test@example.invalid',
    dateReceived: () => new Date(0),
    readStatus: () => false
  }
  const whose = vi.fn((filter: { _and?: unknown[] }) => {
    if (filter._and && filter._and.length < 2)
      throw new Error('Whose clause _and array requires at least two elements')
    // A filtered specifier is only resolved for its ID. Accessing any other
    // field here would repeat Mail's expensive filter and fails this fixture.
    return [{ id: message.id }]
  })
  const messages = Object.assign([message], { whose, byId: () => message })
  const mail = { accounts: { byId: () => account }, inbox: { messages } }
  return {
    whose,
    run: (input) =>
      JSON.parse(
        runInNewContext(MAIL_SCRIPT + '\nrun(argv)', {
          Application: () => mail,
          argv: [JSON.stringify(input)]
        })
      )
  }
}
const base = { op: 'search', offset: 0, limit: 1, query: '', unreadOnly: false }
describe('the JXA program executed against Mail-shaped objects', () => {
  it.each([false, true])('removes the synthetic account container (nested=%s)', (nested) => {
    const { run } = fixture(nested)
    const result = run(base) as { messages: { locator: { mailboxPath: string[] } }[] }
    expect(result.messages[0].locator.mailboxPath).toEqual(
      nested ? ['Projects', 'Inbox'] : ['Inbox']
    )
  })
  it('retains a real mailbox named exactly like its account', () => {
    const { run } = fixture(true, true)
    const result = run(base) as { messages: { locator: { mailboxPath: string[] } }[] }
    expect(result.messages[0].locator.mailboxPath).toEqual(['Work', 'Inbox'])
  })
  it('does not confuse a synthetic account root with a different real folder of the same name', () => {
    const { run } = fixture(false, false, true)
    const result = run(base) as { messages: { locator: { mailboxPath: string[] } }[] }
    expect(result.messages[0].locator.mailboxPath).toEqual(['Inbox'])
  })
  it('uses a direct predicate for one filter and _and only for two', () => {
    const { run, whose } = fixture()
    run({ ...base, query: '"quoted" 😀' })
    expect(whose.mock.calls.at(-1)![0]).not.toHaveProperty('_and')
    run({ ...base, unreadOnly: true })
    expect(whose.mock.calls.at(-1)![0]).toEqual({ readStatus: false })
    run({ ...base, query: 'hello', unreadOnly: true })
    expect(whose.mock.calls.at(-1)![0]._and).toHaveLength(2)
  })
})

it('places macOS privacy usage strings at the top level of extendInfo', () => {
  const yaml = createRequire(import.meta.url)('js-yaml') as {
    load: (s: string) => { mac: { extendInfo: Record<string, string> } }
  }
  const config = yaml.load(readFileSync('electron-builder.yml', 'utf8'))
  expect(Array.isArray(config.mac.extendInfo)).toBe(false)
  expect(config.mac.extendInfo.NSAppleEventsUsageDescription).toContain('Apple Mail')
  expect(config.mac.extendInfo.NSMicrophoneUsageDescription).toContain('voice')
})
