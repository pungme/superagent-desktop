# Superagent 1.9.3

**Email the agent can send**

- Ask the agent to send an email and it does, from Apple Mail. You approve each one first: a card in the chat shows who it goes to, the subject, the attachments and the start of the message.
- Drafts and sent mail can carry a formatted body (a designed signature, styled text, pictures), attached files, cc and bcc.

**Setup without leaving Superagent**

- First-run setup is one list of agents with one button each. It installs the agent if it is missing and signs you in, in a Superagent window. No Terminal, no browser.
- Settings → Agents → Sign in opens the same window.

**Usage, everywhere you pick an account**

- Antigravity shows its limits like Claude and Codex do.
- The usage list at the foot of the sidebar draws each limit as a bar, amber from 75% and red from 90%, and says when each one resets. The Account menu and the agent menu show the same figures.
- Token counts show new tokens (what the agent wrote, plus what was added to the conversation) instead of counting the whole conversation again for every tool call.

**Simulators**

- Each conversation gets its own simulator, so two of them building at once no longer install over each other. An agent's own `xcodebuild` and `simctl` commands are kept to its own device too; looking at another conversation's simulator is still allowed.
- A simulator in landscape, such as an unfolded iPhone Duo, is drawn the right way up.

**The sidebar**

- Every chat under a project is the same height, with its branch and when it was last used on a second line.
- New group asks for a name, and groups sit at the top of Projects.
- Every pinned chat shows its project's icon.
- Deleting a project's conversation asks first.

**The message box**

- In a narrow chat the settings under the message box fold into one line, which opens as a list.
- A long message uses the whole width of the box.
- A chat that has its own copy of a repo shows a Worktrees pill: which repos, on which branch.
- Screenshots: click a suggested screenshot to see it large before attaching, and Attach & delete attaches it and moves the file to the Trash.
- ⌘K to a conversation leaves the cursor in its message box, for a conversation in Chats too.

**Around the app**

- Place your own picture in the app icon with a live preview, and pick any colour for the icon and the accent.
- Keep working with the lid closed: a switch in Settings → General → Power, off by default.
- An agent can end its own loop when the job is done.
- The restart warning lists what is still running, chat by chat.
- Copy on a reply says "Copied". Esc closes an enlarged picture.

**Fixes**

- Dictation works again.
- Tooltips, menus and ⌘K open over the browser, not behind it.
- After you stop the agent, the cursor stays in the message box.
- A wide picture in a reply no longer sits in an oversized frame.
- "Attach" and other buttons are readable in dark mode.
- A recoloured Dock icon is the right size.
