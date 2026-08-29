import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { EventEmitter } from 'events'
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'crypto'
import WebSocket from 'ws'

/**
 * The whole desktop side against a real relay and a fake phone:
 * pair → hello/welcome → subscribe/replay → chat.send → live event → approval.
 * Electron and the SQLite store are replaced with in-memory stand-ins; the
 * crypto, the relay client, the sessions and the RPC table are the real ones.
 */

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events')
  return {
    agentBus: new EventEmitter(),
    hookBus: new EventEmitter(),
    kv: new Map<string, string>(),
    devices: new Map<
      string,
      {
        id: string
        name: string
        model: string
        secret: Buffer
        token: string
        pushToken: string | null
      }
    >(),
    events: new Map<string, { seq: number; kind: string; data: string; ts: number }[]>(),
    items: new Map<string, unknown[]>(),
    sessions: new Map<
      string,
      { id: string; chatId?: string; workspaceId?: string; owned: boolean }
    >(),
    sent: [] as { id: string; text: string; from: string; localId?: string }[],
    gates: new Map<string, boolean>(),
    identityPem: '' as string
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', getPath: () => '/tmp/superagent-e2e' },
  safeStorage: {
    isEncryptionAvailable: () => false
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  powerMonitor: { on: () => undefined },
  powerSaveBlocker: { start: () => 1, stop: () => undefined },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../util', () => ({ broadcastToWindows: () => undefined }))

vi.mock('../store', () => ({
  getDb: () => {
    throw new Error('not used in e2e')
  },
  DESKTOP_WORKSPACE_ID: '__desktop_chat__',
  getTree: () => [
    {
      id: 'g1',
      name: 'My projects',
      color: '#fff',
      workspaces: [{ id: 'w1', name: 'rowfill', path: '/tmp/rowfill', kind: 'app' }]
    }
  ],
  listAllChats: () => [
    {
      id: 'c1',
      workspaceId: 'w1',
      title: 'Fix login',
      claudeSessionId: 'sess-1',
      updatedAt: 1,
      cwd: null
    }
  ],
  getChat: (id: string) =>
    id === 'c1'
      ? {
          id: 'c1',
          workspaceId: 'w1',
          title: 'Fix login',
          claudeSessionId: 'sess-1',
          updatedAt: 1,
          cwd: null
        }
      : undefined,
  getWorkspace: (id: string) =>
    id === 'w1'
      ? {
          id: 'w1',
          groupId: 'g1',
          name: 'rowfill',
          path: '/tmp/rowfill',
          position: 0,
          browserUrl: null,
          lastSessionId: null,
          kind: 'app'
        }
      : undefined,
  getChatIdBySession: (sid: string) => (sid === 'sess-1' ? 'c1' : undefined),
  getWorkspaceName: (id: string) => (id === 'w1' ? 'rowfill' : undefined),
  kvGet: (k: string) => h.kv.get(k),
  kvSet: (k: string, v: string) => h.kv.set(k, v),
  listCards: () => [],
  createChat: () => 'c-new',
  deleteChat: () => undefined,
  setChatTitle: () => undefined,
  setChatSession: () => undefined,
  lastChatPreview: () => null,
  appendChatEvent: (chatId: string, kind: string, data: unknown) => {
    const buf = h.events.get(chatId) ?? []
    const seq = buf.length + 1
    buf.push({ seq, kind, data: JSON.stringify(data), ts: Date.now() })
    h.events.set(chatId, buf)
    return seq
  },
  listChatEvents: (chatId: string, afterSeq: number, limit: number) =>
    (h.events.get(chatId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .slice(0, limit)
      .map((e) => ({ chatId, ...e })),
  chatEventCount: (chatId: string) => (h.events.get(chatId) ?? []).length,
  loadChatItems: (chatId: string) => h.items.get(chatId) ?? [],
  appendChatItems: (chatId: string, items: unknown[]) =>
    h.items.set(chatId, [...(h.items.get(chatId) ?? []), ...items])
}))

vi.mock('./devices', async () => {
  const { deriveKeys } = await import('./crypto')
  const { machineId } = await import('./identity')
  return {
    listDevices: () =>
      [...h.devices.values()].map((d) => ({
        id: d.id,
        name: d.name,
        model: d.model,
        pushToken: d.pushToken,
        pushEnv: 'production',
        createdAt: 0,
        lastSeenAt: null
      })),
    addDevice: (
      d: { id: string; name: string; model: string; pushToken?: string },
      secret: Buffer,
      token: string
    ) => h.devices.set(d.id, { ...d, secret, token, pushToken: d.pushToken ?? null }),
    removeDevice: (id: string) => h.devices.delete(id),
    touchDevice: () => undefined,
    setPushToken: () => undefined,
    tokenMatches: (id: string, token: string) => h.devices.get(id)?.token === token,
    getDevice: (id: string) => h.devices.get(id),
    devicesWithPush: () => [],
    allDeviceKeys: () =>
      [...h.devices.values()].map((d) => ({ id: d.id, keys: deriveKeys(d.secret, machineId()) }))
  }
})

vi.mock('../agent', () => ({
  agentBus: h.agentBus,
  listSessions: () => [...h.sessions.values()],
  findSessionByChat: (chatId: string) => [...h.sessions.values()].find((s) => s.chatId === chatId),
  startAgent: (_owner: null, opts: { chatId?: string; workspaceId?: string }) => {
    const id = `s-${h.sessions.size + 1}`
    h.sessions.set(id, { id, chatId: opts.chatId, workspaceId: opts.workspaceId, owned: false })
    h.agentBus.emit('started', { id, chatId: opts.chatId, workspaceId: opts.workspaceId })
    return id
  },
  sendToAgent: (
    id: string,
    text: string,
    _images: unknown[],
    origin: { from: string; localId?: string }
  ) => {
    const s = h.sessions.get(id)
    if (!s) return false
    h.sent.push({ id, text, from: origin.from, localId: origin.localId })
    h.agentBus.emit('user', {
      id,
      chatId: s.chatId,
      workspaceId: s.workspaceId,
      text,
      images: [],
      from: origin.from,
      localId: origin.localId
    })
    return true
  },
  hardInterruptAgent: async () => true,
  stopAgent: (id: string) => h.sessions.delete(id),
  getSessionOpts: () => ({})
}))

vi.mock('../hooks', () => ({
  hookBus: h.hookBus,
  notifyPrefs: { done: true, needsYou: true },
  resolveGate: (id: string, approve: boolean) => {
    if (!h.gates.has(id)) return false
    h.gates.delete(id)
    h.hookBus.emit('approval-end', {
      requestId: id,
      outcome: approve ? 'approved' : 'denied',
      by: 'ios'
    })
    return true
  }
}))
vi.mock('../routines', () => ({ listRoutines: () => [], runRoutine: async () => {} }))
vi.mock('../files', () => ({ gitBranch: () => 'main' }))

// Identity: a fixed Ed25519 key, no disk.
vi.mock('./identity', async () => {
  const { generateKeyPairSync, createPublicKey, sign } = await import('crypto')
  const { privateKey } = generateKeyPairSync('ed25519')
  const pub = (
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
  ).subarray(-32)
  const id = pub.toString('hex')
  return {
    machineId: () => id,
    loadIdentity: () => ({ machineId: id, privateKey }),
    signNonce: (nonce: Buffer) => sign(null, nonce, privateKey).toString('base64'),
    protect: (b: Buffer) => b,
    unprotect: (b: Buffer) => b
  }
})

import { startRelay } from '../../../../../relay/src/node.js'
import { deriveKeys, aadFor, Sealer, Opener, pairingDigest } from './crypto'
import {
  pairingCodeFromDigest,
  type ServerFrame,
  type PairPayload
} from '../../shared/companion-protocol'
import { machineId } from './identity'
import { startCompanionLog } from './log'
import { startCompanion, stopCompanion, companionState } from './index'
import { startPairing, decidePairing, pairingBus } from './pairing'

const server = startRelay(0)
const port = (): number => (server.address() as { port: number }).port

/** A phone, as far as the Mac can tell. */
class FakePhone {
  ws!: WebSocket
  sealer!: Sealer
  opener!: Opener
  inbox: ServerFrame[] = []
  waiters: ((f: ServerFrame) => void)[] = []
  constructor(secret: Buffer) {
    const m = machineId()
    const keys = deriveKeys(secret, m)
    this.sealer = new Sealer(keys.p2m, aadFor(m, 'p2m'))
    this.opener = new Opener(keys.m2p, aadFor(m, 'm2p'))
  }
  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port()}/c/${machineId()}`)
    this.ws.on('message', (d) => {
      const text = d.toString()
      if (text.startsWith('{')) return // relay's own {"t":"offline"} etc.
      const plain = this.opener.open(text)
      if (plain === null) throw new Error('phone could not decrypt a frame')
      const frame = JSON.parse(plain) as ServerFrame
      const w = this.waiters.shift()
      if (w) w(frame)
      else this.inbox.push(frame)
    })
    await new Promise<void>((r) => this.ws.once('open', () => r()))
  }
  send(frame: unknown): void {
    this.ws.send(this.sealer.seal(JSON.stringify(frame)))
  }
  next(): Promise<ServerFrame> {
    const queued = this.inbox.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((r) => this.waiters.push(r))
  }
  async until(pred: (f: ServerFrame) => boolean): Promise<ServerFrame> {
    for (;;) {
      const f = await this.next()
      if (pred(f)) return f
    }
  }
}

beforeAll(async () => {
  h.kv.set('companion.relay', `ws://127.0.0.1:${port()}`)
  startCompanionLog()
  startCompanion()
  // Wait for the Mac to authenticate with the relay.
  for (let i = 0; i < 100 && companionState().relay.state !== 'connected'; i++)
    await new Promise((r) => setTimeout(r, 20))
  expect(companionState().relay.state).toBe('connected')
})
afterAll(() => {
  stopCompanion()
  server.close()
})

describe('desktop ⇄ relay ⇄ phone', () => {
  let token = ''
  let secret: Buffer

  it('pairs a phone: QR secret → pair frame → Accept on the Mac → token', async () => {
    const { payload, code } = startPairing(`ws://127.0.0.1:${port()}`)
    const p: PairPayload = payload
    expect(p.m).toBe(machineId())
    secret = Buffer.from(p.k, 'base64url')
    // The phone computes the same 6-digit code from the QR alone.
    expect(pairingCodeFromDigest(pairingDigest(secret, p.m))).toBe(code)

    const phone = new FakePhone(secret)
    await phone.connect()
    const request = new Promise<{ code: string }>((r) => pairingBus.once('request', r))
    phone.send({ t: 'pair', device: { id: 'iphone-1', name: 'Test iPhone', model: 'iPhone17,1' } })
    expect((await request).code).toBe(code)
    decidePairing(true)
    const paired = await phone.next()
    expect(paired.t).toBe('paired')
    token = (paired as { token: string }).token
    expect(token.length).toBeGreaterThan(30)
    expect(companionState().devices.map((d) => d.id)).toEqual(['iphone-1'])
    phone.ws.close()
  })

  it('rejects a phone with the wrong secret', async () => {
    const stranger = new FakePhone(Buffer.alloc(32, 9))
    await stranger.connect()
    const closed = new Promise<number>((r) => stranger.ws.once('close', (code) => r(code)))
    stranger.send({ t: 'hello', v: 1, device: 'iphone-1', token, app: 'ios/0.1' })
    expect(await closed).toBe(1000)
  })

  it('welcomes a paired phone, replays a chat, streams a turn it started, and settles an approval', async () => {
    const phone = new FakePhone(secret)
    await phone.connect()
    phone.send({ t: 'hello', v: 1, device: 'iphone-1', token, app: 'ios/0.1' })
    const welcome = await phone.next()
    expect(welcome).toMatchObject({ t: 'welcome', machine: { appVersion: '9.9.9' } })
    expect((welcome as { tree: { workspaces: unknown[] }[] }).tree[0].workspaces).toHaveLength(1)

    // Old transcript: backfilled on first subscribe.
    h.items.set('c1', [
      { kind: 'msg', msg: { id: 'a0', role: 'assistant', text: 'earlier reply' } }
    ])
    phone.send({ t: 'subscribe', chatId: 'c1', afterSeq: 0 })
    const replay = await phone.next()
    expect(replay).toMatchObject({
      t: 'event',
      event: { seq: 1, data: { kind: 'assistant', text: 'earlier reply' } }
    })

    // Send a prompt from the phone: agent starts, user event comes back with our localId.
    phone.send({
      t: 'req',
      id: 'r1',
      method: 'chat.send',
      params: { chatId: 'c1', text: 'ship it', localId: 'L-1' }
    })
    const userEv = await phone.until((f) => f.t === 'event')
    expect(userEv).toMatchObject({
      event: { seq: 2, data: { kind: 'user', id: 'L-1', from: 'ios', text: 'ship it' } }
    })
    const res = await phone.until((f) => f.t === 'res')
    expect(res).toMatchObject({ id: 'r1', ok: true })
    expect(h.sent[0]).toMatchObject({ text: 'ship it', from: 'ios' })
    // The desktop transcript was updated too (no window owns this session).
    expect(h.items.get('c1')).toHaveLength(2)

    // The agent streams: a delta, then the final text.
    const sid = h.sent[0].id
    h.agentBus.emit('event', {
      id: sid,
      chatId: 'c1',
      event: {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'On ' } }
      }
    })
    expect(await phone.next()).toEqual({ t: 'delta', chatId: 'c1', text: 'On ' })
    h.agentBus.emit('event', {
      id: sid,
      chatId: 'c1',
      event: {
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'On it.' }] }
      }
    })
    expect(await phone.next()).toMatchObject({
      t: 'event',
      event: { seq: 3, data: { kind: 'assistant', text: 'On it.' } }
    })

    // A guardrail approval appears in the log; the phone answers it.
    h.gates.set('gate-7', true)
    h.hookBus.emit('approval', {
      requestId: 'gate-7',
      workspaceId: 'w1',
      sessionId: 'sess-1',
      toolName: 'Bash',
      preview: 'rm -rf build',
      expiresAt: Date.now() + 120000
    })
    expect(await phone.next()).toMatchObject({
      t: 'event',
      event: { data: { kind: 'approval', id: 'gate-7', toolName: 'Bash' } }
    })
    phone.send({
      t: 'req',
      id: 'r2',
      method: 'approval.answer',
      params: { id: 'gate-7', approve: true }
    })
    const frames = [await phone.next(), await phone.next()]
    expect(frames.find((f) => f.t === 'res')).toMatchObject({ id: 'r2', ok: true })
    expect(frames.find((f) => f.t === 'event')).toMatchObject({
      event: { data: { kind: 'approval_end', outcome: 'approved', by: 'ios' } }
    })
    // Answering twice reports "gone".
    phone.send({
      t: 'req',
      id: 'r3',
      method: 'approval.answer',
      params: { id: 'gate-7', approve: false }
    })
    expect(await phone.until((f) => f.t === 'res')).toMatchObject({
      id: 'r3',
      ok: false,
      error: { code: 'gone' }
    })

    // Reconnect after "backgrounding": ask for everything after seq 3.
    phone.ws.close()
    const again = new FakePhone(secret)
    await again.connect()
    again.send({ t: 'hello', v: 1, device: 'iphone-1', token, app: 'ios/0.1' })
    await again.next() // welcome
    again.send({ t: 'subscribe', chatId: 'c1', afterSeq: 3 })
    const catchUp = await again.next()
    expect(catchUp).toMatchObject({ t: 'event', event: { seq: 4, data: { kind: 'approval' } } })
    expect(await again.next()).toMatchObject({
      t: 'event',
      event: { seq: 5, data: { kind: 'approval_end' } }
    })
    again.ws.close()
  })

  it('refuses a bad token and an old protocol', async () => {
    const phone = new FakePhone(secret)
    await phone.connect()
    phone.send({ t: 'hello', v: 1, device: 'iphone-1', token: 'nope', app: 'ios/0.1' })
    expect(await phone.next()).toEqual({ t: 'bye', reason: 'unauthorized' })
    const old = new FakePhone(secret)
    await old.connect()
    old.send({ t: 'hello', v: 0, device: 'iphone-1', token, app: 'ios/0.0' })
    expect(await old.next()).toEqual({ t: 'bye', reason: 'version' })
  })
})

// Keep TS happy about unused imports pulled in for the mock factory above.
void EventEmitter
void generateKeyPairSync
void createPrivateKey
void createPublicKey
void sign
