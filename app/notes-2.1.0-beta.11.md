# Superagent 2.1.0-beta.11

**One conversation can no longer clear away another's simulator.** The guard already stopped a command that named another conversation's device. It missed commands that reach every device without naming one: `simctl shutdown all`, `erase all` and `delete all`, a list of simulators piped into `xargs` or a loop, and `killall Simulator`. They are refused now, with a note to use the conversation's own device.

**Memory is a ring round the agent's logo** in a narrow message box. It is grey, amber from 75% and red from 90%. Hover the logo for a card with memory, agent, mode and account. The same ring is on iPhone and iPad.

**The small simulator in a narrow split window has no Snip button** over its screen.

**The Mac now tells the phone about its splits,** so the iPhone shows them as a grid.
