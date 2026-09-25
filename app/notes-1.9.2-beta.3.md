# Superagent 1.9.2-beta.3

- Safer real-browser mode. Superagent now controls its Brave or Chrome over a private channel only it can use, instead of a local port that any program on your Mac could have connected to while it ran. If Superagent crashes, that browser now quits too.
- Open window and Open Brave bring up the agent's Brave, not your everyday one.
- The agent uses Brave's first blank tab instead of opening a second, and switching a project back to the built-in browser closes its tabs in Brave.
