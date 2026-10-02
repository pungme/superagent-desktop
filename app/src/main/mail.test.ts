import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ kv: new Map<string, string>(), exec: vi.fn() }))
vi.mock('./store', () => ({
  kvGet: (key: string) => h.kv.get(key),
  kvSet: (key: string, value: string) => h.kv.set(key, value)
}))
vi.mock('child_process', () => ({ execFile: h.exec }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { openExternal: vi.fn() } }))
import { callMail, connectMail, disconnectMail, mailConnected, mailStatus } from './mail'
import { MAIL_SCRIPT } from './mail-script'

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  h.kv.clear()
  h.exec.mockReset()
  h.exec.mockImplementation((_path, _args, _options, cb) => cb(null, '{"ok":true}', ''))
})

afterEach(() => vi.unstubAllGlobals())

describe('Apple Mail access', () => {
  it('does not probe Mail on status or while disconnected', async () => {
    expect(mailStatus()).toEqual({ supported: true, connected: false })
    await expect(callMail('accounts', {})).rejects.toThrow('disconnected')
    expect(h.exec).not.toHaveBeenCalled()
  })
  it('only persists consent after a successful probe; disconnect blocks old callers', async () => {
    await connectMail()
    expect(mailConnected()).toBe(true)
    await callMail('accounts', {})
    disconnectMail()
    await expect(callMail('read', {})).rejects.toThrow('disconnected')
    expect(h.exec).toHaveBeenCalledTimes(2)
  })
  it('handles denied permission without leaking the command or data', async () => {
    h.exec.mockImplementation((_p, _a, _o, cb) =>
      cb(new Error('PRIVATE BODY'), '', 'Not authorized (-1743)')
    )
    const status = await connectMail()
    expect(status.connected).toBe(false)
    expect(status.error).toContain('Automation')
    expect(status.error).not.toContain('PRIVATE')
  })
  it('revocation invalidates persisted consent', async () => {
    await connectMail()
    h.exec.mockImplementation((_p, _a, _o, cb) => cb(new Error('denied'), '', '-1743'))
    await expect(callMail('accounts', {})).rejects.toThrow('permission was denied')
    expect(mailConnected()).toBe(false)
  })
  it('passes hostile text only as JSON argv and bounds search and read requests', async () => {
    await connectMail()
    const query = '"; doShellScript("touch /tmp/pwn"); // $(bad)'
    await callMail('search', { query })
    const [, args] = h.exec.mock.calls.at(-1)!
    expect(args[3]).toBe(MAIL_SCRIPT)
    expect(JSON.parse(args[4])).toMatchObject({ query, limit: 20, offset: 0 })
    await expect(callMail('search', { limit: 1000 })).rejects.toThrow()
    await expect(callMail('search', { accountId: 'x' })).rejects.toThrow('both')
    await expect(
      callMail('read', { accountId: 'x', mailboxPath: ['Inbox'], messageId: 1, maxChars: 999999 })
    ).rejects.toThrow()
  })
  it('validates drafts and never provides a send operation', async () => {
    await connectMail()
    await callMail('draft', { to: ['a@example.com'], subject: 'Hi', body: 'hello' })
    expect(JSON.parse(h.exec.mock.calls.at(-1)![1][4])).toMatchObject({
      op: 'draft',
      body: 'hello'
    })
    await expect(callMail('draft', { to: ['bad'], subject: '', body: '' })).rejects.toThrow()
    expect(MAIL_SCRIPT).not.toMatch(/\bmail\.send\s*\(/)
  })
  it('does not reconnect when a pending permission probe finishes after disconnect', async () => {
    let finish!: (error: null, stdout: string, stderr: string) => void
    h.exec.mockImplementation((_p, _a, _o, cb) => {
      finish = cb
    })
    const pending = connectMail()
    disconnectMail()
    finish(null, '{}', '')
    expect((await pending).connected).toBe(false)
  })
  it('discards results that finish after disconnect', async () => {
    await connectMail()
    let finish!: (error: null, stdout: string, stderr: string) => void
    h.exec.mockImplementation((_p, _a, _o, cb) => {
      finish = cb
    })
    const pending = callMail('accounts', {})
    disconnectMail()
    finish(null, '{"private":"mail"}', '')
    await expect(pending).rejects.toThrow('discarded')
  })
  it('does not invoke Apple automation on other operating systems', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    expect((await connectMail()).supported).toBe(false)
    expect(h.exec).not.toHaveBeenCalled()
  })
})

it('does not let an old denied request revoke a newer successful connection', async () => {
  await connectMail()
  let denyOld!: (error: Error, stdout: string, stderr: string) => void
  h.exec.mockImplementationOnce((_p, _a, _o, cb) => {
    denyOld = cb
  })
  const old = callMail('accounts', {})
  disconnectMail()
  await connectMail()
  denyOld(new Error('denied'), '', '-1743')
  await expect(old).rejects.toThrow('permission was denied')
  expect(mailConnected()).toBe(true)
})

it('gives a person time to answer the native prompt, without claiming a draft was saved', async () => {
  h.exec.mockImplementation((_p, _a, options, cb) => {
    expect(options.timeout).toBe(120000)
    cb(Object.assign(new Error('timeout'), { killed: true }), '', '')
  })
  const status = await connectMail()
  expect(status.connected).toBe(false)
  expect(status.error).toContain('permission prompt')
  expect(status.error).not.toContain('draft')
})

it('warns about a possibly saved draft only when draft creation times out', async () => {
  await connectMail()
  h.exec.mockImplementation((_p, _a, options, cb) => {
    expect(options.timeout).toBe(30000)
    cb(Object.assign(new Error('timeout'), { killed: true }), '', '')
  })
  await expect(callMail('accounts', {})).rejects.not.toThrow('draft')
  await expect(
    callMail('draft', { to: ['test@example.invalid'], subject: 'test', body: 'test' })
  ).rejects.toThrow('check Drafts')
})
