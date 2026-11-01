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
  sits for two minutes expires; three turned-down requests in ten minutes lock
  requests out for ten; a phone waits five seconds between asks.
- **While it runs:** the red always-on-top banner (no script, only a Stop link;
  no banner or no ⌥Esc, no session), ⌥Esc (shared with computer use through
  `addStopListener`/`holdStopKeyFor`), and it ends when the phone goes (closed
  connection or 45 s of silence), after 10 idle minutes (only input that was
  done counts), after 2 hours, on sleep or lock, when the setting goes off, when
  the display goes, when the banner is lost, or when capture stops working.
  After any end the next session starts from step 1.
- **Never:** `guard()` in control.ts checks each action against the Mac as it is
  then (app in front, app under the pointer, Superagent's own windows and
  keyboard focus, the keep-out list and `offLimitsApp`), and refuses keys that
  open Force Quit, log out, stop it, or are Superagent's own shortcuts
  (`remoteKey`). The stream is covered (`coverOthers`) wherever Superagent has a
  window, and paused, with no picture sent, while a password manager, Keychain,
  the lock screen or an app on the keep-out list is in front or anywhere on the
  shared display; a picture taken just before one appeared is thrown away.
- `computer.enabled` style: the switch is read once and held in memory
  (`remote.enabled`, sealed like the computer settings), changed only by
  `remote:set-enabled` IPC from a window of the app.
- Tests: `control.test.ts` (state machine and every safeguard, with fakes and a
  fake clock), `input.test.ts`, `stream.test.ts`, `shared/remote-control.test.ts`,
  `e2e/phone-remote-control.spec.ts` (fake phone over a real relay). A test run
  (`COVE_USER_DATA`) swaps the helper for a recorder, the screen for a drawing
  and the dialogs for ones the test answers (`inertDeps`): never real events.
  `cuse --dry` covers the helper's new fast actions (`jump tap down up dragto
  wheel`). `scripts/remote-stream-bench.mjs` measures the stream on app
  screenshots.

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
