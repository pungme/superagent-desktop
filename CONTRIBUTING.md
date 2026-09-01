# Contributing to Superagent

Thanks for your interest! Superagent is an Electron + React + TypeScript desktop
app that wraps AI coding agents (Claude Code and Codex today). It ships **no AI
of its own** — all intelligence comes from the user's own agent subscription — so
contributions should keep that principle: Superagent is plumbing (chat UI,
browser, scheduler), not a model.

## Getting started

```bash
cd app
npm install
npm run dev
```

Requires Node 18+ and at least one agent CLI on your PATH: `claude` (sign in once
with `claude`) or `codex` (sign in once with `codex login`). The app detects both
and lets you pick per chat.

## Before you open a PR

```bash
npm run typecheck   # tsc, main + renderer
npm run lint        # eslint (0 errors expected)
npm test            # unit tests (vitest)
npm run test:e2e    # end-to-end smoke tests (Playwright + Electron)
```

Please add tests for new logic and keep the suites green.

## Project layout

- `app/src/main` — Electron main process (windows, browser panes, the MCP browser
  server, hooks, routines, SQLite store)
- `app/src/main/agent.ts` + `agent-backend.ts` — the provider-agnostic session
  shell and the `AgentBackend` seam
- `app/src/main/claude`, `app/src/main/codex` — one self-contained backend each.
  They do not import one another; a change to one cannot regress the other.
- `app/src/preload` — the `window.cove` context-bridge API (internal namespace)
- `app/src/renderer` — the React UI (sidebar, chat, browser pane, file tree, panels)

See [PLAN.md](PLAN.md) for the architecture and roadmap.

## Conventions

- TypeScript throughout; match the surrounding style (Prettier-formatted, plain CSS).
- Keep the renderer sandbox-safe: no Node access outside the preload bridge.
- Never commit secrets, build output, or generated files.

## Cutting a release

Every step below exists because skipping it has broken a release. None of it is
optional, and none of it is obvious from the outside — an agent asked to "ship
it" without this page will get the credentials wrong and conclude they are
missing.

**1. Credentials must reach the build process itself.**

```sh
cd app
set -a; . ./.env; set +a          # APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
export GH_TOKEN="$(gh auth token)"   # not in .env; electron-builder needs it to publish
```

`app/.env` is gitignored and **is** populated on the release machine. If a build
logs `skipped macOS notarization  reason=notarize options were unable to be
generated`, the credentials did not reach the process — that is not the same as
them being absent. Check before concluding anything:

```sh
env | grep -cE '^(APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|GH_TOKEN)='   # expect 4
```

The usual cause is backgrounding the build in a way that does not inherit the
exported environment. Verify the count in the same shell that starts the build.

**2. Build and publish.**

```sh
npm run build:mac -- --publish always
```

An un-notarized DMG is Gatekeeper-blocked for everyone who downloads it, and the
build does not fail when notarization is skipped — it says so once and carries
on. Watch for `notarization successful`.

**3. Repair the split draft.** `electron-builder` uploads the DMG and the zip
concurrently; both find no release for the tag and both create one, so GitHub
ends up with **two drafts on the same tag** and the assets split across them.
Which assets land where varies. Merge them:

```sh
gh api repos/pungme/superagent-desktop/releases --jq \
  '.[] | select(.tag_name=="vX.Y.Z") | "\(.id) \([.assets[].name]|join(","))"'
```

Download the orphaned asset, delete the stray draft, then POST the asset to the
survivor's `upload_url` **by numeric release id** — `gh release upload vX.Y.Z`
resolves the tag ambiguously and will happily hit the wrong draft.

**4. Publish, and set it as latest.**

```sh
gh api -X PATCH repos/pungme/superagent-desktop/releases/<id> -f draft=false -f make_latest=true
```

`make_latest=true` is the step that is easiest to miss and most expensive to
miss. `electron-updater` asks GitHub for `/releases/latest`; if an older release
still holds that flag, every installed copy is told it is up to date and the new
version reaches nobody. This happened to 1.7.23 and 1.7.24 — both published,
both invisible, while GitHub still called 1.7.22 latest.

**5. Verify before walking away.**

```sh
xcrun stapler validate dist/mac-arm64/SuperAgent.app     # "The validate action worked!"
spctl -a -vvv dist/mac-arm64/SuperAgent.app              # "accepted, source=Notarized Developer ID"
gh api repos/pungme/superagent-desktop/releases/latest --jq '.tag_name, ([.assets[].name]|length)'
```

Five assets: `latest-mac.yml`, the zip, the zip blockmap, the DMG, the DMG
blockmap. `latest-mac.yml` is what the updater reads and the blockmaps are what
it uses for delta updates, so a release missing one is a broken update path even
though the download link works.

## License

By contributing you agree your contributions are licensed under the project's
[MIT license](LICENSE).
