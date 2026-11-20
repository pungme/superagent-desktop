# Superagent 2.1.3-beta.19

**Running out on Antigravity now moves the chat on.** Antigravity says "Individual quota reached… Resets in 141h17m16s", which Superagent did not recognise, so the chat stopped on the error. It now counts as the account being out until that reset, and with Automatic switching the chat carries on with Claude or Codex, whichever is signed in with allowance, and sends your message again. A rate limit that clears in a few minutes is left for Antigravity to retry.

**The line under a working session says what it is doing, in words.** It showed the raw command ("Terminal · ./scripts/build-app.sh 2>&1 | tail -1"). It now shows the step's own description ("Build the app bundle"), or what the agent said it is about to do ("Merging to main"), or a plain "Running a command".
