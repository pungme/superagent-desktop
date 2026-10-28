import {
  setHidReporter,
  endHidSession,
  hidReadyWith,
  sendHidWith,
  stopAllHid,
  type HidAction
} from './sim-hid-core'

/**
 * The simulator's input, in a process of its own.
 *
 * A touch used to go window → main → siminput and back, one move at a time, so
 * whenever main was busy (saving a long chat, an agent's output) the finger on
 * the simulator stopped where it was. Here nothing else runs: the pane talks
 * to this process over a port of its own, and main's own requests (the
 * agent's sim_tap and friends) come down the parent port. One owner per
 * device's siminput, whoever asks.
 */

interface Request {
  op: 'init' | 'port' | 'send' | 'ready' | 'end' | 'stop'
  id?: number
  bin?: string
  udid?: string
  action?: HidAction
}

interface Port {
  on(event: 'message', fn: (e: { data: Request }) => void): void
  postMessage(msg: unknown): void
  start(): void
}

const parent = (
  process as unknown as {
    parentPort: {
      on(event: 'message', fn: (e: { data: Request; ports: Port[] }) => void): void
      postMessage(msg: unknown): void
    }
  }
).parentPort

let bin: string | null = null
setHidReporter((line) => parent.postMessage({ log: line }))

async function handle(m: Request): Promise<unknown> {
  const udid = String(m.udid ?? '')
  switch (m.op) {
    case 'send':
      return udid && m.action ? sendHidWith(bin, udid, m.action) : null
    case 'ready':
      return udid ? hidReadyWith(bin, udid) : false
    case 'end':
      endHidSession(udid)
      return true
    case 'stop':
      stopAllHid()
      return true
    default:
      return null
  }
}

parent.on('message', (e) => {
  const m = e.data
  if (m.op === 'init') {
    bin = m.bin ?? null
    return
  }
  if (m.op === 'port') {
    const port = e.ports[0]
    if (!port) return
    port.on('message', (pe) => {
      void handle(pe.data).then((result) => port.postMessage({ id: pe.data.id, result }))
    })
    port.start()
    return
  }
  void handle(m).then((result) => parent.postMessage({ id: m.id, result }))
})
