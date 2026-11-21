# Superagent 2.1.3-beta.22

**Antigravity shows what it is doing.** Its commands now carry a plain description, so the chat, the sidebar and the floating window say what step is running instead of going quiet.

**Choose the order of your accounts.** In Settings → Accounts you can put your accounts in order; the top one is used first and the next takes over when one runs out. A "you hit your 5-hour limit" message is now recognised as a limit too.

**The simulator pane no longer hangs the app.** Every call into the simulator now runs off the main thread, one queue per device, so a busy or stuck simulator can't freeze Superagent or another simulator.
