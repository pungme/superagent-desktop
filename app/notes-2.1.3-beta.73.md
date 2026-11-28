# Superagent 2.1.3-beta.73

**A guardrail against simulator crash loops, on by default.** A simulator whose system keeps crashing (SpringBoard, PosterBoard, backboardd) is restarted once. If it crashes again right after, Superagent now shuts it down, leaves it down and tells you with a notification ("Superagent stopped the “iPhone Duo” simulator: PosterBoard kept crashing, even after a restart"), so it cannot fill the screen with pop-ups or burn the Mac for hours. It applies to every simulator, whichever chat is using it. Settings → Simulators has a switch (on) if you ever want it off.

**Tested.** Unit tests: first loop restarts, a loop after a restart shuts down, a shut-down device is left alone, crashes from before a restart do not count.
