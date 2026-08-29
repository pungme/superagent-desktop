import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { CompanionState } from '../../../preload'

/**
 * Settings → Phone. Pair an iPhone (a QR + a code you confirm), see which
 * phones are paired and connected, revoke one, and — for people who run
 * their own relay — point the Mac at it.
 */

const DEFAULT_RELAY = 'wss://superagent-relay.superagent-relay.workers.dev'

function encodePayload(p: object): string {
  const json = JSON.stringify(p)
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `superagent://pair#${b64}`
}

export function PhoneSettings(): React.JSX.Element {
  const [state, setState] = useState<CompanionState | null>(null)
  const [qr, setQr] = useState<{ k: string; url: string } | null>(null)
  const [relayDraft, setRelayDraft] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  // Short-lived feedback: which phone just got a test banner, and the phone
  // that just paired (so accepting doesn't silently collapse into the list).
  const [tested, setTested] = useState<{ id: string; ok: boolean } | null>(null)
  const [justPaired, setJustPaired] = useState<string | null>(null)
  const knownIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    // A device that shows up while the page is open just paired: say so,
    // instead of letting Accept silently collapse into the list.
    const absorb = (s: CompanionState): void => {
      const ids = new Set(s.devices.map((d) => d.id))
      const known = knownIds.current
      const fresh = known ? s.devices.find((d) => !known.has(d.id)) : undefined
      knownIds.current = ids
      if (fresh) {
        setJustPaired(fresh.name)
        setTimeout(() => setJustPaired(null), 8000)
      }
      setState(s)
    }
    void window.cove.companionState().then(absorb)
    const off = window.cove.onCompanionState(absorb)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      clearInterval(tick)
      // Leaving the page ends any pairing in progress — the QR is gone anyway.
      window.cove.companionPairCancel()
    }
  }, [])

  // Render the QR whenever a pairing opens; keyed by its secret so a stale
  // image never shows for a newer pairing.
  const payload = state?.pairing.open ? state.pairing.payload : undefined
  useEffect(() => {
    if (!payload) return
    let alive = true
    QRCode.toDataURL(encodePayload(payload), { errorCorrectionLevel: 'M', margin: 1, width: 256 })
      .then((url) => alive && setQr({ k: payload.k, url }))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [payload])

  if (!state) return <section className="settings-section" />

  const pairing = state.pairing
  const request = pairing.request
    ? { device: pairing.request.device, code: pairing.code ?? '' }
    : null
  const qrUrl = qr && payload && qr.k === payload.k ? qr.url : null
  const secondsLeft =
    pairing.open && pairing.expiresAt ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  const relayLabel =
    state.relay.state === 'connected'
      ? 'Connected'
      : state.relay.state === 'reconnecting'
        ? 'Reconnecting…'
        : 'Offline'

  return (
    <section className="settings-section">
      <div className="phone-intro">
        <strong>Your iPhone, anywhere.</strong>
        <span>
          Pair the SuperAgent app on your phone once. From then on it follows this Mac from any
          network — no accounts, no router settings.
        </span>
      </div>

      {/* Pairing */}
      {!pairing.open ? (
        <div className="settings-row">
          <div className="settings-label">
            <strong>Pair a phone</strong>
            <span>
              Open SuperAgent on your iPhone, tap Pair, and scan the code that appears here.
            </span>
          </div>
          <button
            className="phone-btn primary"
            onClick={() => void window.cove.companionPairStart()}
          >
            Show pairing code
          </button>
        </div>
      ) : (
        <div className="phone-pair">
          <div className="phone-qr-wrap">
            {qrUrl ? (
              <img className="phone-qr" src={qrUrl} alt="Pairing QR code" />
            ) : (
              <div className="phone-qr" />
            )}
          </div>
          <div className="phone-pair-text">
            {request ? (
              <>
                <strong>{request.device.name} wants to pair</strong>
                <span>Check that your phone shows the same code, then accept.</span>
                <div className="phone-code" aria-label="Pairing code">
                  {request.code.slice(0, 3)} {request.code.slice(3)}
                </div>
                <div className="phone-pair-actions">
                  <button
                    className="phone-btn"
                    onClick={() => window.cove.companionPairDecide(false)}
                  >
                    Not my phone
                  </button>
                  <button
                    className="phone-btn primary"
                    onClick={() => window.cove.companionPairDecide(true)}
                  >
                    Accept
                  </button>
                </div>
              </>
            ) : (
              <>
                <strong>Scan with your iPhone</strong>
                <span>In the SuperAgent app: Pair a Mac → point the camera here.</span>
                <div className="phone-code" aria-label="Pairing code">
                  {pairing.code?.slice(0, 3)} {pairing.code?.slice(3)}
                </div>
                <span className="phone-muted">
                  Your phone will show this code too. Expires in {secondsLeft}s.
                </span>
                <div className="phone-pair-actions">
                  <button className="phone-btn" onClick={() => window.cove.companionPairCancel()}>
                    Cancel
                  </button>
                  {/* No camera handy (or a simulator)? The same link, as text. */}
                  <button
                    className="phone-btn"
                    onClick={() => {
                      if (!pairing.payload) return
                      window.cove.clipboardWrite(encodePayload(pairing.payload))
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1800)
                    }}
                  >
                    {copied ? 'Copied ✓' : 'Copy link'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Devices */}
      <div className="phone-devices">
        <div className="phone-subhead">Paired phones</div>
        {justPaired && (
          <div className="phone-just-paired" role="status">
            <span className="phone-dot on" aria-hidden />
            Paired with {justPaired}. It&apos;s connected and follows this Mac from anywhere now.
          </div>
        )}
        {state.devices.length === 0 ? (
          <div className="phone-muted phone-empty">No phone paired yet.</div>
        ) : (
          state.devices.map((d) => {
            const online = state.connected.includes(d.id)
            return (
              <div className="settings-row" key={d.id}>
                <div className="settings-label">
                  <strong>
                    <span className={`phone-dot ${online ? 'on' : ''}`} aria-hidden />
                    {d.name}
                  </strong>
                  <span>
                    {online
                      ? 'Connected now'
                      : d.lastSeenAt
                        ? `Last seen ${relative(d.lastSeenAt, now)}`
                        : 'Never connected'}
                    {d.pushToken
                      ? ' · notifications on'
                      : ' · no notifications yet — open the app on the phone and allow them'}
                  </span>
                </div>
                <div className="phone-device-actions">
                  {d.pushToken && (
                    <button
                      className="phone-btn"
                      onClick={() => {
                        void window.cove.companionTestPush(d.id).then((ok) => {
                          setTested({ id: d.id, ok })
                          setTimeout(() => setTested(null), 4000)
                        })
                      }}
                    >
                      {tested?.id === d.id
                        ? tested.ok
                          ? 'Sent — check the phone'
                          : "Couldn't send"
                        : 'Test notification'}
                    </button>
                  )}
                  <button
                    className="phone-btn danger"
                    onClick={() => window.cove.companionRevoke(d.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Relay */}
      <div className="phone-relay">
        <div className="phone-subhead">Connection</div>
        <div className="settings-row">
          <div className="settings-label">
            <strong>
              <span
                className={`phone-dot ${state.relay.state === 'connected' ? 'on' : state.relay.state === 'reconnecting' ? 'warn' : ''}`}
                aria-hidden
              />
              {relayLabel}
            </strong>
            <span>
              {state.relay.state === 'connected'
                ? 'This Mac is reachable by your phone.'
                : state.relay.error || 'Trying to reach the relay…'}
              {state.keepAwake ? ' Staying awake while a phone is watching.' : ''}
            </span>
          </div>
          {state.relay.state !== 'connected' && (
            <button className="phone-btn" onClick={() => window.cove.companionReconnect()}>
              Retry
            </button>
          )}
        </div>
        <div className="settings-row">
          <div className="settings-label">
            <strong>Keep this Mac awake while a phone is paired</strong>
            <span>
              Normally it stays awake only while a phone is connected or an agent is working. Turn
              this on for a Mac that lives at home as the agent box. Closing the lid still sleeps it
              (macOS rule) unless it&apos;s on power with a display attached.
            </span>
          </div>
          <label className="phone-switch">
            <input
              type="checkbox"
              checked={state.keepAwakeAlways}
              onChange={(e) => window.cove.companionSetKeepAwake(e.target.checked)}
            />
            <span>{state.keepAwakeAlways ? 'On' : 'Off'}</span>
          </label>
        </div>
        <div className="settings-row">
          <div className="settings-label">
            <strong>Relay</strong>
            <span>
              The meeting point both devices dial out to. It only ever sees encrypted data. Running
              your own? Put its address here.
            </span>
          </div>
          <div className="phone-relay-edit">
            <input
              className="phone-input"
              value={relayDraft ?? state.relay.url}
              onChange={(e) => setRelayDraft(e.target.value)}
              spellCheck={false}
              placeholder={DEFAULT_RELAY}
            />
            {relayDraft !== null && relayDraft.trim() !== state.relay.url && (
              <button
                className="phone-btn primary"
                onClick={() => {
                  window.cove.companionSetRelay(relayDraft.trim() || DEFAULT_RELAY)
                  setRelayDraft(null)
                }}
              >
                Use
              </button>
            )}
          </div>
        </div>
        <div className="phone-muted phone-machine">Machine id {state.machineId.slice(0, 12)}…</div>
      </div>
    </section>
  )
}

function relative(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
