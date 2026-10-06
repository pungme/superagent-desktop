# Superagent 1.9.3-beta.10

- **A new first-run setup that never leaves Superagent.** One list of agents, one button each: it installs the agent if it is missing and signs you in, in a Superagent window on the agent's own sign-in page. No Terminal, no browser, no Re-check. Someone who already has an agent connected skips the step.
- **Sign in from Settings the same way.** Settings → Agents → Sign in opens that window too.
- **Simulators: the shell is covered too.** An agent's own `xcodebuild` and `simctl` commands can no longer land on another conversation's simulator: a command aimed at one, at `booted`, or at a device by name is stopped and the agent is pointed at its own.
- **Readable in dark mode.** "Attach" on a screenshot suggestion and "I've signed in" on the browser were white on white; a switched-on toggle's knob could not be seen.
