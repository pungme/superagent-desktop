# Superagent 2.1.0-beta.15

**Touch on the simulator no longer stops for good.** Two ways it could die until you restarted the app are fixed. If the helper process that carries touches to the simulator exited, the pane kept sending into the dead line and every touch waited forever; now the pane notices, drops the line, and the next touch starts a fresh helper. If the simulator restarted under a live input session, every touch timed out; now that session is replaced on the first timeout. Both are written to the log, so Copy diagnostics shows them.

**Click a picture you attached** in the message box to see it full size before you send.
