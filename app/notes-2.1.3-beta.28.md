# Superagent 2.1.3-beta.28

**Diagnose Superagent.** In the command palette (⌘K). It opens a chat with your own agent and everything it needs to find what went wrong: where Superagent's logs, macOS crash reports and the iPhone app's freeze reports are, and the source of this exact version. Say what happened and send; it explains the cause and asks before it changes or posts anything.

**Prompt links.** A `superagent://prompt?text=…` link opens Superagent with the prompt ready in a new chat (in the project it names, if you have it). It never sends anything on its own. Copy one from the command palette: Copy prompt link.

**Better hand-offs between agents.** When a chat moves to another agent, the new one now gets your original request, the latest messages with more of each, and what was done in between ("ran `npm test`, edited header.css"), instead of only the last two dozen messages cut short.
