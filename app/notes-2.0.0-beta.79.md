# Superagent 2.0.0-beta.79

**Two conversations cannot land on the same simulator by accident.** Each conversation has its own device, and the shell guard already stopped `booted` and `-destination name=…`. It now also stops `simctl` commands that name a device — `simctl install "iPhone 17" …` — when that device is another conversation's (it says whose), or when the name is ambiguous; a conversation's own device, by name or UDID, goes through.
