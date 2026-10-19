# Superagent 2.0.0-beta.62

**Codex installed with npm works.** If you installed Codex with `npm install -g @openai/codex`, Settings showed it as connected, but chats failed with "Make sure Codex is installed and you're signed in" and the account stayed on "Checking…". Superagent could find Codex but started it without Node, which an npm install needs. It now starts Codex, and Antigravity, with what they need to run.
