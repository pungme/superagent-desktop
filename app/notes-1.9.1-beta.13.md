# Superagent 1.9.1-beta.13

- Every project now shows what it actually is in the sidebar — a website's favicon, a native app's own icon, or a glyph for a screenplay, design or music folder — instead of a generic folder icon. Right-click to set your own.
- A picture a tool call produces (a screenshot, a file the agent read) now shows up inline in the chat, right under the step that made it — not just a card you have to tap open.
- Stop now actually stops a long-running build or dev server it started, not just the CLI process sitting above it.
- "Open in Simulator" now raises the right device's window, instead of doing nothing when Apple's Simulator was already showing a different one.
- Tap a pending item in the Tasks panel to send it straight back to the agent as the next thing to work on.
- Answering a Choices prompt, clicking Compact, or a self-paced `/loop` round firing no longer wipes out a message (or its attachments) you were mid-typing.
- Chat bubbles sent close together now sit noticeably closer — the earlier fix only tightened them relative to each other, not in absolute terms.
- The phone's "/" command menu now matches desktop's, including your own skills like `/loop` — it was missing anything not built into the CLI itself.
- The phone can now show a project's icon too, over the same detection desktop uses.
