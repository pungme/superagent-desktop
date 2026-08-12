# SuperAgent — Positioning & Launch Strategy

_Working doc. Competitor landscape, the differentiation wedge, and a Product Hunt plan._

---

## TL;DR — the one line

> **SuperAgent is an AI agent that lives on your own computer — it browses the web signed in as you, builds and runs real apps, and works on a schedule, all on your machine and your own Claude subscription. You watch it happen.**

The wedge, in three words: **local, logged-in, watchable.**

---

## The competitor landscape (two camps, and the gap between them)

Everyone building agents falls into one of two camps. SuperAgent is the only thing in the gap.

### Camp 1 — Cloud "computer-use" agents (run in a remote sandbox)

Manus (now Meta), OpenAI Operator, Google Project Mariner, Anthropic Claude Computer Use.

- They drive a browser **in the cloud**, on someone else's servers, seeing screenshots.
- **They can't touch your real logins, files, or machine.** The security story is "it's sandboxed" — which is also the ceiling: it can't check *your* dashboard, use *your* accounts, or edit *your* code.
- You don't watch it on your own screen; you get a result back.

### Camp 2 — Claude Code GUIs (a terminal with a nicer face)

Conductor (YC), Crystal / Nimbalyst, Claude Squad, and Anthropic's own redesigned Claude Code desktop app.

- All the same shape: **run parallel coding agents in git worktrees, review diffs, merge.** Pure developer tooling.
- No browser signed in as you. No iOS simulator. No "watch it use the web." No schedule.
- Anthropic's own desktop app recently added an in-app browser — a signal the browser matters, but it's still a coding tool with a preview, not an agent that *uses* your computer.

### The gap SuperAgent owns

SuperAgent is the **only** one that is:

| | Cloud agents (Manus/Operator) | Claude Code GUIs (Conductor/Crystal) | **SuperAgent** |
|---|---|---|---|
| Runs on **your** machine | ❌ remote sandbox | ✅ | ✅ |
| Uses **your real logins** | ❌ fresh/no session | ❌ no browser | ✅ your own browser session |
| Builds & runs real apps | ⚠️ limited | ✅ | ✅ (+ live preview, iOS simulator) |
| You **watch** it work | ❌ | ⚠️ terminal-ish | ✅ a real screen |
| Runs on a **schedule** | ⚠️ | ❌ | ✅ routines |
| You **own** it | ❌ their servers, their bill | ✅ | ✅ local, open source, **your own Claude sub** |

**Nobody else is both a real coding agent AND a computer-use agent, running locally on your own machine, logins, and subscription — that you watch.**

---

## Why this timing is right

Product Hunt in 2026 is rewarding exactly what SuperAgent is:

- **Execution over assistance** — winners "execute on your behalf," not "think with you."
- **Local-first & privacy** architectures are featuring prominently in launches and resonating.
- The **Mac desktop has become the new agent battlefield** (mid-2026 trend).

SuperAgent is local-first, it owns real tasks, and it's a Mac desktop agent. It's swimming with the current, not against it.

---

## Product Hunt launch plan

### The angle

Do **not** launch as "another Claude Code GUI" (crowded: Conductor, Crystal, Squad) or "another computer-use agent" (crowded: Manus, Operator). Launch on the **gap**: an agent that uses **your** computer and **your** logins, locally, that you watch — powered by your own Claude subscription, so there's no new bill and nothing leaves your machine.

### Tagline candidates (pick one, test the rest)

1. **"Give an AI agent your Mac — and watch it work."**
2. **"Claude Code, but it can see and use your whole computer."**
3. **"The desktop where your AI agent lives: your browser, your files, your logins."**
4. **"An AI agent on your machine, signed in as you. Not a cloud sandbox."**

Lead recommendation: **#1** for reach (normie-legible), **#2** if the launch-day crowd skews developer (Claude Code is the recognition hook).

### The one-sentence description (PH "tagline" field, ~60 chars)

> _An AI agent that lives on your Mac — browses as you, builds apps, runs on a schedule._

### First comment (the maker's note — this is what converts on PH)

Frame it as the gap:

> Every agent today is either a cloud sandbox that can't touch your real accounts, or a coding tool trapped in a terminal. I wanted one that just... uses my computer. So SuperAgent runs locally on your Mac, drives a real browser signed in as *you*, builds and runs real apps (with a live preview and an iOS simulator), and can work on a schedule — and you watch the whole thing. It runs on your own Claude subscription, so nothing leaves your machine and there's no new bill. Open source.

### Proof-shots (the launch gallery — tie to the screenshot pass)

1. **Hero:** the agent driving a real, logged-in website in the browser pane while it explains what it's doing in the chat. (The "it uses your computer" money shot.)
2. **iOS simulator:** the agent building + running an app, tapping through it live.
3. **Schedule/routines:** "every morning, check X" — the unattended angle.
4. **Sidebar/projects:** it manages many projects/logins at once.

### Objection handling (have these ready in comments)

- **"Isn't this just a Claude Code wrapper?"** → It's Claude Code with a *computer*: a browser on your logins, a simulator, a desk, a scheduler. The wrapper is the point — the agent can finally *do* things, not just print them.
- **"Why local instead of cloud?"** → Because the value is your real accounts and files. A sandbox can't log into your bank, your CRM, your GitHub. Local can — and nothing leaves your machine.
- **"Do I need an API key?"** → It runs on your existing Claude subscription. (Roadmap: one-click "Sign in with Claude," and an optional hosted tier so non-devs skip setup entirely.)

---

## What to fix before launch (so the pitch is honest)

- **Onboarding is the risk.** "Install Claude Code first" undercuts "for everyone." Highest-leverage pre-launch fix: embed the agent runtime so there's no separate CLI install, and add **"Sign in with Claude."**
- **Pick the hero job.** The product does three things (build software, use the web, run on a schedule). Lead the launch with **"use the web/your computer for you"** — it's the true differentiator; keep the coding power as the deep end.

---

_Sources: computer-use landscape and desktop-agent form factor (Turing Post, Manus blog, AgentMarketCap); Claude Code GUI competitors Conductor / Crystal-Nimbalyst / Claude Squad (Nimbalyst, runpane, Superset); Product Hunt 2026 agent trends — execution-over-assistance, local-first, Mac desktop battlefield (shareuhack Product Hunt Weekly, Product Hunt AI Agents category)._
