# Superagent 2.0.0-beta.73

**The simulator embeds the instant its screen exists.** A freshly booted device has no screen for its first seconds; the pane called that moment "Streaming" and waited for a timer before trying to embed again. Now the first picture to arrive triggers the embed immediately, and until then the pill says what is actually happening: "Starting the device…". Superagent also writes to its `memory.log` why a pane could not embed and how long it took when it did.
