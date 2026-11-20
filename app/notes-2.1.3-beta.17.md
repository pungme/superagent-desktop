# Superagent 2.1.3-beta.17

**Agents can use your Superagent calendar.** They had no calendar tool, so they wrote an `.ics` file and asked you to open it. They can now read the calendar and add events, many at once, move them and delete them (deleting asks you first). Ask "put these deadlines in my calendar" and the events appear on Today and in the Calendar app. Start a new chat after updating: a chat that is already open keeps the tools it started with.

**Auto mode.** A switch beside Mode, off by default. When the agent finishes, it is asked whether anything is left and carries on until it says it is done. It stops at a question for you, a permission or limit prompt, when you press Stop or type, and after six rounds from one message of yours.

**What each session is doing.** Pinned and Activity rows show a line under the title: the step in progress while it works, the first words of the last reply once it is done.

**Out of allowance on every account: the next agent takes over.** When every Claude account is out, a chat moves on to Codex or Antigravity (whichever is signed in and has allowance), which gets the conversation so far, and your message is sent again. With Ask instead of Automatic you get "Continue on Codex" on the card.

**Sign-in popups work in the browser.** A "Continue with Google" button that opens a popup used to lose its page, so the login never arrived. Popups now open as a small window that hands the login back.

**Simulators.** Settings, Agents, Simulators lists the simulators agents leave behind (16 of them were 95 GB) so you can clear them, and unused new ones are cleared on their own after a week. A simulator whose SpringBoard crashes in a loop is restarted, and its "quit unexpectedly" pop-ups are switched off while it runs.

Also: Settings shows which account Codex and Antigravity are signed in as; the Today box finds the right chat and keeps the to-do list short; the screenshot suggestion no longer runs off the edge of a narrow chat.
