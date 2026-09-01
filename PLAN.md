# Superagent — a friendly home for Claude Code

> **Build status (v1 shipped, then reshaped from real use — see §8 #19–#25):** All milestones M0–M5 built, tested, committed on `main`. Since v1 the Terminal/Easy split was replaced by **one persistent, resumable Chat mode**, plus **Browser projects** with real-website automation, an omnibar, and a file tree. 28 unit + 7 Electron e2e tests green; every feature verified end-to-end. Remaining before public release: real code-signing/notarization (needs Apple Developer account), and the v1.1 multi-agent adapters (M6). See §8 iteration log below.


> Working title: **Superagent** (placeholder — rename anytime).
> One-liner: *The Arc browser of terminals — a clean, tab-grouped workspace where Claude Code builds your projects and can drive a built-in browser to check its own work.*

---

## 1. Vision & product principles

**Who it's for:** the semi-prosumer — someone who can install Claude Code, knows what a folder and a dev server are, but doesn't live in tmux. They want to run Claude Code on 1–5 projects, see what it's doing, and preview the website it's building — without configuring anything.

**Reference points:**
- **cmux** (manaflow-ai) — proves the concept: vertical tabs, notifications, embedded scriptable browser, agent-first terminal. But it's native Swift/AppKit, macOS-power-user-flavored, Ghostty-config-driven — "composable primitives, not solutions." Superagent is the opposite philosophy: **solutions, not primitives.**
- **OpenAI Codex desktop app** — the design north star: calm, spacious, chat-adjacent polish. Feels like a consumer app, not a terminal.
- **Arc browser** — sidebar interaction model: groups/spaces, drag-to-organize, colorful but tidy.

**Principles:**
1. **Zero-config by default.** Open a folder → get a Claude session. No dotfiles, no flags.
2. **The terminal is real.** Under the clean chrome is a genuine PTY running the genuine `claude` CLI — nothing re-implemented, nothing that breaks when Claude Code updates.
3. **Show, don't log.** Agent status is a glanceable badge, not scrollback archaeology.
4. **The agent can see the browser.** Claude Code checks its own work in the built-in browser — screenshots, clicks, console errors — visibly, in front of the user.
5. **Never surprise the user.** Automation happens in Superagent's browser pane only (never the user's personal browser), with a visible indicator and a stop button.
6. **Superagent ships no AI.** No API keys, no model calls, no AI backend, no per-user billing. All intelligence is the user's own agent (their Claude Code subscription; later their Codex/Gemini login) — interactively in the terminal, and headlessly (`claude -p`) for Routines. Superagent is pure plumbing: terminal + browser + MCP tools + scheduler + UI. This keeps Superagent's running costs ~zero, avoids the entire billing/abuse problem servus-ai has to manage with its own Gemini backend, and means Superagent gets smarter for free every time the user's agent upgrades.

---

## 2. Architecture decisions

### 2.1 App shell: **Electron** (chosen) vs Tauri vs native Swift

| Option | Verdict | Why |
|---|---|---|
| **Electron + React + TypeScript** | ✅ **Chosen** | Mature xterm.js + node-pty ecosystem; `WebContentsView` gives a *real Chromium* embedded browser that speaks CDP (Chrome DevTools Protocol) — which is the entire enabler for feature #4. Cross-platform door stays open. VS Code proves the perf is fine for this use case. |
| Tauri | ❌ | Lighter, but the system webview (WKWebView on macOS) has no CDP → browser automation becomes the hardest problem instead of a solved one. PTY story (Rust `portable-pty`) is workable but the ecosystem is thinner. |
| Native Swift/AppKit (the cmux route) | ❌ | Best performance, but highest effort, macOS-only forever, and the polished-web-app UI we want (Codex-like) is *easier* to build with web tech than AppKit. |

### 2.1b Will it feel native? (honest answer)

Electron will never be *literally* native like cmux (Swift/AppKit). But "feels native" to our target user is mostly a checklist, and every item on it is achievable in Electron — Linear, Notion, Slack, and VS Code all pass the prosumer sniff test. What we must do to pass it:

- [ ] **Hidden title bar with inset traffic lights** (`titleBarStyle: 'hiddenInset'`) — the single biggest tell
- [ ] **macOS vibrancy/translucency on the sidebar** (`vibrancy: 'sidebar'`) — instant Arc/Finder feel
- [ ] **Real native menu bar** with full standard menus (App/File/Edit/View/Window) and correct role items
- [ ] System font stack (SF Pro via `-apple-system`), native context menus (Electron `Menu.popup`, not styled divs)
- [ ] Correct scroll physics (WebKit default is fine — never hijack scrolling), standard shortcuts (⌘, for settings, ⌘W closes tab not window)
- [ ] 60fps interactions: WebGL terminal, `transform`-only animations, no layout thrash on sidebar drag
- [ ] Fast cold start: defer everything but window + sidebar + first terminal (< 1.5s target)
- [ ] Native notifications, dock badge counts, proper app icon at all sizes

What we accept: ~150–250 MB baseline memory vs cmux's tens of MB, and purists will notice. If v1 lands and native-ness becomes the #1 complaint, the escape hatch is Tauri (same React UI, Rust core) — but that trades away CDP browser automation, which is our differentiator. **Decision stands: Electron, with the checklist above treated as P0 features, not polish.**

### 2.2 Terminal: **xterm.js (WebGL addon) + node-pty**, running the real `claude` CLI

- Each terminal tab = a `node-pty` process in the main process, streamed over IPC to an `xterm.js` instance in the renderer.
- Claude Code's full-screen TUI renders fine in xterm.js (it's what VS Code's terminal uses).
- Scrollback, links (via `WebLinksAddon`), search (`SearchAddon`), GPU rendering (`WebglAddon`).
- Plain shell tabs are also available (it's still a terminal), but the *primary* action is "New Claude session".

### 2.3 In-app browser: **Electron `WebContentsView`** + CDP

- One browser pane per workspace, shown as a split or a tab.
- Automation via `webContents.debugger.attach()` (raw CDP) — screenshots, DOM queries, input events, console/network capture. If raw CDP gets painful, fall back to `playwright-core.connectOverCDP()` against the same view.
- Hard isolation: `contextIsolation: true`, no node integration, its own `session` partition per workspace.

### 2.4 Claude Code integration: **PTY-first, hooks for status, MCP for the browser**

- **Session launch:** Superagent spawns `claude` with injected args (`--mcp-config` pointing at Superagent's browser-automation MCP server config). The user can also type `claude` manually — that works too, just without the browser tools (documented; see Iteration log #1 for the mitigation).
- **Status detection:** Superagent installs (with one-time consent) Claude Code **hooks** — `Notification`, `Stop`, `SessionStart` — that POST to Superagent's local HTTP endpoint. This drives sidebar badges: 🟢 working / 🟡 needs you / ⚪ idle. Fallback: OSC 9 terminal notification sequences parsed from the PTY stream.
- **Resume:** Superagent remembers `session_id` per tab (from hook payloads) and offers "Resume" (`claude --resume <id>`) after app restart.

### 2.5 Browser automation bridge: **a local MCP server built into Superagent**

The keystone feature. Superagent's main process runs an MCP server (HTTP transport on localhost, random port + auth token per launch) exposing tools that operate on the workspace's `WebContentsView`:

| Tool | Does |
|---|---|
| `browser_navigate(url)` | Load a URL in the workspace browser pane |
| `browser_screenshot()` | Returns image content of the current viewport |
| `browser_snapshot()` | Accessibility-tree/DOM snapshot with element refs (text, cheap, preferred over screenshots) |
| `browser_click(ref)` / `browser_type(ref, text)` / `browser_press(key)` | Input, dispatched via CDP `Input.*` |
| `browser_evaluate(js)` | Run JS in page, return result |
| `browser_console()` | Recent console messages (errors first) |
| `browser_network()` | Recent failed/slow requests |
| `browser_wait_for(text \| selector, timeout)` | Wait for content |

Design choices:
- **Snapshot-first** (like Playwright MCP's a11y-tree approach) so the model doesn't need vision for every step; screenshots for visual checks.
- Tools are scoped to the calling session's workspace → its browser pane, never another workspace's.
- Every tool invocation flashes an indicator on the browser pane ("Claude is browsing…") with a **Stop** button that revokes the debugger attachment.

### 2.6 Agent adapter layer — Claude Code first, Codex CLI & Gemini CLI supported

Because Superagent is PTY-first, *any* CLI agent already runs in it. "Support" beyond that means four integration points, so we build one **AgentAdapter** interface from day one (M2) and never hardcode Claude:

```ts
interface AgentAdapter {
  id: 'claude' | 'codex' | 'gemini'
  detect(): InstallStatus                    // binary present? logged in? version?
  launch(workspace): { cmd, args, env }      // how to start a session
  injectBrowserMcp(workspace): void          // wire Superagent's browser MCP into this agent
  statusSource(): 'hooks' | 'notify' | 'osc' // how "working / needs-you / idle" is detected
  resume(sessionId): { cmd, args } | null
  skills: SkillsFormat                       // where its skills/commands live (see §3.6)
}
```

| Integration point | Claude Code | OpenAI Codex CLI | Gemini CLI |
|---|---|---|---|
| Launch | `claude` | `codex` | `gemini` |
| Browser MCP | `--mcp-config` / project `.mcp.json` | project `.codex/config.toml` `[mcp_servers]` (or `codex mcp add`) | project `.gemini/settings.json` `mcpServers` |
| Status | Hooks (`Notification`/`Stop`) → local endpoint | `notify` hook / command hooks | OSC fallback (+ whatever hook surface exists at build time) |
| Resume | `--resume <id>` | session picker | `--resume`-equivalent, verify at build time |
| Skills/commands | `.claude/skills`, `.claude/commands` | `~/.codex/prompts` | `.gemini/commands` |

**Tiering:** Claude Code is first-class (v1, fully tested). Codex + Gemini adapters are **v1.1 fast-follows** — the adapter seam ships in v1 so they're additive work, not surgery. The MCP browser server itself is agent-agnostic (it's just MCP), so feature #4 and Routines work with all three; Routines' headless executor gets per-agent equivalents (`claude -p` / `codex exec` / `gemini -p`).

The sidebar shows which agent a session runs (small logo on the tab), and "New session" becomes a split-button: default agent + dropdown. Default agent is a one-time onboarding choice (changeable in settings).

### 2.7 State & persistence

- `electron-store` (JSON) for settings; **SQLite** (better-sqlite3) for workspaces/tabs/groups/session history.
- Restore on launch: sidebar structure, working dirs, which tabs had Claude sessions (offer resume), browser URLs. Scrollback restore is a non-goal for v1.

---

## 3. Feature specs

### 3.1 Left sidebar with groups (Arc-style)

- **Model:** `Group` (name, color, emoji) → `Workspace` (a project folder) → `Tabs` (claude / shell / browser).
  In v1, simplify: sidebar shows **Groups → Workspaces**; each workspace opens as a tab strip of its own panes. (See Iteration log #2.)
- Drag-and-drop workspaces between groups; reorder groups.
- Workspace row shows: folder name, git branch, status badge (working / needs-you / idle), detected dev-server port chip (clickable → opens browser pane).
- Collapse groups; keyboard: `⌘1–9` jump to workspace, `⌘T` new Claude session, `⌘D` split.
- New-user default: single "My projects" group so the concept doesn't need explaining upfront.

### 3.2 In-app browser

- Address bar (with localhost autocomplete from detected ports), back/forward/reload, "open in real browser" escape hatch, DevTools toggle (behind a "developer" setting — prosumers don't need it staring at them).
- **Port detection:** watch the workspace's PTY output for `localhost:\d+` / "Local:" patterns (Vite, Next, CRA all print these) → toast: "Dev server detected → Open preview". Simpler and more reliable than lsof-polling; lsof scan as a backup on demand.
- Auto-reload-on-idle option: when the Claude session goes idle (Stop hook), reload the preview.
- Layout: browser docks right of the terminal (split), or full-tab. Remember per workspace.

### 3.3 Clean prosumer UI

- **Design language:** Codex-app calm — one accent color, generous whitespace, SF-adjacent type (Inter), true light/dark, no terminal-nerd chrome by default. Terminal theme matched to app theme.
- **Onboarding flow (first launch):** check `claude` binary → if missing, guided install; check login state (`claude` exits with auth prompt) → walk through it; then "Open a project folder" → drops user into a running Claude session with a hint bar ("Type what you want to build").
- Plain-language surfaces: "Claude needs your OK" instead of raw permission-prompt jargon in the *badge/notification layer* (the terminal itself stays untouched — principle #2).
- Notifications: native macOS notifications when a background workspace needs input or finishes (from hooks). Click → focuses that workspace.
- Settings: one page, few options. Model picker, theme, notification toggles, "developer mode" (DevTools, verbose).

### 3.4 Browser automation for the user (not just plumbing)

What the semi-prosumer actually experiences:
- They type "check that the signup form works" → Claude uses `browser_*` tools → they *watch the built-in browser* navigate and click, with the "Claude is browsing" indicator.
- A "🔍 Check my site" quick-action button that pre-fills a prompt ("Open the preview, click through the main flows, report anything broken — with screenshots").
- All automation confined to Superagent's embedded browser. Never the system browser, never other apps.

---

### 3.5 Routines — scheduled natural-language browser automation

*"Please visit this website every hour and check X"* — typed once, runs on a schedule. Design ported from the proven implementation in `launci/servus-ai` (Tauri app, `desktop/src-tauri/src/browser.rs` + `app/src/hooks/use-browser-schedules.tsx`), adapted to Superagent's Electron + Claude stack.

**What servus-ai got right (and Superagent copies):**

1. **The NL prompt *is* the stored artifact.** A routine is just `{prompt, intervalMs, nextRunAt, enabled, lastRunStatus, lastRunSummary}` — the user's own wording, re-planned fresh by the agent on every fire. No brittle recorded step lists, no cron syntax (interval + simple daily/weekly kinds only, so both humans and LLMs can produce valid values). Created two ways: a form in the UI, or Claude calling a `create_routine` MCP tool mid-conversation ("…and check it every morning" → tool call).
2. **Two webviews, one cookie jar.** A visible browser pane (user browses, logs in) + an offscreen *agent* webview sharing the same Electron `session` partition. The user logs into a site once by hand; scheduled runs reuse those cookies invisibly, without stealing the viewport. This sidesteps the entire headless-browser-auth nightmare.
3. **Local ticker, not server cron.** Sessions live in the local cookie jar, so scheduling must be local: a 60s ticker — in Superagent's *main process* (survives renderer reloads; `powerMonitor` skips ticks during sleep). App closed = nothing runs (shown honestly in the UI: "Runs while Superagent is open").
4. **One catch-up run max on reopen.** Missed slots are dropped, `nextRunAt` advances — never a burst of back-to-back runs that trips rate limits.
5. **Guardrails from production pain:** max hops per run, 5-min wall-clock budget, repeated-identical-call detection (*including successful calls* — catches loops), consecutive-failure cap, and history compaction (keep only the latest page-read result; older ones truncated).
6. **Indexed-element page reading.** `read_page` returns numbered visible interactive elements (`{index, tag, role, text, …}`, capped ~200) + a `click_text` fallback (more durable than indices, which shift when modals open) + a ~6s SPA-hydration poll so an empty React shell isn't mistaken for "logged out". This upgrades the `browser_snapshot` tool spec in §2.5.

**Superagent-specific execution model:** each routine tick spawns a headless `claude -p "<routine prompt>"` (print mode, user's existing subscription) with Superagent's browser MCP config scoped to the *agent* webview, plus the guardrails above enforced app-side. Results land in a per-routine run log (status, one-line summary, final screenshot); failures raise a native notification.

**Interval floor: 60 minutes**, enforced in UI and on write; the `create_routine` tool description instructs Claude to push back on sub-hour requests instead of silently accepting.

**Honest limits (shown in UI, not buried):** many platforms (Instagram, X, LinkedIn…) prohibit automated actions like mass-following and actively detect bots — routines are built for *your own* sites and for checking/monitoring; third-party-site automation is at the user's own risk and may get accounts flagged. Superagent does not ship anti-bot fingerprint evasion (servus-ai's stealth shims are deliberately **not** ported).

### 3.5b Easy Mode — Claude Code as a clean chat, not a terminal (user request, BUILT)

Two ways to work in every workspace, toggled in the toolbar:
- **Terminal** — the real `claude` TUI in xterm (power users, full fidelity).
- **Easy** — a calm Codex-style chat: user bubbles, streamed assistant replies, friendly tool cards ("⌘ Running a command", "🌐 navigate", "✏️ Editing a file") instead of raw tool JSON, and a thinking indicator.

**How, without shipping any AI (principle #6):** Easy Mode spawns the *same* `claude` binary in streaming mode — `claude -p --output-format stream-json --input-format stream-json --include-partial-messages --verbose` — kept alive to read one JSON user message per line from stdin. Superagent parses the event stream (`stream_event` text deltas → live typing; `assistant` tool_use blocks → tool cards; `result` → turn end) and renders chat. Same binary, same subscription, same MCP browser tools (per-workspace config injected), same hooks. It's a *view* over Claude Code, not a reimplementation.

Gotcha learned in build: in stream-json input mode `claude` emits nothing until the first user message, so the composer must enable on process start, not on the `init` event (that deadlocks). `claude` is resolved to an absolute path via a login shell so `spawn` finds it outside the terminal's PATH.

### 3.6 Skills library — surface agent skills like first-class features

Claude Code already has a skills system (`~/.claude/skills/<name>/SKILL.md`, project `.claude/skills/`) and slash commands (`.claude/commands/*.md`) — but they're invisible unless you know the dotfiles. Superagent makes them visible and prosumer-friendly:

- **Skills panel** per workspace: lists installed skills/commands (parsed from the global + project dirs), each with name + description, one click → runs it in the session (types `/name` into the PTY — nothing re-implemented, principle #2).
- **"Save as skill":** after a good session, one button asks Claude to distill what it just did into a proper `SKILL.md` in the project — turning a one-off prompt into a reusable button. This is how prosumers build up a toolbox without ever learning the format.
- **Starter pack:** Superagent ships 3–5 skills on first run ("Check my site" from §3.4 becomes a real Claude skill, "Fix what's broken on this page", "Make it look better on mobile") — so the panel is never empty and demonstrates the concept.
- **Cross-agent:** each Superagent starter skill is stored canonically and exported to each agent's native format (Claude `SKILL.md`, Codex `~/.codex/prompts/*.md`, Gemini `.gemini/commands/*.toml`) via the adapter's `skills` field. User-created skills export on demand ("Also make available to Codex/Gemini").
- Non-goal: a skills marketplace/registry. v1 reads local dirs + ships starters; discovery of community skills is a later idea.

## 4. Milestones & full TODO list

### M0 — De-risk spikes (throwaway code allowed)
- [ ] Scaffold: `electron-vite` + React + TS + Tailwind; main/preload/renderer wiring
- [ ] Spike: node-pty ↔ xterm.js round trip; run `claude` full TUI; verify rendering, resize, colors, mouse
- [ ] Spike: `WebContentsView` embedded browser positioned inside React layout (it's a native overlay — verify z-order/scroll behavior with sidebar/splits)
- [ ] Spike: `webContents.debugger` CDP — take screenshot, dispatch click, read console
- [ ] Spike: minimal MCP server (HTTP) with one tool; launch `claude --mcp-config …`; confirm tool call round-trips and image content renders in Claude's context
- [ ] Spike: Claude Code hook (`Notification`/`Stop`) POSTing to local endpoint; confirm payload has `session_id`
- [ ] **Gate:** all five spikes green before committing to the stack

### M1 — Terminal shell MVP
- [ ] PTY manager in main process (spawn/kill/resize, env setup, cwd per workspace)
- [ ] Terminal component (xterm + WebGL + links + search addons), theme sync
- [ ] Workspace model + SQLite persistence (groups, workspaces, tabs, order)
- [ ] Sidebar UI: groups (create/rename/color/collapse), workspace rows, drag-and-drop (dnd-kit)
- [ ] Tab strip per workspace; splits (terminal | terminal)
- [ ] "Open folder → workspace" flow; recent projects
- [ ] Keyboard shortcuts (⌘1–9, ⌘T, ⌘W, ⌘D, ⌘K command palette — palette can slip to M5)
- [ ] Session restore (structure + cwd; not scrollback)
- [ ] Git branch display (cheap: read `.git/HEAD`, watch for changes)

### M2 — Claude Code integration
- [ ] "New Claude session" primary action (spawns `claude` with Superagent env + mcp-config)
- [ ] Hook installer with consent screen (writes to `~/.claude/settings.json`, additive & reversible; detect and merge with existing hooks)
- [ ] Local HTTP endpoint for hook events (auth token via env var passed only to Superagent-spawned processes)
- [ ] Status badges from hook events; OSC-sequence fallback parser
- [ ] Native notifications (needs-input / finished) + click-to-focus
- [ ] Session tracking (session_id ↔ tab) + "Resume" on restart
- [ ] Onboarding: detect claude binary, install guide, auth walkthrough
- [ ] Graceful handling: claude not installed / not logged in / version too old (`claude --version` check)

### M3 — In-app browser
- [ ] Browser pane (WebContentsView) with per-workspace session partition
- [ ] Address bar + nav controls + "open in system browser"
- [ ] Split layout: terminal | browser, draggable divider, remembered per workspace
- [ ] Dev-server port detection from PTY output → "Open preview" toast + port chip in sidebar
- [ ] Reload-on-idle option
- [ ] DevTools toggle (developer mode)
- [ ] Crash/white-screen recovery (webContents crashed → reload button)

### M4 — Browser automation (MCP bridge)
- [ ] MCP server in main process (HTTP transport, per-launch auth token, localhost only)
- [ ] Tool: navigate, screenshot, snapshot (a11y tree w/ refs), click, type, press, evaluate, console, network, wait_for
- [ ] Workspace scoping (session → its own browser pane only)
- [ ] `--mcp-config` injection on Superagent-spawned sessions; docs for manual sessions
- [ ] Pre-approve Superagent's browser tools in spawned session (settings `allowedTools`) so the user isn't spammed with permission prompts — behind a consent toggle
- [ ] "Claude is browsing" indicator + Stop button (detaches debugger, fails pending tool calls cleanly)
- [ ] Quick action: "🔍 Check my site" canned prompt
- [ ] Guardrail: refuse navigation to non-localhost origins unless user enabled "allow external sites" (default: localhost + 127.0.0.1 only)

### M4b — Routines (scheduled automation)
- [ ] Routine model + SQLite table (`prompt, intervalMs, nextRunAt, enabled, lastRunStatus, lastRunSummary`)
- [ ] Main-process ticker (60s), `powerMonitor` sleep handling, one-catch-up-run-max on launch
- [ ] Offscreen agent `WebContentsView` per workspace, sharing the visible pane's session partition
- [ ] Headless run executor: `claude -p` + browser MCP scoped to agent webview; hop/wall-clock/repeat/failure guardrails; history compaction
- [ ] `create_routine` MCP tool (+ push-back-on-sub-hour instruction in its description)
- [ ] Routines UI: list, enable/disable toggle, "run now", per-run log with summary + final screenshot
- [ ] Failure notifications (native), "needs login" detection → prompt user to log in via the visible pane
- [ ] Upgrade `browser_snapshot` to servus-style indexed-element read + `click_text` + SPA-hydration poll
- [ ] ToS/risk copy in the routine-creation flow

### M4c — Skills panel
- [ ] Parse Claude skills/commands dirs (global + project); watch for changes
- [ ] Skills panel UI (name, description, run button → types `/name` into PTY)
- [ ] "Save as skill" flow (canned prompt asking Claude to write the SKILL.md)
- [ ] Starter pack: 3–5 shipped skills incl. "Check my site"
- [ ] Canonical skill format + exporters (Claude now; Codex/Gemini exporters land with M6)

### M5 — Polish, packaging, ship
- [ ] Design pass: spacing/type/color audit against Codex-app bar; empty states; micro-animations
- [ ] Command palette (⌘K) if slipped from M1
- [ ] E2E test harness: Playwright-for-Electron smoke suite (launch app → open workspace → spawn shell → open browser pane); runs in CI on every Electron/claude version bump
- [ ] Prerequisite: Apple Developer account ($99/yr) for signing/notarization — enroll early, approval can take days
- [ ] App icon, DMG, code signing + notarization, auto-update (electron-updater)
- [ ] Crash reporting + opt-in anonymous usage metrics
- [ ] Performance: 10 workspaces × active PTYs; memory ceiling check; WebGL context loss handling
- [ ] Docs site / README with 90-second demo GIF
- [ ] Private beta with 5–10 target-profile users; fix the top 10 papercuts before public

### M6 — Multi-agent adapters (v1.1 fast-follow)
- [ ] Codex CLI adapter: detect/launch, MCP via project `.codex/config.toml`, status via `notify`/hooks, `codex exec` for Routines
- [ ] Gemini CLI adapter: detect/launch, MCP via project `.gemini/settings.json`, OSC status fallback, headless mode for Routines
- [ ] Split-button "New session" with agent picker; per-tab agent logo; default-agent setting
- [ ] Skills exporters for Codex prompts + Gemini commands
- [ ] Onboarding paths for Codex/Gemini login detection
- [ ] Smoke tests per agent in CI (launch, MCP round-trip, status event)

---

## 5. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `WebContentsView` fights the DOM layout (it's a native overlay, not a DOM element) | High | M0 spike; keep browser pane rectangular and dock-only (no fancy overlap); known-solved in apps like modern Electron browsers |
| node-pty native module / Electron ABI pain | Medium | Pin Electron version, `electron-rebuild` in CI, prebuilt binaries |
| Claude Code CLI flags/hooks change under us | Medium | Version-check on launch; integration smoke test in CI against latest claude; degrade gracefully (badges off, terminal still works) |
| Permission-prompt fatigue (MCP tools) | High | Pre-approved tool allowlist with consent; scoped to localhost |
| Agent browses while user is also clicking | Medium | Input lock during tool bursts + indicator + Stop |
| Scope creep toward "full IDE" | High | Principles doc; v1 feature freeze at the 4 core features |
| xterm.js quirks with Claude's TUI (cursor, alt-screen, resize storms) | Low–Med | M0 spike; VS Code terminal parity is the benchmark |

## 6. Non-goals for v1 (explicit)

- Windows/Linux (Electron keeps the door open; macOS first)
- ~~Multi-agent support~~ **Revised (v6):** Codex CLI + Gemini CLI are now planned v1.1 fast-follows via the AgentAdapter seam (§2.6), which ships in v1. Only the *polish/testing* of those adapters is out of v1 scope.
- Skills marketplace / community skill discovery (local skills + starter pack only, §3.6)
- Cloud/remote workspaces, SSH (cmux territory)
- Re-implemented chat UI over the Agent SDK (v2 candidate: "Simple mode" chat surface for the same session)
- Scrollback persistence, tmux integration, custom terminal config
- **Parallel Claude sessions in one workspace** (cmux's headline feature). v1: one Claude session per workspace + any number of plain shell tabs. Running many agents on many *projects* (one each) is fully supported — that's what groups are for. Parallel-agents-per-project (worktrees etc.) is a v2 candidate once the basics feel great.

## 7. Open questions (decide during M0–M1)

1. Real name + icon (Superagent is a placeholder)
2. ~~Distribution~~ **Decided (v6): open source, MIT.** Consequences: never port code from GPL cmux or from servus-ai (design patterns only); no secrets in repo ever (servus-ai's committed OAuth secret is the cautionary tale); public-repo hygiene from day one (LICENSE ✅, README, CONTRIBUTING later); unsigned builds are fine for source users while the Apple account is pending.
3. Does "group" = Arc "Space" (one visible at a time) or all groups visible stacked? **Current call: stacked** (simpler mental model for prosumers).
4. Browser: one pane per workspace (current call) vs multiple browser tabs — revisit after beta feedback.
5. Minimum Claude Code version to support.

## 8. Iteration log

**v1 → v2 (self-review pass 1):**
- #1 *Gap:* manually-typed `claude` sessions wouldn't get browser tools. *Change:* documented mitigation — Superagent also writes a workspace-level `.mcp.json` **only with user consent per project** (checkbox at workspace creation: "Let Claude use the preview browser in this project"), so manual sessions get tools too; env auth token exported to all Superagent shells.
- #2 *Gap:* Arc-style "tabs inside groups" was conflated with "workspaces". *Change:* clarified hierarchy Group → Workspace → Panes; groups organize *projects*, not raw tabs. Matches the prosumer mental model ("my sites", "experiments").
- #3 *Gap:* No safety story for automation on arbitrary sites. *Change:* default localhost-only navigation guardrail (M4).
- #4 *Gap:* Status detection relied solely on hooks (user could decline install). *Change:* OSC fallback parser; badges degrade, app still works.
- #5 *Change:* snapshot-first tool design (a11y tree) instead of screenshot-first — cheaper tokens, more reliable clicking.

**v2 → v3 (self-review pass 2):**
- #6 *Sequencing:* moved MCP spike and hook spike into M0 — they're the riskiest integrations, not M4 details.
- #7 *Cut:* multiple browser tabs per workspace, scrollback restore, command palette (slip-allowed) — v1 diet.
- #8 *Added:* success metrics (below), beta step in M5, crash recovery for browser pane, Electron-ABI risk row.
- #9 *Clarified:* GPL contamination note (open question 2) — don't port cmux code.
- #10 *Added:* input-lock during automation bursts; "Check my site" quick action to make feature #4 discoverable to non-techies.

**v3 → v4 (final review pass):**
- #11 *Added:* E2E smoke-test harness (Playwright-for-Electron) in CI — without it, every Electron or Claude Code version bump is a blind upgrade.
- #12 *Added:* Apple Developer account as an explicit M5 prerequisite (signing/notarization is a calendar dependency, not just a task).
- #13 *Decided:* one Claude session per workspace in v1; parallel-agents-per-project explicitly deferred to v2 — the single sharpest scope cut vs cmux, and the right one for the target user.

**v4 → v5 (user feedback pass):**
- #14 *Added:* §2.1b "Will it feel native?" — honest assessment + a P0 native-feel checklist (hiddenInset title bar, sidebar vibrancy, native menus/context menus, cold-start budget). Electron decision re-affirmed with Tauri named as the measured escape hatch.
- #15 *Added:* §3.5 Routines — scheduled natural-language browser automation (from servus-ai learnings; see that section).

**v5 → v6 (user feedback pass 2):**
- #16 *Added:* Principle 6 — **Superagent ships no AI.** All intelligence is the user's own agent subscription (interactive PTY + `claude -p` for Routines); Superagent is plumbing only. No API keys, no backend, no billing.
- #17 *Added:* §2.6 AgentAdapter layer — Codex CLI and Gemini CLI promoted from non-goal to v1.1 fast-follow (M6); adapter seam ships in v1 so nothing is Claude-hardcoded. Verified integration surfaces: Codex `.codex/config.toml` `[mcp_servers]` + hooks/`notify`; Gemini `.gemini/settings.json` `mcpServers` + custom commands.
- #18 *Added:* §3.6 Skills library + M4c — surface Claude Code skills/commands in a visible panel, "Save as skill" flow, starter pack, cross-agent export. Marketplace explicitly a non-goal.

**v6 → v7 (post-ship, from real use):**
- #19 *Pivot:* dropped the Terminal/Easy two-mode split for **one persistent Chat mode** (user: "something in the middle that persists forever, saved locally"). The transcript is stored in SQLite and the claude session is resumed via `--resume` next launch. Removed the terminal path entirely (TerminalPane, `node-pty`, `@xterm/*`).
- #20 *Added:* **project types** — a Code project (a folder) or a folder-less **Browser project** (browser-first, for automation), chosen at creation.
- #21 *Reversed #3:* removed the localhost-only automation guardrail — driving **real websites** is the whole point of Browser projects/routines. Browser projects also get an appended system prompt steering Claude to the cove-browser tools over WebSearch/WebFetch.
- #22 *Added:* a real **omnibar** (URL-or-search with history autocomplete), the **file tree** panel, and last-preview-URL restore across restarts.
- #23 *Reliability:* fixed the `--resume` fallback (a missing session was masked by SessionStart *hook* stdout, stranding the chat on a silent "Starting…"); added an error banner + Retry; hide the native browser view under slide-overs/modals; routine try/finally so a failed run can't wedge; offscreen-pane cleanup.
- #24 *Security/data:* atomic `~/.claude/settings.json` writes; a `will-navigate` guard so the shell can't be navigated away; explicit main-window webPreferences; symlink-cycle-safe file walk.
- #25 *Quality:* end-to-end verified every feature over CDP; unit + e2e now **28 + 7** green; README refreshed; icon-only buttons labeled for a11y.

**v7 → v8 (post-launch-prep):**
- #26 *Assessed, not scheduled:* **Windows** — see §10. The port is cheap (six platform checks, no Mac-only dependencies, `win:`/`nsis:` already configured) and the product is not: the iOS Simulator pane cannot exist there and the Computer would be a rewrite. Deferred rather than refused; the door §2.1 left open is still open.
- #27 *Decided:* the three repositories stay under the personal account until after the Product Hunt launch. Transfers redirect and lose nothing, but they put the Pages custom domain (superagent.computer) and every installed app's update path in play — not in launch week.

## 9. Success metrics (v1 beta)

- Time from DMG open → first Claude response: **< 3 min** (including auth)
- A tester with no terminal background can: create 2 groups, run 2 projects, preview a site, and ask Claude to test a page — **without docs**
- Claude completes a "check this page" task via MCP tools with **≥ 90%** tool-call success (no manual retry)
- Memory < 1 GB with 5 workspaces active

## 10. Windows (assessed 31 Aug 2026 — not scheduled)

§2.1 chose Electron partly to keep the cross-platform door open. This is what
is actually behind that door, read off the code rather than estimated from
memory.

### What already crosses

Every runtime dependency is cross-platform, `electron-builder.yml` already
carries `win:` and `nsis:` blocks, dictation loads ONNX Runtime WASM from disk
rather than a CDN (`scripts/copy-ort.mjs`), and the whole codebase contains
**six** `process.platform` checks. The browser pane, chats, SQLite, the file
tree, the board, routines, pairing, the relay and the phone are all
platform-agnostic today.

### What cannot cross, ever

**The iOS Simulator pane.** `main/simulator.ts` (1053 lines) drives `simctl`,
with two native helpers beside it — `native/simfb.m` (Objective-C) and
`baguette`. There is no iOS Simulator on Windows. This is one of the four
things in the product's own one-line description.

### What is a rewrite, not a port

**The Computer.** `main/environment.ts` and `main/desktop.ts` drive the Mac
through `osascript`. The Windows equivalent is PowerShell and UI Automation —
the same shape, none of the same code.

### What is ordinary work

- Rebuilding `better-sqlite3`; finding where node-pty actually comes from (it
  is not in `package.json`) and what it needs from ConPTY.
- Path handling and shell spawning: the agent side assumes a POSIX shell in
  more places than the six platform checks suggest.
- Code signing. Notarization has no Windows counterpart — an OV or EV
  certificate (a few hundred a year) or every download meets SmartScreen.
  Auto-update through NSIS + electron-updater is fine.
- A Windows machine to test on, forever.

### Estimate and verdict

Three to five days for a Windows build that genuinely works for the browser,
chat, files and phone. The simulator: never. The Computer: separately, if at
all.

Not hard — **lopsided**. Two of the four distinctive features are the two that
cannot cross, so a Windows user would get a good agent chat with a real browser
beside it, which is the part every competitor also has. If demand appears after
launch, the honest version ships without the simulator and the Computer and
says so on the download page rather than letting people find out.
