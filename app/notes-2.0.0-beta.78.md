# Superagent 2.0.0-beta.78

**Screenshot offers come back on their own.** When a screenshot you take is not offered above the composer, the reason is now in `memory.log` — most often macOS not letting Superagent read the Desktop (System Settings → Privacy & Security → Files and Folders) — and the watcher tries again every minute instead of giving up for the session.
