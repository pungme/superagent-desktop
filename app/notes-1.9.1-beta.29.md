# Superagent 1.9.1-beta.29

- Much lower CPU when idle. The pulsing status dots (like the one saying an update is ready) repainted the window every frame; one dot alone cost about a quarter of a CPU core. They now cost a fraction of that.
- To check a page on a phone, the agent switches the browser pane to a real mobile viewport (390×844) instead of building a narrow page to imitate one.
