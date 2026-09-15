# Superagent 1.9.1-beta.9

- Self-paced `/loop` no longer fires the next round immediately. A terminal's `/loop` paces itself with a real CLI tool (`ScheduleWakeup`) that Superagent has to block — it works by relaunching the process later, which only makes sense for an interactive terminal. Superagent now gives the agent `loop_wait` instead: the same idea (pick a delay, clamped 60–3600s), answered by Superagent's own timer. If the agent doesn't call it, a 60s floor still applies — never instant.
- Pinned chats keep the order you pinned them in. They used to re-sort by latest activity, so a pinned chat getting a new message would jump around the list.
- A chat's browser can now hold multiple tabs — open, switch, and close them from a small tab strip, and the agent can do the same (`browser_tabs`, `browser_open_tab`, `browser_switch_tab`, `browser_close_tab`).
