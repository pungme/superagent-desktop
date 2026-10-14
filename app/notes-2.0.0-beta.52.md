# Superagent 2.0.0-beta.52

**The simulator's screen is embedded in the pane, not streamed, and tapping works on Xcode 27.**

- **The real screen, in the pane.** The simulator pane used to show a stream: the screen photographed, compressed and sent across many times a second. It now shows the device's own screen directly, drawn by macOS inside Superagent's window, as smooth as the simulator itself and with nothing encoded or copied. If it cannot load on a Mac, the pane falls back to the stream as before.
- **Input that Xcode 27 accepts.** Xcode 27 silently ignores simulator input sent the old way: a tap reported success and nothing happened. Taps, keys, text and the Home, Lock and App Switcher buttons now go through the input service Xcode 27 uses itself. On older Xcode the old way is still used.
- **A real finger.** Pressing, holding and dragging in the pane move the finger on the device as you do it, instead of being replayed as a swipe afterwards.
- **Typing anything.** Text beyond plain English characters is pasted rather than typed.

Checked on an iPhone 18 Pro and an iPad Pro on Xcode 27.1. Not yet working: the rotate button in the pane; on an iPhone Duo the screen embeds but input is not confirmed, and taps only reach its outer screen.
