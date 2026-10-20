# Superagent 2.0.0-beta.65

**Off means no dot.**

- **A dot that is on screen while the setting is off is taken down, whatever put it there.** The dot came back for someone who had turned it off. Rather than trust every path that could show it, the app now checks every moment: a dot window with the setting off is closed, and that is logged so the path can be found. Turning it off also lets go of the window first, so a failure to close it can never leave one behind.
