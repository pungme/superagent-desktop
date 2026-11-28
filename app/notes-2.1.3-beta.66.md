# Superagent 2.1.3-beta.66

**The Conductor view, matched to the mockup.**
- Toolbar: a Conductor button beside Files, Todo and Browser, and a "● Conductor" chip next to Main.
- Main: a "Main · One chat for <project>" header, quick asks above the composer (Status, Follow-up, New task, Close), and a composer that says "keep texting here — I manage the sessions".
- Sessions: "Sessions N" with Active / Needs you / Closed tabs; white cards with tinted status pills (Working blue, Needs you amber, Done green), the branch, "N msgs · time"; the card you open gets an orange outline and an orange dashed wire.
- Approval cards in Main have Inspect, which opens that session beside Main; they no longer print the session's title twice.
- Closing a session with unmerged work offers the three choices as buttons (Merge into main & close, Close & keep branch, Discard changes & close).
- The sidebar's Conductor row shows how many sessions there are.

**Auto, explained.** The Auto pill has an ∞ mark and a hover card that says what it does: when the agent finishes, Superagent asks whether anything is left and lets it keep going until the work is done, it asks you something, or you write. Routing has the same kind of hover card.

**Tested.** e2e for the header, quick asks, Inspect, tabs and pills; the full suite.
