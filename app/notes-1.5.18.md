## SuperAgent 1.5.18

### Fixes
- **Fix an unclickable middle column** — a memory optimisation in 1.5.17 could free a background chat's preview view while that chat was still open, leaving the middle column (file tree + preview) dead until you reloaded. Reverted; the leak it addressed is still handled the safe way (panes are freed when a chat or project is closed).
- **Killed background jobs clear themselves** — a job that ended with a `[killed]` marker used to stay pinned to the "Running in background" strip forever; it now drops off like any finished job.
