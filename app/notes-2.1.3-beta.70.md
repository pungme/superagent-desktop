# Superagent 2.1.3-beta.70

**Compact works while the agent is busy.** The Compact button (the Memory bar past 75%) was disabled whenever the agent was working, and a chat on Auto or a /loop is nearly always working, so it looked dead. Now clicking it while Claude works shows "Compact next" and runs /compact the moment the turn ends (click again to cancel). When the agent is idle it compacts at once, as before. It is only offered for Claude, whose /compact is real; Codex and Antigravity manage their own context.

**Memory bar no longer says 100% for a big-window model.** When the conversation holds more than the window it guessed (846,727 of 200,000), it now uses the 1M window instead of pinning the bar at 100%.

**Tested.** e2e with a stand-in agent: idle click sends /compact; a click during a turn queues it and it runs right after.
