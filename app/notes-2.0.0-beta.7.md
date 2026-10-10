# Superagent 2.0.0-beta.7

**Bring Superagent forward from anywhere.** A new shortcut, ⌃⌥ S by default: it brings the window to the front, and pressed again puts it away and returns you to where you were. Change it or turn it off in Settings → General → Shortcut.

**Ask for a project.** "Open wepush", typed or spoken to the dot or in any chat, switches Superagent to that project and brings it forward. Part of a name is enough when only one project fits; when two do, it asks which.

**Computer use, safer.**

- **It asks per app.** The first time a conversation would click or type in an app, it asks, and says what is at stake: a terminal runs what is typed, Finder can delete files, a browser acts as you on every site.
- **Your own keep-out list.** Settings → General → Computer use → Apps it stays out of: add any app you want left alone.
- **It looks at what a click would land on**, not only the app in front, so a password manager's window behind another app is refused too.
- **It does not work its own window.** An agent cannot click Superagent's own buttons, which include the Allow on its own requests.
- **One conversation at a time.** A second agent is told the Mac is in use rather than fighting over the pointer.
- **Your hand wins.** Move the mouse, or bring another app to the front, and its next action is held back until it has looked at the screen again.
- What is written on the screen is never treated as an instruction.

**Fixed**

- With computer use turned on, the Computer chat (the dot's default) had no tools at all: two tools shared a name, which stopped its tool server from starting.
