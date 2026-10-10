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

### 2.0 betas come off the `2.0.0` branch

2.0 is being built on the branch `2.0.0`, so its betas stay off `main` until it
is ready. A push to that branch does not start a release (the workflow only
watches `main`). To cut one:

1. bump `version` in `app/package.json` (`2.0.0-beta.N`) and write the notes,
   on the `2.0.0` branch
2. commit and push the branch
3. `gh workflow run release.yml --ref 2.0.0`

The release script checks against `origin/<the branch it runs on>` and tags the
commit it built (`--target`), so the tag is right whichever branch that was.
Merge `origin/main` into `2.0.0` before a beta when main has moved, or the beta
ships without main's fixes; the only conflict is usually the version line, and
2.0's wins.

The branch has its own working copy at `.worktrees/2.0.0` (with
`app/node_modules` linked to the main checkout's).

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

## Computer use

`src/main/computer-use.ts` (permissions, screenshots, consent, ⌥Esc),
`src/main/computer-tools.ts` (the agent's `computer_*` tools) and
`native/cuse.c` (the helper that posts mouse and keyboard events, built by
`native/build.sh` and shipped beside `simfb`). Off unless the user turns it on.

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
- `prompts.ts` learns whether it is on through `setComputerUseProbe`, not an
  import, so building a prompt does not drag in Electron.

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
