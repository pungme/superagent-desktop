# SuperAgent iOS companion — implementation plan

Status: plan, 2026-08-28. Covers both repos: `superagent/desktop` (Electron) and `superagent/ios` (SwiftUI).
Research behind the choices: https://claude.ai/code/artifact/006cb8ac-1128-4238-b190-6119c1e2f497

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **The Mac dials out. Works from anywhere, guaranteed.** The desktop app keeps one outbound WebSocket to a relay; the phone connects to the same relay. No inbound ports, no router configuration, no dependence on the ISP. | Outbound-only is the only design that works behind every NAT/CGNAT/hotel/corporate network — it is what Anthropic Remote Control, Codex, Cursor and Happy all do. Direct reach (router port mapping / IPv6) is an optional latency optimization for later, never a requirement. |
| D1b | **The relay is ours and blind.** ~500 lines of Node, open source, forwards ciphertext it cannot read, stores nothing durable. The project runs the default instance (baked-in URL); anyone can run their own with one Docker command and point both apps at it. | Zero third parties: the project is the operator. Blindness means a relay compromise leaks only machine ids and timing. Stateless means it is trivial to run and to replace. |
| D2 | **Desktop is the source of truth.** Phone is a thin subscriber to a per-chat, append-only, sequence-numbered event log. No CRDT. | Single writer (the agent). Phone reconnects cold every time iOS suspends it; `afterSeq` replay is all it needs. |
| D3 | **End-to-end encryption at the application layer with a per-device key from the QR.** Frames are ChaCha20-Poly1305 under keys derived (HKDF-SHA256) from a 32-byte secret that the QR carries and that is stored per paired phone. Transport to the relay is ordinary TLS with system CA validation. | Both CryptoKit and `node:crypto` have X25519/HKDF/ChaCha20-Poly1305 natively — zero native modules, ~80 lines per side, no handshake to get wrong. Per-device secret ⇒ per-device revocation. Forward secrecy (ephemeral ECDH ratchet) is a v2 upgrade behind the same frame format. |
| D4 | **Push notifications are sent by the desktop app directly to APNs** with the user's own `.p8` key, configured in Settings. | You build the iOS app yourself, so the key is yours. Removes the only "project server" every OSS app has needed. Only an App Store build for strangers would need a forwarder — not in scope. |
| D5 | **Foreground-first on iOS.** Live streaming while open; push + notification actions while not. | iOS gives no legitimate way to keep a socket open in the background. |
| D6 | **Transcript wire format is owned by main**, projected from Claude's `stream-json`. The renderer's `Item[]` is not the wire format. | `chats.data` is renderer-serialized UI state (`EasyChat.tsx:43`). Coupling the phone to it means every UI tweak breaks the phone. |
| D7 | **Real tool approvals** ship as a new permission mode (`ask`) via the `PermissionRequest` hook — after the transport works. | Today the desktop runs `bypassPermissions`; only the prompt-injection guardrail prompts. Phone approvals are the headline feature only if there is something to approve. |

Non-goals for v1: multiple Macs per phone (schema allows it, UI doesn't), file editing from the phone, the desktop metaphor / Computer panel, browser driving from the phone (screenshots only), Android.

## 1. Topology

```
 iPhone (anywhere) ── wss:// ──►  RELAY  ◄── wss:// (outbound, always on) ── Mac · SuperAgent
        │                      blind pipe                                        │
        │                    per machine id                                      │
        │  (app closed)                                                          │  APNs HTTP/2, user's own .p8
        └───────────────────────── Apple Push ◄──────────────────────────────────┘
```

- **Mac side** (`companion/relay-client.ts`): on launch, open `wss://<relay>/m/<machineId>` and keep it open (ping 25 s, reconnect with backoff 1→30 s, re-run on `powerMonitor` resume / network change). `machineId` = hex of the Mac's Ed25519 public key; the relay challenges with a nonce and the Mac signs it, so nobody else can claim the id. Everything after that is opaque frames.
- **Phone side**: open `wss://<relay>/c/<machineId>`; the relay pipes bytes between the phone and that machine's socket. Several phones may attach; the Mac multiplexes them by a per-connection id the relay stamps on each frame envelope.
- **Relay** (`superagent-relay`, separate tiny repo or `desktop/relay/`): Node + `ws`, in-memory only: `Map<machineId, {mac: WebSocket, clients: Map<connId, WebSocket>}>`. Envelope `{c: connId, d: <base64 ciphertext>}`. Limits: 64 KB per frame, 2 MB/s per machine, 8 clients per machine, idle close 60 s. No accounts, no database, no logs of payloads. Health endpoint, Dockerfile, `fly.toml`. Default URL baked into both apps, overridable in Settings (Mac) and per-machine (phone) — the QR carries the relay URL so a self-hosted relay needs no phone-side setup.
- **Why no ring buffer in the relay**: the Mac owns the event log (§3.2). A phone that reconnects sends `afterSeq`; the Mac replays. The relay never needs to remember anything.
- **Encryption** (§2.5): per device, from the QR secret. The relay and its TLS never see plaintext.
- Nothing is required on the user's network. No inbound port on the Mac in v1. Direct reach (router mapping / IPv6, dialed in parallel as a faster path) is a possible M5 optimization behind the same frame format.

## 2. Wire protocol (`protocol v1`)

JSON text frames over WebSocket. All frames have `t` (type). Shared TypeScript definitions live in `src/shared/companion-protocol.ts` (desktop) and are mirrored by `Sources/Protocol/Frames.swift` (iOS); a JSON fixture set in `desktop/app/src/shared/fixtures/companion/*.json` is decoded by both test suites so drift fails CI.

### 2.1 Connection

```
→ hello    { t, v: 1, device: string, token: string, app: "ios/0.1.0" }
← welcome  { t, machine: { name, appVersion, protocol: 1 }, tree: Group[] , chats: ChatSummary[] }
← bye      { t, reason: "unauthorized" | "revoked" | "version" }
```
All frames after the relay envelope are encrypted (§2.5); `hello` is the first decrypted frame and carries the device token so the Mac can bind the connection to a paired phone. A frame that fails to decrypt or a `hello` with an unknown token closes that client connection (`bye: unauthorized`). Pairing (§2.4) is the one flow that starts without a device token — it uses the QR secret directly.

### 2.2 Subscriptions and the event log

```
→ subscribe   { t, chatId, afterSeq: number }
← event       { t, chatId, seq, ts, kind, data }        // sequenced, persisted, replayable
← delta       { t, chatId, text }                        // ephemeral streaming text; never persisted
← status      { t, workspaceId, status: "idle"|"working"|"needs-you" }
→ unsubscribe { t, chatId }
```

`event.kind` and `data` (the projection of Claude's stream-json, done in main):

| kind | data | source |
|---|---|---|
| `user` | `{ id, text, images?: [{mediaType, size}], from: "desktop"\|"ios" }` | `agent:send` handler / companion `chat.send` |
| `assistant` | `{ id, text }` (final text of a block; deltas were ephemeral) | `content_block_stop` for text blocks |
| `thinking` | `{ id, text }` | thinking block stop |
| `tool` | `{ id, name, detail }` | `assistant` message `tool_use` blocks (`EasyChat.tsx:1691` logic moved to main) |
| `tool_result` | `{ toolId, ok, summary }` | `user` message `tool_result` blocks |
| `diff` | `{ id, file, hunks }` | Edit/Write tool inputs, same derivation the renderer does today |
| `turn_end` | `{ ok, subtype, costUsd?, tokens? }` | `result` |
| `session` | `{ claudeSessionId, model }` | `system/init` |
| `notice` | `{ text }` | resume-lost, missing cwd, API error messages (`isApiErrorMessage`) |
| `approval` | `{ id, toolName, preview, kind: "guardrail"\|"permission", expiresAt }` | `requestApproval` (`hooks.ts:60`) and, later, `PermissionRequest` |
| `approval_end` | `{ id, outcome: "approved"\|"denied"\|"expired", by: "desktop"\|"ios" }` | resolve / timeout |

Ordering guarantee: `seq` is per chat, monotonically increasing, assigned in main at insert time. A client that sees `seq != last + 1` on the live path drops the frame and re-subscribes with `afterSeq: last` (Happier's rule; never advance the cursor from your own request's response).

### 2.3 RPC

```
→ req  { t, id, method, params }
← res  { t, id, ok: true, result } | { t, id, ok: false, error: { code, message } }
```

v1 methods (each maps onto an existing main-process function; nothing new is invented):

| method | maps to | notes |
|---|---|---|
| `tree.list` | `getTree()` behind `store:tree` (`store.ts:954`) | groups + workspaces |
| `chat.list` | `chat:listAll` (`store.ts:1169`) | |
| `chat.send` | `sendToAgent` (`agent.ts:465`) — starts a session first via `startAgent` if none is alive for the chat | images as base64, ≤ 5 MB total |
| `chat.interrupt` | `hardInterruptAgent` (`agent.ts:515`) | |
| `chat.create` | `chat:create` handler (`store.ts:1211`) | optional in v1 |
| `approval.answer` | `resolveGate` in `hooks.ts` (the function behind `guardrail:resolve` (`hooks.ts:379`)) | `{ id, approve, trustRest }`; idempotent, first answer wins, expired → error `gone` |
| `routines.list` / `routines.runNow` | `routines.ts` | |
| `board.list` | `listCards` (`store.ts:689`) | read-only |
| `screenshot.take` | `browser:shoot` handler (`browser.ts:867`) | JPEG, ≤ 512 KB, only for browser workspaces |
| `device.presence` | — | `{ active: bool }`; suppresses push while the phone is on screen |

### 2.4 Pairing

```
Mac UI: Settings → Phone → "Pair a phone" → shows QR + 6-digit code, 120 s TTL, single use
QR payload (base64url JSON, ≈ 180 bytes):
  { v:1, name, relay: "wss://superagent-relay.superagent-relay.workers.dev", m: "<machineId>", k: "<32-byte device secret, base64url>" }

Phone: scans → connects to relay /c/<machineId> → derives keys from k → sends (encrypted)
→ pair     { t, device: { id, name, model, pushToken? } }
← paired   { t, token: "<32 bytes>", machine: { name, appVersion } }        // Mac stores k + token hash for this device
Both screens show the same 6-digit code = first 6 digits of SHA-256(k ‖ machineId); the Mac requires a click on Accept.
Mac UI: "iPhone 16 Pro paired" toast; device listed with Revoke button.
```

- `k` is generated fresh per pairing and is only valid until the Mac's pairing screen closes (120 s) or a `pair` succeeds; a photo of the QR taken later is worthless. Accept on the Mac is the human check that the phone that connected is the one in your hand.
- Revoking a device deletes its secret and token; its frames stop decrypting and its relay connection is closed with `bye: revoked`.

### 2.5 Encryption

- Keys: `root = k` (32 bytes from the QR). `key_m2p = HKDF-SHA256(root, salt=machineId, info="sa-m2p")`, `key_p2m = HKDF(…, info="sa-p2m")`. Separate directions, so nonces never collide.
- Frame: `nonce(12) ‖ AES-256-GCM(key_dir, nonce, plaintextJSON, aad=machineId ‖ direction)`. Nonce = 64-bit counter per direction per connection, prefixed by a 32-bit random connection salt; counter must strictly increase (replay protection). AAD binds the frame to the connection so a relay cannot splice frames between phones.
- Rekey: a new connection picks a new salt; the 64-bit counter cannot realistically wrap. Forward secrecy (X25519 ephemeral exchange in `hello`/`welcome`, ratcheting the keys) is a v2 change that touches only this section.
- Implementations: Node `crypto.createCipheriv("aes-256-gcm", …)` + `hkdfSync`; Swift `AES.GCM.seal/open` + `HKDF<SHA256>`. ChaCha20-Poly1305 was the first choice but Electron's BoringSSL does not expose it through createCipheriv. Interop verified by shared test vectors in the fixture set.



## 3. Desktop changes (`superagent/desktop/app`)

### 3.1 Refactor first: main owns agent events (prerequisite for everything)

Today `startAgent(owner: WebContents, …)` writes every event straight to `owner.send('agent:event:<id>', …)` (`agent.ts:366-381`) and sessions die with their owner (`killSessionsOwnedBy`, `agent.ts:189`). The companion needs to both *hear* events and *start* sessions with no window involved.

- `src/main/agent.ts`
  - Add an `EventEmitter` (`agentBus`) emitting `event`, `stderr`, `exit`, `resume-lost` with `{ id, chatId, workspaceId, payload }`.
  - `owner` becomes optional; the existing `owner.send(...)` calls become one subscriber installed by `registerAgentIpc` (bridge `agentBus` → `WebContents`). Behaviour for the renderer is unchanged.
  - `AgentSession` gains `chatId`, `workspaceId`, `opts` (so a session can be found by chat, and restarted by the companion with the same options).
  - New `findSessionByChat(chatId)`, `ensureSession(chatId, opts)`.
  - `sendToAgent` also emits a `user` event on the bus (so both UIs and the log see phone-originated messages). Renderer: `EasyChat` subscribes to a new `agent:user:<id>` channel and appends a `msg` item when `from !== "desktop"`.
  - Ownerless sessions are not killed by `killSessionsOwnedBy`; they are killed by `killAllAgents` on quit as today.
- Tests: `agent-args.test.ts` already covers `buildAgentArgs`; add `agent-bus.test.ts` with a fake child process (spawn stub) asserting NDJSON → bus events.

### 3.2 Event log

- `src/main/store.ts`: new table
  ```sql
  CREATE TABLE IF NOT EXISTS chat_events (
    chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq    INTEGER NOT NULL,
    ts     INTEGER NOT NULL,
    kind   TEXT NOT NULL,
    data   TEXT NOT NULL,
    PRIMARY KEY (chatId, seq)
  );
  ```
  plus `appendChatEvent(chatId, kind, data): number` (returns seq; single `INSERT … SELECT COALESCE(MAX(seq),0)+1` in a transaction) and `listChatEvents(chatId, afterSeq, limit)`.
- `src/main/transcript.ts` (new, pure, unit-tested): `projectStreamEvent(raw, state): WireEvent[]` — the stream-json → `event.kind` projection from §2.2. Port the relevant branches of `handleEvent` (`EasyChat.tsx:1550-2000`); keep per-session projection state (open text block id, tool ids) in a small class. `EasyChat` keeps its own rendering logic for now (D6 says wire ≠ UI); a follow-up can make the renderer consume the same projection.
- `src/main/companion/log.ts` (new): subscribes to `agentBus`, runs the projector, appends to `chat_events`, fans out to connected phones. Keeps a per-chat in-memory ring buffer (last 500 events) so replay of a fresh reconnect never hits SQLite.
- **Backfill**: on first `subscribe` for a chat with zero `chat_events`, project the legacy `chats.data` `Item[]` into synthetic events once (`projectLegacyItems(items)` in `transcript.ts`) and persist them. Old chats become readable on the phone without a migration pass at startup.
- Retention: none in v1 (events are small; transcripts already live in `chats.data`). Cascade delete with the chat.

### 3.3 Companion (relay client + protocol)

New directory `src/main/companion/`:

| file | responsibility |
|---|---|
| `identity.ts` | Ed25519 machine keypair generated on first run, stored via `safeStorage` in `userData/companion/`; `machineId` = hex(pubkey). |
| `relay-client.ts` | The always-on outbound WebSocket to the relay: nonce challenge/signature, ping 25 s, backoff reconnect, resume on wake/network change; demultiplexes relay envelopes into per-phone `ClientConn`s; exposes `state: connected | reconnecting | offline` for the tray and Settings. |
| `crypto.ts` | §2.5: HKDF key derivation, seal/open with counter nonces and AAD, per-device key cache. Pure; unit-tested against the shared vectors. |
| `devices.ts` | `devices` table: `id, name, model, secret (safeStorage-encrypted), tokenHash, pushToken, pushEnv, createdAt, lastSeenAt`. Token compared via hash + `timingSafeEqual`; revoke closes live conns. |
| `pairing.ts` | One outstanding pairing at a time; generates `k`; 120 s TTL; single use; renders the QR payload and the 6-digit code; requires Accept. |
| `session.ts` | One per authenticated phone connection: subscriptions, `send()`, backpressure (drop `delta`s when the relay socket's `bufferedAmount` > 4 MB, never `event`s). |
| `rpc.ts` | Method table from §2.3; params validated with the `zod` already in deps. |
| `keepalive.ts` | `powerSaveBlocker.start('prevent-app-suspension')` while a phone is connected, or while a session is working and ≥ 1 phone is paired; release otherwise. |
| `index.ts` | `startCompanion()` from `app.whenReady` after `startHookServer()` (`index.ts:188`); `registerCompanionIpc()` for Settings. |

- Dependencies to add: `ws` (MIT, pure JS). No native modules, no Info.plist changes, no macOS network prompts (an outbound `wss://` needs nothing).
- Relay URL: `kv` key `companion.relay`, default the project instance; changing it re-pairs nothing (the QR carries the URL, phones store it per machine).

- Approvals: in `hooks.ts`, `requestApproval` additionally appends an `approval` event and pushes; the existing `guardrail:resolve` IPC path is refactored into an exported `resolveGate(requestId, approve, trustRest, by)` that both the renderer and `rpc.ts` call, and that appends `approval_end` + `broadcastToWindows('guardrail:resolved')` (already exists, `hooks.ts:70`).
- Status: `hook:event` broadcast (`hooks.ts:147`) is mirrored to phones as `status` frames.

### 3.4 Push (direct to APNs)

- `src/main/companion/push.ts`: HTTP/2 client (`node:http2`) to `api.push.apple.com` / `api.sandbox.push.apple.com`; ES256 JWT from the user's `.p8` (`crypto.sign('sha256', …, { dsaEncoding: 'ieee-p1363' })`), cached ≤ 50 min. Payload: `{ aps: { alert: { title, subtitle, body }, category, "interruption-level": "time-sensitive", "thread-id": chatId }, chatId, approvalId?, machine }`.
- Triggers: `approval` event (always, unless the device reported `presence.active` in the last 30 s); `Stop` hook with the existing `notifyPrefs.done` (`hooks.ts:29`); `Notification` hook (`needsYou`).
- Settings UI (renderer `Settings.tsx`, new "Phone" section): relay status (connected / reconnecting) and URL; paired devices + Revoke; "Pair a phone" (QR modal); push: key file picker (`.p8` copied into `userData/companion/`), Key ID, Team ID, bundle id (default `dev.pungme.superagent.ios`), sandbox/production toggle, "Send test push".
- Everything push-related is optional: without a key the phone still works whenever it is open.

### 3.5 Staying reachable

- Window close no longer quits on macOS (already true via `window-all-closed`, `index.ts:392`), but `before-quit` (`index.ts:385`) still kills agents — unchanged; Cmd-Q means quit.
- Tray item (new `src/main/tray.ts`): status dot (idle / working / needs-you), "Open SuperAgent", "Pair a phone…", "Quit". Opt-in via Settings ("Show in menu bar").
- `keepalive.ts` above. Document the lid-closed-on-battery limitation in onboarding copy.

### 3.6 `ask` permission mode (D7) — as built

- `PermissionMode` gains `'ask'` (`state.ts`, picker in `EasyChat.tsx`, `agent.ts`). `buildAgentArgs` passes `--permission-mode default` **and** `--permission-prompt-tool mcp__cove-browser__permission_prompt`: headless `claude -p` cannot show a prompt, so Claude Code calls that MCP tool instead (verified on 2.1.251 — the `PermissionRequest` hook alone is *not* consulted in `-p` mode; the write was auto-denied).
- `mcp.ts` registers `permission_prompt`: it calls `requestApproval(…, 'permission')` (580 s budget), which broadcasts to the window (`GuardrailPrompt` in its Ask copy) and records an `approval` event for phones; the first answer — Mac modal or `approval.answer` from a phone — wins, and the tool returns `{behavior:"allow", updatedInput}` / `{behavior:"deny", message}`.
- The `PermissionRequest` hook is also registered in `~/.claude/settings.json` (interactive sessions launched elsewhere could use it later); `hooksInstalled()` requires it so older installs re-merge.
- Verified live: Ask mode, "create hello.txt" from the phone → approval card on the phone → Approve → file written → reply.

### 3.7 Desktop test plan

- Unit (vitest): projector (`transcript.test.ts`, fixtures from real stream-json captures), crypto seal/open + nonce rules against shared vectors, pairing/token logic, RPC validation, APNs JWT shape, `chat_events` seq assignment.
- Integration (vitest, real sockets): start the relay in-process on a random port, boot `startCompanion()` against a temp `userData` pointed at it, pair with a Node test client using the QR payload, subscribe, feed a fake agent through `agentBus`, assert replay-after-reconnect, dedupe, and that a revoked device is cut off.
- Relay (its own vitest suite): pipe semantics, per-machine limits, machine-offline answer, that payloads are never logged.
- E2E (Playwright, existing harness): "Pair a phone" modal renders a QR whose payload decodes; Revoke closes the socket.

## 4. iOS changes (`superagent/ios`)

### 4.1 Targets

| target | purpose | milestone |
|---|---|---|
| `SuperAgent` (app) | everything below | M1 |
| `SuperAgentTests` | protocol fixtures, connection state machine, store | M1 |
| `SuperAgentNotifications` (Notification Service Extension) | later: decrypt / enrich pushes; v1 pushes are plaintext metadata so this is deferred | M5 |
| `SuperAgentActivity` (Widget extension) | Live Activity for a running turn with Approve button | M5 |

Capabilities: Push Notifications, Time Sensitive Notifications, App Groups (`group.dev.superagent`) once the extensions land. Info.plist: `NSCameraUsageDescription` (QR). No local-network keys, no ATS exceptions.

### 4.2 Source layout

```
SuperAgent/Sources/
  App/            SuperAgentApp.swift, AppState.swift (single @Observable root), Router
  Protocol/       Frames.swift (Codable mirrors of §2), WireEvent.swift, Fixtures decoding tests
  Connection/     RelayTransport.swift (URLSessionWebSocketTask to wss://<relay>/c/<machineId>, envelope codec),
                  Crypto.swift (HKDF + ChaChaPoly seal/open, counter nonces, AAD — mirrors §2.5),
                  Connection.swift (actor: hello/welcome, ping, backoff 1→30 s, resubscribe with lastSeen on reconnect),
                  RPC.swift (continuations keyed by id, 30 s timeout)
  Pairing/        PairScannerView.swift (DataScannerViewController / AVFoundation fallback), PairFlow.swift
  Store/          MachineStore.swift (Keychain: relay URL, machineId, device secret k, token; kSecAttrAccessibleAfterFirstUnlock),
                  TranscriptStore.swift (per chat: events[], lastSeq; persisted as JSON in Application Support,
                  GRDB is a follow-up if transcripts get large)
  Features/
    Machines/     MachinesListView (paired Macs, connection state, "Pair a Mac")
    Workspaces/   WorkspaceListView (groups → workspaces → chats, status dots)
    Chat/         ChatView (transcript list, streaming row, tool rows collapsed, diff rows), Composer,
                  ApprovalBanner (inline) + ApprovalSheet
    Settings/     SettingsView (remote URL per Mac, notifications, about)
  Push/           PushRegistration.swift (token → `device.pushToken` RPC), NotificationActions.swift
                  (categories APPROVAL: Approve (.authenticationRequired) / Deny; DONE: Open)
```

### 4.3 Behaviours that matter

- **One transport**: the relay. Foreground → connect, `hello`, resubscribe. No endpoint logic, no network permissions, no SSID checks. If the Mac is offline the relay answers `machine-offline` and the app shows "MacBook is unreachable — asleep or offline" with the cached transcript.
- **Resume**: `TranscriptStore.lastSeq[chatId]` drives `subscribe.afterSeq`; frames with a gap trigger re-subscribe; `delta` frames render into a transient streaming row that is replaced by the sequenced `assistant` event.
- **Self-hosted relay support**: the QR carries the relay URL, so a user running their own relay never types anything on the phone.
- **Approve from a notification**: `userNotificationCenter(_:didReceive:)` runs inside `beginBackgroundTask`, opens a short-lived relay connection, sends `approval.answer`, shows a local confirmation on failure ("Couldn't reach your Mac — open the app"). Works from any network because both sides only ever dial out.
- **Presence**: send `device.presence {active:true}` on foreground, `{active:false}` on background (within the ~30 s grace), so the Mac doesn't push while you are looking at the chat.
- **Send with images**: PhotosPicker → JPEG ≤ 1.5 MB each, base64 in `chat.send`.

### 4.4 iOS test plan

- Swift Testing: decode every fixture in `fixtures/companion/*.json` (shared with desktop) — CI fails on drift; seal/open against the shared crypto vectors; connection state machine with a stub transport; a frame with a stale counter is rejected.
- Manual: simulator ↔ desktop dev build through a local relay (`npm run relay` on the Mac, URL `ws://localhost:8787`), then real device on LTE through the hosted relay.

## 5. Milestones

| M | Scope | Done when | Est. |
|---|---|---|---|
| **M1 · Foundations (desktop)** | §3.1 agent bus, §3.2 event log + projector + backfill, shared protocol types + fixtures | `chat_events` fills for every live chat; old chats backfill; renderer unchanged; unit tests green | 1 wk |
| **M2 · Relay + pair + stream from anywhere** | The relay (repo, Docker, deployed default instance); §3.3 identity, relay client, crypto, pairing, devices, RPC; Settings "Phone"; iOS: app skeleton, QR pairing, relay transport + crypto, transcript view, composer | On LTE, anywhere: scan the QR shown on the Mac, watch a live turn, send a prompt from the phone and see it on the desktop; background the app and come back to a correct replay. Same flow works against a self-hosted relay by changing one URL on the Mac | 2.5 wks |
| **M3 · Always on + approvals** | Tray + keepalive (§3.5), relay reconnect hardening (sleep/wake, network flaps), approvals over the wire (guardrail kind), in-app approval UI, "Mac unreachable" states | Close the lid and reopen, switch Wi-Fi↔LTE: the phone recovers without user action. Approve a guardrail prompt from the phone; desktop modal closes | 1 wk |
| **M4 · Push + `ask` mode** | Push composed on the Mac, sent by the relay (holds the APNs key); presence suppression; notification actions; §3.6 `ask` permission mode via the MCP prompt tool | Phone locked in another room: agent asks for approval → push with Approve/Deny → tap Approve → tool runs; "done" push arrives after the turn. Built; push verified with `simctl push` (real APNs needs the signed build + key) | 2 wks |
| **M5 · Polish** | Live Activity for a running turn, NSE for richer/encrypted push content, screenshots for browser workspaces, routines run-now, GRDB store if needed, TestFlight; optional direct-reach fast path (router mapping / IPv6) dialed in parallel with the relay; forward-secrecy ratchet | Nice-to-haves; each independently shippable | ongoing |

Total to "usable from anywhere with approvals": ~6.5 weeks of focused work. M1+M2 alone (≈ 3.5 weeks) gives a phone that follows your Mac from anywhere, on any network, with no configuration beyond scanning a QR.

## 6. Risks and how the plan handles them

- **`EasyChat.tsx` stays the renderer's own projector for now.** Two projectors (main for the wire, renderer for the UI) can drift. Mitigation: the fixture set is shared; a follow-up milestone makes the renderer consume `chat_events`. Not in the critical path.
- **Ownerless sessions change lifecycle assumptions.** Reload-kills-sessions (`killSessionsOwnedBy`) exists for good reasons; ownerless sessions must be tracked in the Settings/tray UI so they are never invisible. Companion-started sessions adopt the window as owner once the renderer opens that chat.
- **The relay is a standing obligation** — a small one (stateless, one container, a few € a month), but it must stay up for the baked-in default to work. Mitigations: health checks + alerting, the Mac Settings shows relay status, the URL is overridable, the relay repo has a one-command self-host path, and the Mac can be given a *list* of relays to try in order (v1.1).
- **Relay abuse**: anyone can connect to `/c/<machineId>` if they know the id. They get ciphertext they cannot read and a connection the Mac drops on the first undecryptable frame. Per-machine client cap (8) and byte-rate limits stop floods; the machine id is not printed anywhere but the QR.
- **No forward secrecy in v1**: a leaked device secret decrypts that device's past traffic captured at the relay. Acceptable for v1 given the relay is ours and stores nothing; the X25519 ratchet is scoped as a v2 change to §2.5 only.
- **Mac sleep**: `powerSaveBlocker` doesn't beat a closed lid on battery. Onboarding says so; the tray shows "reachable / asleep" state to the user.
- **Certificate rotation**: none in v1 (10-year self-signed). Re-pairing handles a regenerated cert.
- **APNs from the desktop is a per-user setup step** (`.p8`, ids). It is optional and documented with screenshots; the "Send test push" button makes it verifiable.
- **Protocol drift between repos**: fixtures decoded by both test suites; `protocol` version in `hello`/`welcome`; desktop refuses older majors with `bye: version`.

## 7. Open questions (decide before M2 ends)

1. Relay hosting: Fly.io (closest region to you, ~€3/mo, `fly.toml` in repo) vs a Hetzner VM. Both fine; Fly is less to maintain. Domain for the default URL (e.g. `relay.superagent.dev`).
2. Should `chat.send` from the phone be allowed to *start* a chat whose Claude session isn't running (spawns `claude` headless on the Mac)? Plan says yes; confirm it's wanted for routines-style "kick off work from the train".
3. Do we mirror `delta` frames into the desktop renderer for phone-originated turns, or let the renderer keep consuming raw `agent:event`? (Plan: raw, unchanged.)
