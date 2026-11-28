# 2.1.3-beta.75

Performance:
- Start-up parses half as much JavaScript: the main bundle went from 2.1 MB to 1.1 MB. Settings, Onboarding, Today, Routines and the Markdown editor (728 KB) now load when first opened.
- The Conductor list reads each session's last message at most every 30 s instead of on every refresh.
