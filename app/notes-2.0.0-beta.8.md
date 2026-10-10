# Superagent 2.0.0-beta.8

**Pictures in a chat, like a messaging app.**

- **Download any picture.** Open one large and press Download: it goes to your Downloads folder and says where, with Show in Finder. A picture the agent showed you is saved as the original file, under its own name; nothing is ever written over.
- **Images.** A chat that has pictures gets an Images button under the message box: every picture in the conversation, newest first, yours and the agent's. Click one to see it large, or download it straight from the grid.

**Computer use: so that it cannot run away.** An independent review went looking for ways round the safeguards, and these are closed:

- **Its shell is not a second way in.** The helper that moves the mouse now refuses unless Superagent itself runs it, and an agent's shell commands that would drive the keyboard, mouse or screen another way (AppleScript, screen capture, and the like) are blocked.
- **⌥Esc works for as long as it is allowed**, not only for a few seconds after each action, and it now cuts off typing or a drag that is already under way. Settings says so if another app has taken ⌥Esc.
- **A yes does not last for ever.** However busy the agent stays, it has to ask again after 30 minutes or 300 actions.
- **Shortcuts that quit, log out or delete are asked about every time.**
- **It never touches Superagent's own controls**: not the window, not the dot or its Allow buttons, not its shortcuts, and not while Superagent has the keyboard.
- **macOS password and permission prompts are the user's to answer.** It does not click or type in them, or photograph them.
- **Nothing it should not see is in a screenshot.** If a password manager, or an app on your keep-out list, has a window anywhere on screen, it does not look.
- **Not knowing is a no.** If macOS will not say which app is in front, nothing is typed.
- **Typing is checked a line at a time.** If pressing Return brings another app to the front, the rest is not typed there.
- **Turning it on, and your keep-out list, can only be changed by you in Settings**, not by a write to the app's files.
- Routines, which run with nobody at the Mac, do not get computer use at all.
