# Superagent 2.0.0-beta.18

**Computer use is not stopped by a password manager on another screen.**

- A screenshot is refused when a password manager (or an app on your keep-out list) has a window on the display being pictured. One left open on a second display no longer stops it looking at the first.
- Reading a window's controls by name takes no picture, so it only depends on the app in front.
- Controls that are not on the pictured display are listed too, and can be pressed or filled by their number.

**Tried with a real agent, start to finish.** Asked from the dot to press a button and fill a field, it asked to use the Mac, asked again for the app, read the controls, pressed once and filled the field by name, and left the password field alone. Before this change the same request was refused, correctly, because the Passwords app was open.
