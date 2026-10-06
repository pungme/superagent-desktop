# Superagent 1.9.3-beta.11

- **A chat's branch sits under its name.** In the sidebar the name has the first line and the branch the second, so neither is cut to a few letters to make room for the other. Renaming a chat still renames the branch Superagent gave it.
- **Token counts you can read.** A chat's total, each reply's badge and the counter while a turn runs now show new tokens: what the agent wrote, plus what was added to the conversation. They used to add in the whole conversation again for every tool call, which showed 19M for a chat that had written 87k. The full amount processed is in the tooltip. Replies from before this update only have the old total.
- **A trail for a crash we are chasing.** Superagent quit after two days open because it ran out of memory, and nothing said what had filled it. It now keeps a small memory log, and saves one snapshot if memory runs away, so the next time names the cause. Both are under Settings → Storage → Logs.
