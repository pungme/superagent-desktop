# Superagent 1.9.2-beta.18

- **iPhone Duo in the simulator pane.** The pane shows whichever screen is in use and switches when you fold or unfold. The agent's screenshots come from that screen too — it used to see black.
- **The live simulator view works again with Xcode 27.** Xcode 27 moved a framework the pane streams through, so it had quietly fallen back to slow screenshots.
- **The simulator pane follows which way the device is turned**, instead of only what its rotate button last asked for.
- **Projects get their real app icon.** An empty widget icon set, a widget with an icon of its own, or Xcode's newer Icon Composer icon no longer leave a project with a plain folder.
