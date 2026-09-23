# Superagent 1.9.1-beta.21

- Projects that hold several repos show their app's icon again. The search for an app icon stopped three folders down, so an app inside one of the project's repos was never found. It now looks deeper, stays quick by skipping build and dependency folders, and picks the main app icon over alternates.
