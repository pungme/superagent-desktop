# Working in this repo

The Mac app. `app/` is the Electron project (main / preload / renderer); the
iOS companion and the relay are separate repos beside this one, so a checkout
of only this repo does not have them.

## Releasing — the version is the trigger, not the push

Pushing to `main` releases nothing on its own. A release starts when
`app/package.json`'s **version** changes:

1. bump `version` in `app/package.json`
2. write `app/notes-<version>.md` — the release script refuses without it
3. commit both and push to `main`

`.github/workflows/release.yml` then builds, signs, notarizes, staples and
publishes on a macOS runner. Proven working since 1.9.1-beta.18; all five
secrets are set (`MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

**The channel is the version, not a branch.** `1.9.1-beta.19` publishes as a
GitHub prerelease — the beta channel, which only clients opted into prereleases
see. A plain `1.9.2` publishes as latest, for everyone. Both come off `main`.

`cd app && npm run release` still does the same thing locally and is the
fallback if CI is broken. Never both for one version: they race for the same
tag (CI skips if the tag already exists). Locally you need
`source ~/.nvm/nvm.sh` for node, and `export PATH="/opt/homebrew/bin:$PATH"`
for `gh` — without the latter the script stops with "gh is not installed".

Notarization is an Apple round trip of several minutes. The script verifies
rather than trusting exit codes, and stops BEFORE publishing when something is
off, so a failure there has shipped nothing and a re-run is safe.

### Betas and stable both come off `main`

2.0.0 shipped as stable on 2026-10-22 and the `2.0.0` branch was merged and
deleted. A beta is a prerelease version (`2.0.1-beta.1`) bumped on `main`; a
stable is a plain version. If a long-lived branch is ever needed again, cut
from it with `gh workflow run release.yml --ref <branch>` (pushes to other
branches do not start a release); the script tags the commit it built.

## The dot

`src/main/dot.ts` is a second window: a frameless, transparent, always-on-top
panel with a tile in its corner, loaded from the same page with `#dot`
(`src/renderer/src/dot/`). Two things follow for anything that counts windows:

- It is not the app's window. Use `isDotWindow()` rather than assuming
  `BrowserWindow.getAllWindows()` is one window, or that an empty list means the
  app is closed.
- It is not created in a test run unless `COVE_E2E_DOT=1`, because a second
  window would be "the first window" to other specs. `e2e/dot.spec.ts` sets it;
  `e2e/dot-live.spec.ts` (`CLAUDE_LIVE=1`) asks a real agent.

## Split view (2.1)

Up to eight conversations in the window at once (`lib/split.ts` for the model
and maths, `state.ts` for the store slice, `SplitLayer.tsx`, `SplitsSection.tsx`,
`lib/split-drag.ts`).

- A chat's agent lives inside its mounted `<EasyChat>`; remounting it stops the
  agent. So `WorkspaceView` keeps ONE stable keyed list of `ChatDesk`s (one per
  mounted conversation) and split view only positions them. Never render a
  chat's desk from two places, and never move it between parents.
- The focused window's chat IS the active chat (`activeChatId`). One
  subscription at the bottom of `state.ts` keeps them in agreement: showing a
  chat that is in the split focuses its window, any other chat leaves the split
  (it waits under Splits in the sidebar). Do not add split checks to callers.
- `visible` means on screen; `focused` means keys, paste, dictation and menu
  commands go here. With a split several desks are visible and one is focused;
  a global listener that should fire once must gate on `focused`.
- Native views (browser, simulator) sit above the HTML and follow it by
  measuring; split view dispatches `cove:layout-moved` every frame while windows
  glide so they keep up. Anything drawn over them needs the overlay lock.
- A window narrower than `MINI_BELOW` shows its browser or simulator as a mini
  inside that window (`MiniPane`); the page is the desktop layout zoomed to fit.

## Browser first (2.1.3)

The page fills the desk and the chat floats over it, in the bottom-right corner
(`src/main/float-chat.ts`, `src/renderer/src/float/FloatChat.tsx`,
`src/shared/float-chat.ts`). Turned on with the Side by side / Browser first
switch in the desk toolbar or ⌘⇧B; ⌘J opens the box, ⌘⇧J the whole chat.

- The page is a native view, above all of the window's HTML, so the floating
  chat is a view of its own (`#float`, transparent), kept above every page view
  by `overlay-stack.ts`: whoever attaches a page view calls `raiseOverlays`.
- A view takes every click in its rectangle, transparent or not, so the float
  view is only as big as what it shows: FloatChat asks for its size
  (`float:size`), growing before an opening animation and shrinking after a
  closing one. Main anchors it in the page's bottom-right (`floatBounds`).
- The agent stays in the chat's `<EasyChat>`, which stays mounted (its column is
  0 wide). It sends what to show (`float:state`: plain-text messages, working,
  one line of status, whether it waits on the user); typed text comes back as
  `float:action` → `cove:float-send` → `submitRef`. A permission or question the
  float cannot answer shows "asking you something" with a way to side by side.
- ChatDesk sends where (`float:place`, the page below its address bar) and takes
  it down while anything of the app is over the desk (`overlayCount`), in a
  split, or when the surface is not a page.
- e2e: `browser-first.spec.ts` (SHOT=1 saves the layers;
  `scripts/_compose-layers.py` stacks them into one picture: a page screenshot
  alone shows none of the native views).

## Computer use

`src/main/computer-use.ts` (permissions, screenshots, consent, ⌥Esc),
`src/main/computer-tools.ts` (the agent's `computer_*` tools) and
`native/cuse.c` (the helper that posts mouse and keyboard events, built by
`native/build.sh` and shipped beside `simfb`). Off unless the user turns it on.

- CI runs `npm test` BEFORE the native helper is built, so a unit test that
  needs `native/cuse` must skip itself when it is absent (see `helperBuilt` in
  `computer-use.test.ts`). 2.0.0-beta.13's first release run failed on exactly
  this. To check locally: move `native/cuse` aside and run `npm test`.
- Never post real events from a test. `cuse --dry` parses and echoes without
  posting, and is what `cuse-helper.test.ts` runs.
- `systemPreferences.getMediaAccessStatus('screen')` can say granted when a
  capture still fails (until a restart). `computer:check` really tries; trust
  that, not the status.
- It refuses to act or look while a password manager, Keychain or the lock
  screen is in front (`offLimitsApp` in `shared/computer-use.ts`, asked through
  `lsappinfo`). A locked Mac reports `com.apple.loginwindow` in front, so a
  manual try from a locked machine is refused; that is the guard, not a bug.
- **A phone's yes to "use your Mac"** (`approval.answer` with `faceId`) is taken only
  when the phone ran Face ID or its passcode for that request (`phoneVerified` in
  `resolveGate`); without it the Mac refuses (`gateIsMacOnly`). It cannot trust the rest
  of the turn, and the Mac shows a notification that the phone allowed it. A flag the
  phone sets itself is not proof (a compromised paired phone could send it): the check
  stops an unlocked phone in someone else's hand, not a hostile one.
- Its tools share the `computer_` prefix with the Computer chat's own (which
  arrange Superagent's windows, in `mcp.ts`). A name used twice stops that
  chat's tool server: `COMPUTER_TOOL_NAMES` and a test keep them apart.
- Each action is checked against the app it would touch: for the mouse, the
  window under the point (`cuse at X Y`), for keys the app in front. That app
  must not be off limits (built-in list, the user's list, Superagent itself)
  and must have been approved for the conversation (`appsToAsk`).
- `cuse` posts nothing unless its parent process is Superagent with a window
  (`from_superagent` in `cuse.c`), so it cannot be run from an agent's shell.
  `cuse parent`, `at` and `windows` post nothing and can be run from anywhere.
  `computer-guard.ts` blocks the other shell routes (AppleScript, screencapture…)
  in the pre-tool hook. It is a list of known ways, not a proof.
- `computer.enabled` and the keep-out list are read from the store once and
  then held in memory, changed only through IPC: the store's file is writable
  by an agent's shell. Do not go back to reading them with `kvGet` each time.
- What is still open from the 2026-10-10 safety review is on the board
  ("Computer use: close what the safety review found…").
- `prompts.ts` learns whether it is on through `setComputerUseProbe`, not an
  import, so building a prompt does not drag in Electron.
- **From behind** (the `app` argument of `computer_read_ui`, `_press`, `_fill`,
  `_menu`, `_wait_for`; `computer_window_screenshot`; `computer_open_mac_app`
  with `background`): the helper's `--pid` acts through accessibility on that
  app's window, in front or not, with no pointer, no keys and nothing brought
  forward, so the user keeps the Mac. `behindApp` resolves the name to a bundle
  id and the running pid (`lsappinfo`); `mayWorkBehind` re-checks consent,
  out-of-bounds and the pid on every call; the tools ask per app (`mayWorkIn`),
  for risky controls and step by step as in front. The picture is that window
  alone (`winof`, then the window capture), never the screen. An app that
  activates itself on a press gets the user's app put back in front.
- Its e2e (`computer-behind.spec.ts`) runs in a quiet run through
  `COVE_E2E_BEHIND=1` (unpackaged only, stripped by `harden.ts`), against a test
  `.app` of its own kept behind every window. Do not compare the front app or
  the pointer with before: the person at the Mac uses it during the run; check
  that the test app never came forward instead.

## Remote control (the phone as this Mac's screen, trackpad and keyboard)

`src/main/remote-control/` (`control.ts` the rules, `input.ts` validation,
`stream.ts` frames, `banner.ts` the Mac's own windows, `index.ts` the wiring),
`src/shared/remote-control.ts` (keys, points, counters). Protocol in
`shared/companion-protocol.ts` (`remote.*`, the `remote` and `screen` frames,
`WireMachine.remoteControl`). Off unless switched on in Settings → Phone.

- **Consent model.** Every session is allowed at the Mac, by someone at the Mac:
  (1) the phone sends `remote.request` (its own Face ID comes first, on the
  phone, and is only an extra gate); (2) a native dialog at the Mac, "Allow
  <phone> to control this Mac?", Don't allow by default, one Allow per display
  when there are several (that click also chooses the display shared); (3) a
  second native dialog shows a six-digit code and the phone types it
  (`remote.code`); three wrong tries burn the request. `askAllow` is a
  dependency answered only by the dialog: no RPC reaches it, and a `remote.code`
  sent before the Mac allowed it neither advances nor counts. A request that
  sits for two minutes expires. Per paired device (`deviceId`, not shared): three
  turned-down requests in ten minutes lock that phone out for ten, it waits five
  seconds between asks, and it gets six dialogs an hour, a request cancelled by
  hanging up included (otherwise a hostile phone could pop a focus-stealing
  dialog every five seconds). All phones together get twelve dialogs an hour (accepted trade-off: a hostile
  paired phone gets its per-device share, and a second compromised pairing could
  use all twelve and deny the user's own phone for an hour; the counts reset when
  the app restarts). The session and the code belong to the connection
  and the device behind it. The Allow dialog and the Settings paragraph are built from the same
  words (`shared/remote-control-words.ts`) so they cannot drift, and promise no more than
  the guard delivers, and says what is plainly reachable: Mail and Messages
  (including one-time codes, and sending as you), Finder and every file, AirDrop
  and Share, sites already signed in in a browser (it acts in your accounts
  without seeing a password), System Settings changes that need no authentication
  (Login Items), restarting the Mac, up to 2 hours, ended after 10 idle minutes,
  and that a Touch ID or password prompt approved by habit gives the phone what it
  asked for. It also says the picture pauses only for apps the guard recognises,
  not for a browser's own password reveal, password-manager extension popups or
  autofill (the phone can simply press Sign in). It shows the phone's name only after "Paired phone:", cleaned of
  control, format (bidi, zero width) and separator characters.
- **While it runs:** the red always-on-top banner (no script, only a Stop link;
  no banner or no ⌥Esc, no session), ⌥Esc (shared with computer use through
  `addStopListener`/`holdStopKeyFor`), and it ends when the phone goes (closed
  connection or 45 s of silence), after 10 idle minutes (only input that was
  done counts), after 2 hours, on sleep or lock, when the setting goes off, when
  the display goes, when the banner is lost, or when capture stops working.
  After any end the next session starts from step 1.
- **What a phone can reach, honestly (the words the product uses, and no wall-like
  claim).** For the whole session it can see the shared screen and use the mouse
  and keyboard as the user, in any app that is not a password manager, a macOS
  system prompt or Superagent itself; it can quit apps. Superagent limits that
  with a list, not a wall: the front app, the app under the pointer, every window
  on the display and the keyboard focus are checked on every action (`guard`
  calls `scene()` itself, so it never depends on the stream having looked or on
  the phone asking for pictures); a failed look at what is under a point refuses
  (`appAt` throws, it never falls back to the front app); the stream pauses for a
  secret and covers Superagent's windows, notification banners and, unless
  allowed, shells; a paste is refused while the pasteboard is marked by a
  password manager (`clipboardConcealed`: `clipboard.has` on ConcealedType,
  TransientType and two vendor types; `availableFormats()` lists only MIME names on
  macOS and is no use), by ⌘V and variants and Control-V / Control-Shift-V (virtual machines, remote
  desktops), and, while it is marked, by right-clicks
  and any press in the menu bar (Edit → Paste); the Apple menu (a fixed 50x40
  region at each display's top left, not detected; the menu-bar band for a marked
  clipboard is `Math.max(MENU_BAR_BAND, the display's menu bar depth)`, with
  `MENU_BAR_BAND` 50: the depth is 0 with a hidden menu bar, about 37 on a notched
  MacBook and 43-44 on one set to More Space; the display is read again on every
  action) and the Dock's menu are not
  pressed, and the keys that reach them are refused too (`remoteKey`: Control with
  F1-F8 which focus the menu bar and the Dock, Control-Option which is VoiceOver's,
  ⌘F5 and ⌥F5, ⇧⌘/ the Help search that runs menu items). The system prompts are matched by bundle id
  (UserNotificationCenter, CoreServicesUIAgent, universalAccessAuthWarn,
  ScreenCaptureApprovals, SecurityAgent, AuthorizationHost, Passwords, Keychain)
  (also NetAuthAgent, Keychain Circle Notification, WiFiAgent, AuthKit UI, the TCC
  AuthorizationPromptService and CoreLocationAgent, each read from its Info.plist
  under /System/Library; SystemUIServer, the menu bar's host, is deliberately not on
  it), and by owner name, since the helper reports the outermost `.app` of a window;
  `layout()` reads a window exactly as `appAt` does (`ownerApp`), so a prompt from a
  process outside any `.app` (coreautha) is known by its name. Any window of
  someone else's on layer 1000 or higher (screen saver, shielding; not Superagent's
  banner, not the notification host, not the Dock) pauses input and the stream
  whatever it is (`REMOTE_HIGH_LAYER`; popup menus 101, help tags 200 and a drag in
  progress 500 stay below it so menus remain usable), and the helper's `at` now
  reports every layer from 100 up instead of dropping them.
  A terminal is the way round all of it (Spotlight, type "Terminal", Return, then
  `security dump-keychain`, a LaunchAgent, `kill`, `osascript`), so shell-class
  apps (`shellApp` in `shared/computer-use.ts`, the same lists computer use's
  `appCaution` warns of; Xcode is not on it) are refused unless "Allow terminals
  and scripting apps" is on. That is the second switch: off at every start (never
  stored or read back, a test guards it), on only through the confirmed
  `remote:set-shells` IPC, and off whenever remote control goes off. **It does
  not close the route:** command execution stays reachable through a browser's
  developer tools in a signed-in session, files that run later (shell startup
  files, LaunchAgents, login items), Finder "Open", Services and Quick Actions,
  third-party terminals, database consoles and REPLs, SSH and screen-sharing
  clients, Docker, Xcode. The Allow dialog and Settings say so in those words.
  `checkApp` is the one place that says which apps are in bounds; an optional
  "only these apps" mode (an allowlist the user fills) would be one more rule
  there and in `scene`/the cover predicate. It is a product decision and is not
  built.
- **The switches.** `remote:set-enabled` and `remote:set-shells` accept only the
  top frame of the main window (`trustedSender`, never the dot, never a
  sub-frame) and ask in a native dialog at the Mac, Cancel the default
  (`mayFlip`); turning off asks nothing. Pairing and removing a phone
  (`companion:pair-decide`, `companion:revoke`) take the same sender check
  (`onlyTrusted`), as do `companion:pair-start` (the pairing payload and code) and
  `companion:set-relay`; all of them are registered in `guarded-ipc.ts`, where a
  test with a fake `ipcMain` checks every channel rejects an untrusted sender. The main switch persists across restarts
  (Settings says so); the shells switch does not. Every `remote.*` method needs
  `hello` (with the device token) to have completed on the connection, not only
  the key probe (`helloDone` in session.ts).
- **The banner** is on every display (`createBanner`), below the menu bar, and a
  session ends if any of them is lost. Fast user switching
  (`user-did-resign-active`) ends a session, as lock and sleep do; display sleep
  alone does not (the screen saver and the login window pause the stream).
  Ending after a helper run was cut short lets go of both buttons at the pointer.
  It does not release a modifier key left down by a kill between key-down and
  key-up (the helper has no such action and it was not added); the window is
  about 18 ms. **Dock icon trade-off:** `setVisibleOnAllWorkspaces(true,
  {visibleOnFullScreen: true})` makes Electron transform the process so the banner
  can float over full-screen apps and every Space, and that hides Superagent's Dock
  icon for as long as the banner exists (measured on Electron 39: icon hidden when
  the banner is created, still hidden after it is destroyed, back after
  `app.dock.show()`, which `hide()` calls, except in a quiet test run, where
  quiet.ts hides the Dock on purpose). When the dot exists, `hide()` re-applies the
  dot's own `setVisibleOnAllWorkspaces` instead (`refloatDot`): the dot's call had
  already made the app accessory-style before the session, so that is the state to
  go back to, and the dot keeps floating over full-screen apps. The banner being
  seen is the safety property; the icon is cosmetic. Do not pass
  `skipTransformProcessType`: it keeps the icon and very likely loses the banner
  over full-screen apps. The banner must be in the on-screen window list on the
  shared display (`bannerHidden`: a Superagent window on layer 1000 or higher
  overlapping it), checked on every action and every look after 500 ms of grace
  (`BANNER_GRACE_MS`), or the session ends; that catches full-screen Split View,
  notch-aware full-screen windows and a banner on another display only. The check
  ends only the session it looked at. Whether the banner really shows
  over a real full-screen app cannot be verified without a real Mac: check it by
  hand.
  Not verified on a real Mac (the e2e uses a flag for the banner): that
  `type: 'panel'` is not hidden when Superagent loses focus, that it stays above
  full-screen apps, that `ok()` goes false after the app is hidden with ⌘H (it
  should, which ends the session: safe), and that it clears the notch. Check them
  by hand before release.
- **A key cannot race a change of app.** After a click, or a key with Command,
  Control, Option or Fn, the next action waits for the app in front to be read
  twice the same (`settle` in control.ts, 150 ms apart after 250 ms; 1.2 s first
  after Return or a click while a launcher (Spotlight, Raycast, Alfred, Launchpad)
  has a window on screen, which is looked for in the layout because Spotlight
  may not be reported as the app in front; a click on the Dock; a double click;
  or ⌘O: the app they open arrives late). If it will not hold still, keys that switch apps
  and Return are refused (`settling`) until it does. Superagent's menu
  accelerators are not added to the refused shortcuts: that would take ⌘W, ⌘N,
  ⌘R, ⌘K, ⌘, away from every app, and with the settle a key never reaches
  Superagent anyway.
- **Never:** `guard()` in control.ts checks each action against the Mac as it is
  then (app in front, app under the pointer, Superagent's own windows and
  keyboard focus, shell apps, the keep-out list and `offLimitsApp`), and refuses
  keys that open Force Quit, log out, stop it, or are Superagent's own global
  shortcuts (`remoteKey`). The native dialogs (Allow, the code, quit anyway) are
  modal panels, not BrowserWindows: the helper's `at` reports every window of
  Superagent's except the dot as Superagent's (`own_skipped` in the helper's C
  source, tested through its `ownskip` action), so a click on a dialog's button
  is refused, here and in computer use. The rate limit is charged per process
  started (front 2, point 1, helper 1, per piece of text) with a separate cap on
  typed characters; the helper's own error text never goes to the phone or the
  log (`runHelper`). Remote runs of the helper are tracked apart, so ending a
  session does not cut short a computer-use agent's drag (⌥Esc still cuts both).
  `COVE_E2E_QUIET` is honoured only when not packaged (`quietRun`), as are the
  other test-only variables (`harden.ts` strips them in a packaged build). The stream is covered (`coverOthers`) wherever Superagent has a
  window, and paused, with no picture sent, while a password manager, Keychain,
  the lock screen or an app on the keep-out list is in front or anywhere on the
  shared display; a picture taken just before one appeared is thrown away.
- `computer.enabled` style: the switch is read once and held in memory
  (`remote.enabled`, sealed like the computer settings), changed only by
  `remote:set-enabled` IPC from a window of the app.
- Tests: `control.test.ts` (state machine and every safeguard, with fakes and a
  fake clock; a section per finding of the 2026-11-01 security review),
  `remote-helper.test.ts` (runs and kills, fake child process), `input.test.ts`, `stream.test.ts`, `shared/remote-control.test.ts`,
  `e2e/phone-remote-control.spec.ts` (fake phone over a real relay). A test run
  (`COVE_USER_DATA`) swaps the helper for a recorder, the screen for a drawing
  and the dialogs for ones the test answers (`inertDeps`): never real events.
  `cuse --dry` covers the helper's new fast actions (`jump tap down up dragto
  wheel`). `scripts/remote-stream-bench.mjs` measures the stream on app
  screenshots.

## Accounts and connectors

`src/main/accounts.ts` (accounts, the default per agent, the pick rule),
`src/main/connectors.ts` (claude.ai connectors), `src/main/agent-signin.ts`
(every sign-in, in a window of ours).

- An extra Claude account is a full `claude auth login` in its own
  CLAUDE_CONFIG_DIR (kind `config`); a `claude setup-token` token (kind
  `token`) is the fallback and is inference-only: no claude.ai connectors, no
  Claude in Chrome. Read from 2.1.314: with CLAUDE_CONFIG_DIR the login is in
  the Keychain item `Claude Code-credentials-<first 8 hex of sha256(dir)>`
  (account $USER; `.credentials.json` in the dir as fallback) and the global
  config is `<dir>/.claude.json`. The dir links back to ~/.claude except
  `CLAUDE_NOT_SHARED`; MCP servers from ~/.claude.json are copied in.
- `withAccountEnv` drops CLAUDE_CODE_OAUTH_TOKEN whenever CLAUDE_CONFIG_DIR is
  set: the token would win over the folder's login.
- Each `config` account has its own persistent cookie jar; connecting a
  connector opens claude.ai's start-auth page there (claude.ai holds the
  connection, Claude Code does no local OAuth for these).
- Tests never touch the real ~/.claude or Keychain: a test instance's Keychain
  is a no-op (`liveUsage`), unit tests set HOME, and the e2e
  (`accounts-signin.spec.ts`) runs a stand-in `claude` through
  `COVE_E2E_CLAUDE_BIN` with its own HOME.

## Claude Code updates

`src/main/cli-updater.ts` (+ `shared/cli-update.ts`) runs the CLI's own
`claude update` 90 s after launch and every 12 h, unless Settings → Agents →
"Keep it up to date" is off (`cove.cliAutoUpdate` = '0', default on). The
picker's model list is the CLI's, so a new model (Fable 5.2…) reaches the user
once the CLI is new enough; the CLI's background updater had sat two weeks
behind (2.1.314 → 2.1.325). Running chats keep the version they started with.
Skipped in a test run (`COVE_USER_DATA`, `COVE_E2E_CLAUDE_BIN`).

## Conductor (experimental, 2.1.3-beta.47)

A project can have one **Main** chat that starts, routes to and closes **worker sessions**
(`src/main/conductor-store.ts` rows, `conductor-tools.ts` tools and IPC, `shared/conductor.ts`
pure helpers, `components/ConductorPanel.tsx` the Sessions tab). Plan and mockup:
`.superagent/cto-mode/plan.md`, `mockup.html`.

- Rows: `workspaces.conductorChatId / conductorNextTicket / conductorRouting`,
  `chats.conductorParentId / ticketNumber / conductorClosedAt / conductorSummary`. A chat is a
  session of the project when its `conductorParentId` is the Main; its ticket (#101…, per project)
  stays through disconnect/connect and close/reopen.
- Started from the project's right-click menu (`workspace:menu` in index.ts sends `start-conductor`; the renderer's `StartConductorModal` asks Start clean / Connect the N existing chats, then opens the Conductor view). `startConductorDialog` in conductor-tools is the old native-dialog path, kept for its unit test.
- The Main chat's agent gets `conductor_*` MCP tools only for that chat
  (`registerConductorTools` checks `conductorOfMain(chatId)`), and a briefing: its job and the
  live session list, through `setConductorProbe` in prompts.ts for all three agents. **Do not
  import `companion/log` or `prompts` from conductor-tools directly**: the cycle broke start-up
  (`logBus` used before it existed). The probes (`setGeneratingProbe`, `watchConductor(logBus,
  hookBus)`) are handed in from index.ts.
- `watchConductor` writes a one-line summary when a worker's turn ends and marks "Needs you"
  while an approval of its is open; the panel and sidebar read them.
- Routing (Confirm / Auto) is a pill in Main's composer (`RoutingPill`); the mode is in the Main's briefing.
- e2e: `conductor.spec.ts` (tools over HTTP; a stand-in `claude` for spawn/send/summary).
- Sessions that need you also show as Approve / Deny cards inside the Main chat
  (`ConductorEscalations.tsx`), with Inspect opening that session beside Main.
- `conductor-live.spec.ts`: a real agent as Main (`CONDUCTOR_AGENTS=claude,codex,antigravity`, `CLAUDE_LIVE=1`): Auto starts a titled session, Confirm asks first, a follow-up routes to the existing session.
- Merging: `conductor_merge_session` (keeps it open) or `conductor_close_session how:'merge'`; the prompt tells Main to offer it, never to merge without a yes.
- Overlap: `sessionsOf` adds each session's changed files (`changedFiles`: diff against main plus uncommitted); `overlaps()` in shared/conductor.ts feeds an "Overlap:" line in the list, and the prompt tells Main to ask rather than start a parallel session on the same files.
- The Conductor view: when Main is the chat on screen, ChatDesk lays out Main on the left and `ConductorPanel` (session cards with SVG wires from Main's edge, filters, Connect, the inspector `SessionInspector.tsx`) on the right (`conductorView`; the toolbar's Conductor button hides it). The sidebar's Conductor section under Routines (`ConductorSection`, `conductor:overview`) opens it via `lib/open-conductor.ts`. Sessions and Main are not in the project's chat list. People see tracker keys (`trackerKey`), never the internal #101.
- Main's memory: `conductor_memory` table (`remember`/`recall`/`forget`/`memoryIndex` in conductor-store), tools `conductor_remember/recall/forget`, and Superagent's own record of each session (`recordSession`: task, branch, files, latest) on spawn and every finished turn. Every message to Main gets `conductorTurnPrefix` (state, git, to-dos, memory index, entries matching the message) through `setTurnPrefixProbe` in agent.ts: for the agent only, never the transcript.
- ⌘\ toggles the sidebar through the View menu item (menu accelerators work while a native view has focus; a renderer keydown does not).
- A card opens `SessionInspector` (its latest messages, a box that writes to it via `conductor:send`); "Live beside Main" puts the session's own chat in a split beside Main (`openBeside`), so its real mounted EasyChat is on screen without remounting anything. The routing pill (Confirm / Auto) is in Main's composer (`RoutingPill` in EasyChat); Main's routing calls show as receipts with Move ▾ (`MoveMenu`, portaled above the message list).

## Our own right-click menus

The sidebar's right-click menus (project, chat, branch, file) are drawn by the app, not macOS
(`src/main/ctx-menu.ts`, `components/ContextMenu.tsx`). Main still builds the same
`MenuItemConstructorOptions` template with its `click` handlers and calls `popupMenu(win, template)`;
the window gets a plain description (`ctxmenu:show`), draws it at the right-click point (taken from
the window's own `contextmenu` event, not the screen pointer), and the pick comes back as an id
(`ctxmenu:pick`) that runs the item's own `click`. Arrows, Return and Esc work; a click away closes it;
it holds native views (browser pane) back with the overlay lock. The browser pane's page menus
(`browser.ts`) stay native: a native view sits above all HTML, so a drawn menu could not show there.
e2e: `context-menu.spec.ts`.

## Performance notes

- Never run git (or any child process) synchronously on the main thread in a path a window polls:
  `session-git.ts` reads a Conductor session's branch / unmerged / files in the background (cache,
  4 at a time) and `sessionsOf` answers from the cache; tools that need fresh facts use
  `sessionsOfFresh` / `freshGit`. With 22 sessions the old sync version froze the app 1–5.5 s.
- Project icons (`project:icon`) are kept between launches (kv `iconDetected:<path>`, a week) and
  found one at a time.
- Opt-in perf specs: `PERF=1 npx playwright test e2e/perf` (22-session Conductor, idle cost), and
  `COVE_PERF_DATA=<folder with copies of cove.db and transcripts.sqlite>` for a real-sized store.
- Compacting the stores (`storage-compact.ts`): Settings → Advanced asks, the app restarts, and
  `runPendingCompact` VACUUMs with the system `/usr/bin/sqlite3` before anything opens the stores.

## Checks

`npm run typecheck`, `npm test` (vitest), `npm run lint`, and
`npx playwright test` for e2e — from `app/`.

The e2e suite runs quietly (no windows, headless Brave) and should be all
green. `COVE_E2E_PROJECT` seeds a project with no conversation, unlike adding
one in the app, so a spec that needs the composer creates a chat first (see
smoke.spec.ts). Opt-in live specs spend tokens: `CLAUDE_LIVE=1` for
loop-live, `CODEX_LIVE=1` for codex-live.

The companion e2e suite needs the relay repo beside this one. Without it the
suite skips itself, which is why CI stays green.
