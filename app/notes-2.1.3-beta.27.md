# Superagent 2.1.3-beta.27

**One order across all your accounts.** Settings → Agents → Order across agents lists every account of Claude Code, Codex and Antigravity together. When one runs out, the chat moves to the next one in that list that has allowance, whichever agent it belongs to, and the new agent gets the conversation so far.

**Antigravity switches models before giving up.** Antigravity's quotas are per model, so when one runs out the chat now moves to the next Antigravity model that still has allowance (at the same effort where it can) and carries on. Only when every model is out does it switch account or agent.
