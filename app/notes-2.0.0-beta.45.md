# Superagent 2.0.0-beta.45

**Ask the dot about what is in front of you.**

- **A question typed at the dot now carries the screen as it was the moment you asked it.** Press ⌥ Space in front of anything — an error, a design, a page you are reading — and ask about "this": one picture of that display goes with your words, so the answer is about what you were actually looking at. Before, the agent had to start, decide to look and ask for the Mac first, by which time the window could be gone or the dot's own panel over it.
- **It is a look, and it grants nothing.** There is no recording and nothing is captured between questions — one picture per question, and only while computer use is on. The agent is told as much, and the first time it wants to press or type in an app it asks you in the ordinary way. A password manager, Keychain, a macOS password prompt or the lock screen anywhere on that display stops the picture entirely, and "Show it only the apps you allowed" still covers the rest. Turn it off on its own in **Settings → Computer use → "Let the dot see the screen when you ask"**.
- **The dot says when it did it**, under the question it went with, and the picture is in the conversation afterwards like any other.

**Also in this build**

- **A screenshot that stalls now fails instead of leaving the dot on "Looking at the screen" forever.** Electron's screen capture falls back after 5 seconds and the whole `computer_screenshot` call gives up after 15, with an error the agent can act on.
- **Closing the last window no longer quits into a waiting update.** It could do that while chats were generating and background tasks were running, killing them with no warning — the very thing the "restart anyway" prompt exists to ask about. The update banner gains **Restart when finished**, which waits for the last chat and task to settle and then restarts by itself.
- **A choices block cut off at the end still renders its buttons** rather than showing you raw JSON.
