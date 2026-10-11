# Superagent 2.0.0-beta.24

**Computer use, after a second independent review.**

- **A menu item named Quit, Delete or Empty Trash is asked about however the path is written.** A path ending in ">" slipped past the question.
- **Superagent runs once, and only as itself.** The released app no longer starts a second copy, or with the switches tests and debugging use. A copy started that way would have had the app's permissions and none of its limits.
- **Ask before each step shows all of what would be typed,** every line, and what would be put in a field or on the clipboard. It also asks before opening an app or a Settings pane.
- **An app that cannot be identified is not opened.**
- **"Show it only the apps you allowed" holds for an app's controls too,** not only for the picture.
- **It does not act on Superagent's own controls** while the dot holds the keyboard.
- **An agent's shell cannot read your clipboard with `pbpaste`,** and one line in `~/.curlrc` no longer switches the guard off.
- **One notice to the phone** for a run of questions answered at the Mac, not one for each.

Still open, and on the list: an agent's own shell remains the weak side of computer use. The guards on it are a list of known ways, not a wall.
