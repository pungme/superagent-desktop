# Superagent 2.0.0-beta.60

**The simulator is smooth and responsive, even while Superagent is busy.**

- **Smooth picture.** The simulator's screen used to be drawn by the same part of the app that saves chats and handles agents' output, so whenever that was busy the picture stopped, then jumped. It is drawn on its own now: in a test with the app kept busy, the longest pause went from 166 ms to under 45.
- **Touches land straight away.** A tap, drag or key used to wait in the same line. It now goes to the simulator directly: 23 ms instead of over a second while the app was busy.

**Superagent itself does far less work in the background.**

- **The chat list is read in a fraction of a millisecond, instead of 74 ms.** Conversations were stored in a way that made every listing read every conversation in full, and the menu bar did that every 0.7 seconds. The first start after updating reorganises them once, which takes a second or so.
- **Long chats with many pictures save less often while an agent works** (every 30 seconds instead of 5; the end of each turn still saves), and each save is cheaper.
