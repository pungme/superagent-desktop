# Superagent 2.0.1-beta.1

**A conversation's simulator stays its own — through restarts, reboots and scripts.** One conversation could still end up on a simulator another was using: Superagent forgot who owned a device when it restarted or when the device rebooted (which test runs do constantly), handed it to the next conversation that asked, and the first one's helper scripts then went on installing its app over the second's. Now:

- **Ownership is remembered** across restarts and device reboots. A device is freed only when its conversation is deleted, the device is deleted, or nobody has used it for a day.
- **Scripts are checked too.** Any command that names another conversation's simulator is stopped, not only `simctl` and `xcodebuild` typed directly, and the agent is pointed at its own device.
- **A device a conversation drives only from its shell counts as its own,** so it is never handed to someone else.
- **Each change of hands is written to `memory.log`,** so a mix-up can be traced.
