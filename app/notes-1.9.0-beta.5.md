# Superagent 1.9.0-beta.5

Beta channel.

- Simulator automation is reliable across repeated agent actions. Agent taps and swipes now discard stale persistent input connections and use a fresh connection whose failure can be reported, while direct interaction in the simulator pane keeps its low-latency path.
- A newly added Git project keeps its sole empty conversation on the project row instead of showing a misleading nested **New chat — no branch yet** row. Additional chats that are genuinely waiting for a branch still appear separately.
