# Superagent 2.1.3-beta.37

**Simulators no longer pile up.** A simulator a conversation started stayed running long after it was needed, each one a whole iPhone with hundreds of processes. Now one that no pane shows and no agent is using is shut down after ten minutes, and quitting Superagent shuts down its conversations' simulators. Simulators you start yourself are never touched. Settings → "Clear out unused simulators" turns this off.

**Computer use from behind.** An agent can now work in an app's window while you keep using your Mac: it reads, presses buttons, fills in fields, picks menu items and sees just that window, without bringing it to the front, moving your pointer or typing. It also reads the text a window shows, such as a result. Every rule still holds: you're asked once per app, password managers, Superagent itself, terminals and System Settings are refused, risky buttons are asked about, password fields are never filled, and nothing happens while your Mac is locked.

**Pinned chats show their own name first,** with the project underneath.

**The agent's logo stays in the message box** at every window width.
