# Superagent 2.0.0

Everything from the 2.0 betas, in one release.

- **The dot.** A small floating widget that is always one keystroke away. Ask it anything from any app, and it becomes a normal chat; talk to it; ask it about what is on your screen; tell it to switch projects, find a chat, start one, stop one. Off by default — Settings → The dot.
- **Computer use.** An agent can see the screen and work the mouse and keyboard in any app, when you turn it on. It asks per app, shows where it is about to act, stops with ⌥Esc, keeps a record, and stays out of password managers, Keychain and the lock screen. Reviewed twice, independently.
- **The simulator, native.** The iOS Simulator's own screen is embedded in the pane, not streamed. Touch, swipe, scroll, pinch, rotate, fold an iPhone Duo, type, keyboard shortcuts, a Device menu. Each conversation has its own device, and two can never land on the same one.
- **Pictures in a chat.** Images in bubbles like a messaging app, an enlarged view you step through with ← and →, a right-click to download, pictures the agent made shown inline.
- **Pin a message.** Pin any message; a strip over the conversation takes you back to it.
- **Menu bar.** A menu bar menu that lists your chats and what each is doing, and ⌘⇧A / ⌘⇧D to attach a screenshot you just took.
- **Setup that says what is missing** and asks before it runs anything; a tour of how it works.
- **A sidebar of conversations, not git branches.** Idle branches fold into one line; the project header names the conversation you are in.
- **Phone.** The page as the Mac shows it, with the pane's proportions; no more endless spinner.
- **Reliability.** Long conversations save incrementally, off the main thread, without hammering the disk; a save that cannot finish never traps you; Restart to update always restarts; the window no longer burns a core while agents stream; agents' scratch files stay in the project instead of `/tmp`; dictation asks for the microphone properly; Codex installed with npm starts reliably.
- **A record of the Mac.** After hard freezes, Superagent keeps a diary of memory, pressure and stalls in `memory.log` so a bad day can be explained.
