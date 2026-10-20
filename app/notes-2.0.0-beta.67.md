# Superagent 2.0.0-beta.67

**Dictation can actually ask for the microphone.** Pressing the mic said "Superagent is not allowed to use the microphone" and opened System Settings — where Superagent was not in the list, so there was nothing to allow. The app was missing the microphone entitlement that a notarized app needs; without it macOS refuses silently. Now the first press shows the normal macOS "would like to access the microphone" prompt, and Superagent appears in the list.

**The dictation error line can be dismissed.** It had no close button.
