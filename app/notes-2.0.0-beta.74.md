# Superagent 2.0.0-beta.74

**The dot stays off.** Turning the dot off worked — until the next update or the next time a window opened, when it came back. The cause: the window keeps a copy of its own preferences in the same place the app keeps its settings, and an old copy of "dot on" was being written back over your choice every time a window loaded. The window can no longer touch the app's own settings, and old copies are cleared. The same flaw could have switched computer use, Mail or keep-awake back on; it is closed for all of them.

After this update, turn the dot off once more in Settings — that is the last time you need to.

**The simulator embeds the instant its screen exists** (from beta.73): the pill says "Starting the device…" while a device boots, and the first picture triggers the embed immediately.
