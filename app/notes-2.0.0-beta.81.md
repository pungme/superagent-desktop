# Superagent 2.0.0-beta.81

**Simulator touch is reliable tap after tap — and swipe and scroll with it.** The pane could put a finger down on the device without ever lifting it, if anything changed in the instant between press and release. A finger left down made every tap and swipe after it read as a second finger — so the first touch worked and the rest did not, worst of all for scrolling. Superagent now guarantees every touch is lifted, exactly once, from the device it was on; a new touch that finds one still down clears it first.
