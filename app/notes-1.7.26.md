## Superagent 1.7.26 — the chat box comes back

**A browser tab had nowhere to type.** Opening a new tab made the tab and stopped there — it never started a conversation — and the chat column only draws conversations, so the page filled the window with no composer under it. Tabs that happened to already have a conversation were fine, which is what made it look random. Any project without one now gets one, so the tabs already in this state are fixed too, not just new ones.

**The app stopped disappearing from the Dock for a minute at a time.** While an agent drives the browser, the app refuses activation so a finished page load cannot yank the window in front of you — and an app refusing activation also has no Dock icon and cannot be clicked. Every new action restarted the clock, so a busy agent held it open indefinitely; the longest measured stretch was 52 seconds. It is capped at 8 seconds now, after which the app comes back and the rest of the run leans on handing focus back instead.

**Superagent no longer pulls itself in front of you when an agent uses the simulator.** After driving Simulator it brought itself back, on the reasoning that you had clicked a button so you should still be here. When an agent does it you are in another app entirely, so it was the app jumping the queue by a route the focus rules did not cover.

**Codex could not look anything up while planning.** In Plan mode it refused every browser call outright, with a message about approval policy that explained nothing. Plan mode stays read-only — that is what makes it a plan — but it can read a page now.
