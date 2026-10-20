# Superagent 2.0.0-beta.69

**The simulator pane says when it is streaming.** The simulator's screen is normally embedded in the window — the device's own framebuffer, composited live. When that is not possible (the device is still booting, or Xcode moved something), the pane streams a picture instead, which looks the same and feels worse. It now shows a small "Streaming" pill with the reason, keeps trying to embed, and drops the pill the moment the real screen is in.
