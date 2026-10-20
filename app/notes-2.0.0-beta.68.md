# Superagent 2.0.0-beta.68

**Agents stop losing their files in `/tmp`.** Agents put exports, mockups and the screenshots they show in `/tmp` by habit — and macOS empties `/tmp` on every restart and deletes anything there untouched for three days, so "the exported file is gone, I'll export again" kept happening. Agents in a project are now told to keep such files in the project, in a `.superagent/` folder at its root that stays out of git, and to use `/tmp` only for things that are disposable within the turn.
