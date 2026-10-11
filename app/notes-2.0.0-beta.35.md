# Superagent 2.0.0-beta.35

**A page on your phone no longer spins for ever.**

- **The phone's picture of a page arrives even when the page is still.** The Mac remembered the last frame it sent for a conversation and answered "unchanged, no bytes" whenever the page had not moved since — including to a phone that had nothing yet: the app relaunched, or a second phone. A still page then never arrived and the card spun for ever, address and all. Now the phone says which frame it holds, and the Mac sends the picture unless it is that one. The same for the simulator's mirror. Needs the phone app from 2026-10-11 or later; an older phone keeps the old behaviour.
