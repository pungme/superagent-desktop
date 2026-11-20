# Superagent 2.1.3-beta.18

**The browser that sometimes didn't load at all.** When a page's process died (crashed, was killed, or closed itself), its pane was never replaced. The code meant to clear it away failed instead, over and over, and every address sent to the pane was dropped, so you saw a blank white pane with the address filled in. The pane is now replaced on the page it was on, and an address you type into it loads. If a page keeps killing its pane, it comes back on the empty page rather than looping.
