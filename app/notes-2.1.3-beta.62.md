# Superagent 2.1.3-beta.62

**The Conductor view, as planned.** Open a Conductor from the sidebar (Conductor, under Routines) and Main shows on the left with its sessions on the right: cards wired to Main with curved lines (green while working, amber dashed when one needs you), filters, Connect session, and an inspector that shows a session's conversation and lets you write to it without leaving Main. The toolbar's Conductor button hides or shows the sessions; from any session it takes you back to Main. When Main starts or messages a session, its chat shows a ✦ New / ↳ Sent receipt.

**Main remembers.** Each project's Main has a saved memory: decisions, facts, preferences, data structures and schemas, plans. It survives compaction and restarts. Superagent also keeps its own record of every session (task, branch, files, where it stands), and every message to Main carries the current sessions, git state, open to-dos and the saved entries that match what you wrote, so Main recalls from saved facts rather than from what the model happens to remember.

**Tested.** e2e for the view, the sidebar section, the memory tools, the per-message state and the automatic recall; unit tests for the memory store.
