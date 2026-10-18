# Superagent 2.0.0-beta.56

**Switching accounts works again, and the iPhone Duo folds from the pane.**

- **Picking an account always takes.** An account the app had marked as out of allowance could not be picked from a chat's Account pill: the click did nothing and the chat stayed where it was. A pick by hand now clears the mark and the chat goes to that account; marks that outlived their reason clear themselves when fresh usage shows the allowance is not used up, and a marked account says so in the menu.
- **Fold and unfold an iPhone Duo.** The simulator pane's fold button failed with "Process spawn via launchd failed". Folding now goes through the simulator's own input service, as Xcode's Device Hub does, with nothing to build or launch inside the device.
