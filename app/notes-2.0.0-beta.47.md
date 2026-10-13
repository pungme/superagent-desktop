# Superagent 2.0.0-beta.47

**Talking to the dot asks for the microphone properly; pictures fit their bubble.**

- **The microphone is asked for by the app, before the dot records.** Chromium asks macOS for the microphone the first time a page records, but a request from the dot, a panel that is never the active app, had nothing to hang the system's prompt on: nothing appeared and dictation failed with a word of Chromium's. Superagent now asks macOS itself first, in the dot and in the chat. If the microphone is off for Superagent, it says exactly that, with an Open System Settings button, rather than "could not access the microphone".
- **A picture wider than its bubble is scaled to fit.** In a narrow conversation a picture the agent showed stood out past the edge of its bubble; it now stops at the bubble, as its caption does.
- **What the agent made, shown in the message.** A mockup, a generated image, a screenshot of a result: the agent now puts it in its reply as a picture without being asked, rather than saying where the file is or that it is open beside the chat.
