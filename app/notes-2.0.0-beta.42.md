# Superagent 2.0.0-beta.42

**"What do you see?" now gets an answer.**

- **The first request to use the Mac asks you to turn computer use on.** It was off by default, and the only way on was a switch in Settings nobody was pointed to; asked what it could see, the agent described Superagent's own windows instead. Now the computer tools are always there, and the first time an agent reaches for one with computer use off you are asked, in the app or in the dot: say yes and it is on from then on (Settings → Computer use turns it off); say no and it does not ask again that conversation. The agent is told so, and told never to answer "what do you see" with Superagent's own desk.
- **The dot puts itself right.** Its hiding while Superagent's window is in front relied on focus events alone, and after a switch away it could stay gone; it now checks every moment and shows or hides itself accordingly.
