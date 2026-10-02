# Apple Mail verification

## Normal checks (never touch real Mail)

From `app/`:

```sh
npm run build
npm test
npx playwright test
```

`mail.test.ts` checks consent, revocation, in-flight disconnects, argument bounds and data/source separation. `mail-tools.test.ts` uses an actual MCP client/server pair. `mail-script.test.ts` executes the actual JXA source against Mail-shaped objects, including Mail's synthetic account container and the single-predicate `whose` restriction. It also checks that privacy descriptions are top-level Info.plist entries. `e2e/mail.spec.ts` exercises onboarding and Settings with simulated Mail IPC.

## Real Mail, real app IPC, real HTTP MCP

This reads at most a small inbox sample, saves a uniquely named draft addressed to `superagent-test@example.invalid`, independently checks its body and recipient in Mail, verifies no copy exists in Sent or Outbox, and moves only that test draft to Trash. It never sends. It prints counts and booleans rather than message content.

```sh
MAIL_LIVE=1 node scripts/test-mail-live.mjs
```

Run against a packaged, signed app:

```sh
MAIL_LIVE=1 \
MAIL_TEST_EXECUTABLE='/path/to/SuperAgent.app/Contents/MacOS/SuperAgent' \
MAIL_TEST_REPORT=/tmp/superagent-mail-signed-report.json \
node scripts/test-mail-live.mjs
```

The script uses temporary Superagent data, verifies disconnect using the existing MCP client, then restarts the actual application to check that consent persists. It closes the test app and removes its temporary app data. Test drafts remain recoverable in Mail's Trash. A test requires at least one account and one inbox message; missing fixtures fail explicitly instead of silently skipping.

## Real providers

This spends a small number of tokens on the signed-in CLIs. Each provider uses Mail search for a unique nonexistent marker (no account listing or message bodies). A new session after disconnect must know Mail is disconnected without calling tools.

```sh
MAIL_LIVE=1 node scripts/test-mail-agents-live.mjs
```

Use `MAIL_TEST_EXECUTABLE` to test the signed app; `MAIL_TEST_PROVIDERS=claude,codex` to select providers; `MAIL_TEST_DISCONNECTED_ONLY=1` to repeat only the disconnected-state check. Quota/authentication failures are test failures, not claimed passes.

## Native permission prompt

A successful run under a development harness does not prove a fresh macOS Automation dialog: the parent app may already have permission. Verify the packaged plist using `PlistBuddy` and the signed Apple Events entitlement using `codesign`. For a fresh consent/denial test, launch a separately identified signed test copy through LaunchServices, and test the native prompt. Do not reset the installed Superagent's permissions to create this test condition.

## Bugs found by live testing on 2026-10-01

- Mail's synthetic account container made `mail_search` locators fail in `mail_read`; locators now resolve relative to the actual account mailboxes.
- A one-element `_and` is invalid JXA; query-only and unread-only search now use a direct predicate.
- `mac.extendInfo` was a YAML array, creating numbered plist keys; it is now a mapping, so macOS receives the privacy usage descriptions at the top level.
- Mail can retain deleted draft objects in its collection while synchronization completes. Test cleanup closes the test composition first and verifies there are no *active* matching drafts, rather than incorrectly counting deleted objects as failures.

## Latest verification result (2026-10-02)

- Local Apple Development-signed app: code signature, hardened-runtime Apple Events entitlement, and top-level usage-description verification passed. This was not a notarized release.
- Real Mail through that app's UI/IPC/HTTP MCP: all ten checks in `/tmp/superagent-mail-final3-signed-report.json` passed, including 5 accounts/52 mailboxes, search/read, bounds, independent draft verification, disconnect, reconnect and app restart. No real nested mailbox fixture was available; nested paths are covered by the source-execution regression tests.
- Test drafts: independently verified in Drafts; correct recipients and Unicode/quotes/newlines in the body; zero in Sent/Outbox. Test drafts were moved to Trash, and no active test drafts remained.
- Claude and Codex: rerun on October 2 with the final code passed all four connected/disconnected assertions (`/tmp/superagent-mail-final-agents.log`); each actually used `mail_search` through a fresh app-managed session; fresh disconnected sessions correctly reported disconnected without using tools.
- Antigravity: retry on October 2 remained blocked by individual quota (reset in approximately six days). Previously discovered and invoked `mail_search`, but hit its individual quota before completing its final reply. That complete-turn assertion remains unverified.
- Fresh native consent experiment: separate bundle identity launched through LaunchServices, without resetting the installed app's permissions. The unanswered native request timed out and left the connection disabled. The UI driver could not inspect/click the macOS dialog because its Accessibility/Screen Recording permissions were pending. Explicit native Allow/Don't Allow/revocation is not claimed verified. The isolated test app was then closed.
- Full suites: 563 unit tests passed / 13 skipped; 116 Playwright tests passed / 19 skipped. Typecheck/build passed. Focused new-code lint passed. An isolated export of the exact staged Mail changes passed typecheck and 51 focused tests; full lint in that export still has the existing 38 errors. Concurrent unrelated account-usage edits were excluded from the Mail changes.

## Final review fixes (2026-10-02)

- An older denied request cannot clear a newer successful connection. Connect allows 120 seconds for the native prompt; read and draft timeouts give operation-specific guidance.
- Locator checks distinguish a synthetic account root from a real folder with the same name. Regression fixtures cover both.
- The final real-Mail run exposed repeated evaluation of a filtered JXA specifier, causing unread search to exceed 30 seconds. Search now resolves each result by message ID before reading its fields; all filter variants passed after the fix. The source-execution fixture disallows field reads on filtered specifiers.
- Cleanup now waits for Mail to synchronize removal of the exact generated draft. A failed immediate cleanup assertion was independently checked: zero active test drafts remained.

Final signed rerun: all ten live assertions passed with the filter optimization and synchronized cleanup (`/tmp/superagent-mail-final3-signed-report.json`, log `/tmp/superagent-mail-final3-signed.log`). No active test drafts remained. Native Allow/Don’t Allow/revocation and a complete Antigravity turn remain the explicit external verification gaps above.
