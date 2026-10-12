# Superagent 2.0.0-beta.40

**Nothing renders behind the browser any more.**

- **The restart warning is no longer behind the page.** "Claude is still working in 2 chats. Restarting stops them." opened behind the browser pane (a PDF, say), its buttons out of reach. The browser is a native view that paints above every bit of the app's own HTML, and each dialog had to ask it to step aside; this one had not.
- **Now anything drawn over the browser gets it out of the way, by itself.** The app watches for any element stacked over a live page — a dialog, a warning, a menu, the next thing anyone adds — and the page steps aside behind a still of itself for exactly as long as that thing shows. Before, only a fixed list of tooltips and menus was covered, and every new dialog was a fresh report of "the popup is behind the browser".
- **The warning says what each chat is doing, and a row opens it.** "The agent is replying" three times over is now the step each one is at — "Editing · src/server.ts", the reply as far as it has got, what it is thinking about — and clicking a row takes you to that conversation to see for yourself.
- **"What do you see?" gets a look, not a question.** With computer use on, the agent took that to mean Superagent's own windows and offered to take a screenshot if you wanted. It now takes one and tells you what is there; the permission prompt is still yours to answer.
