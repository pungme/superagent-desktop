# Superagent 2.0.0-beta.59

**The simulator stays embedded.** A device that was still starting up when its pane opened left the pane on the streamed picture for good. The pane now keeps trying, and switches to the embedded screen as soon as the device has one.

**Fewer simulator errors from agents.**

- **No more "Several simulators are booted…".** With an iPhone and an iPad both running, an agent used to be stopped until it chose. It now takes the iPhone (the iPad for an iPad-only app) and says which, so it can move if it meant the other.
- **Taps and swipes take what agents send.** Numbers written as text, and a swipe given as x1/y1/x2/y2, are taken instead of refused.
