# Superagent 2.1.3-beta.30

**Clicking the Dock icon always brings Superagent forward.** Switching back from another app could activate the menu bar without raising the window, and a second Dock click skipped the Space-pull path whenever focus had already fired. Superagent now raises and unhides on `did-become-active`, always moves the window to the top, and pulls across Spaces on a repeated Dock click.
