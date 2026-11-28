# Superagent 2.1.3-beta.72

**Simulator crash loops: PosterBoard too.** The fix for a simulator whose system crashes over and over (pop-ups off while it lasts, the simulator restarted) only looked at SpringBoard. PosterBoard, the lock screen and wallpaper process, now loops the same way on the macOS 27 simulators (22 crashes in two minutes, each with a "PosterBoard quit unexpectedly" pop-up), and so can backboardd. All three are watched now. An app's own crash is not: restarting the device would only lose its state.

**Tested.** Unit tests for the three processes and for an app's crash being left alone; routing receipts checked live on Codex and Antigravity.
