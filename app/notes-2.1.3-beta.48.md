# Superagent 2.1.3-beta.48

**Conductor, finished and polished.**

- **Worker report-backs.** When a session finishes a turn, its one-line summary is written for you (the first sentence of its reply). A session waiting on an approval shows **Needs you**, with a dot on the Sessions tab.
- **Peek.** Click the arrow on a session in the Sessions tab to read its latest messages under its row, without leaving Main. Clicking the row still opens its chat.
- **Numbers in the sidebar.** A connected session is listed as `#101 Fix the header`. A closed session is archived out of the sidebar (reopen it from the Sessions tab).
- **Close options.** With unmerged commits Main now offers merge and close, close and keep the branch, or discard and close (only when you said so).
- **All three agents.** Main's briefing and the Conductor tools work with Claude, Codex and Antigravity.
- **Tested end to end.** A stand-in agent: Main starts a session, the worker gets its brief, leaves a summary, a follow-up goes to the same worker, a second task is #102.

Still experimental: right-click a project → Start Conductor…
