# SuperAgent — Product Hunt Launch Plan

_Everything ready to paste. Positioning is the "local, logged-in, watchable" wedge (see MARKETING.md)._

---

## 0. The one decision that shapes everything

Launch on the **gap**, not the crowd. Not "another Claude Code GUI" (Conductor, Crystal), not "another cloud agent" (Manus, Operator). The hook:

> **An AI agent that runs on *your* computer, signed in as *you* — and you watch it work.**

Everything below serves that line.

---

## 1. Timing

- **Day:** Tuesday, Wednesday, or Thursday. (Mon is noisy, Fri/weekend dead.)
- **Time:** **12:01 AM Pacific** — PH days start then; you want a full 24h.
- **You be awake** for the first 3–4 hours to reply to every comment. Engagement in hour 1–2 drives the algorithm.
- Don't launch the same day as a big-name product if you can see it coming.

---

## 2. Product name & tagline

**Name:** `SuperAgent`

**Tagline** (PH limit ~60 chars — pick one, A/B in your head):
- `An AI agent that builds your app — and tests it for real` ✅ recommended
- `It builds your web + iOS app, then clicks through to test it`
- `Give an AI agent your Mac — and watch it build, run, and test`
- `Claude Code with a computer: build, run, and test your app`

**Recommended:** the first — "builds AND tests" is the concrete, demoable hook nobody else can show, and "for real" implies a real browser/simulator, not a sandbox.

---

## 3. Description (the ~260-char blurb under the tagline)

> SuperAgent is an AI agent that runs on your own Mac — it builds and **tests** your web app in a real browser and your iOS app in a real simulator, browses the web signed in as you, and works on a schedule. Local, on your own Claude subscription, open source. Watch it work instead of reading a terminal.

## 3a. The killer demo: "it builds AND tests, end to end"

This is the most *differentiated, demoable* thing SuperAgent does, and neither camp can match it:

- **Cloud agents (Manus/Operator)** can't build or run your code — they're browser sandboxes.
- **Claude Code GUIs (Conductor/Crystal)** can write code, but they can't *drive* a browser or *tap through* an iOS simulator to test it.

**SuperAgent does the whole loop on your machine:** write the code → run it → **open the web app in a real browser and click through it** / **launch the iOS app in a real simulator and tap through it** → see what broke → fix → repeat. Lead the launch with this — it's the "wait, it actually *tests* it?" moment.

Suggested framing for the tagline/first-line if you want to lead with it:
- **"An AI agent that builds your app — and tests it, in a real browser and iOS simulator."**
- **"It writes your app, then clicks through it to make sure it works."**

---

## 4. Topics / categories (pick 3)

`Artificial Intelligence` · `Developer Tools` · `Mac` — and if allowed a 4th, `Productivity` or `Open Source`.

(Choosing "Mac" ties you to the 2026 "desktop is the agent battlefield" wave and a browsable category.)

---

## 5. The gallery (this is what converts — plan the shots)

Order matters; the first image is the thumbnail in the feed.

1. **Thumbnail / hero (image 1):** the agent running a **web app it built** in the browser pane and clicking through it, explaining what it's checking in the chat beside it. Caption: _"It builds your web app — then opens it in a real browser and tests it."_
2. **iOS simulator (image 2):** the agent launching the app in a real simulator and **tapping through the flow**. Caption: _"Same for iOS: it runs your app in a real simulator and taps through it."_
3. **Logged-in browser (image 3):** the agent on a real, signed-in site. Caption: _"It uses your browser, signed in as you — real accounts, real data."_
4. **Schedule / routines (image 4):** a routine set up. Caption: _"Give it a job on a schedule — it works while you don't."_
5. **GIF (make this #2 if you can):** a 5–10s recording of the **build → run → click-through → fix** loop on a web or iOS app. This is the money shot — a short video massively lifts conversion.

_Keep captions short. Show it *doing*, never a settings screen._

---

## 6. First comment — the maker's note (paste as your first comment the moment it goes live)

> Hey Product Hunt 👋 I'm [name], I built SuperAgent.
>
> Every AI agent today is one of two things: a **cloud sandbox** that can't touch your real accounts or files, or a **coding tool trapped in a terminal** that writes code but can't *run* it. I wanted one that builds something and then actually checks that it works.
>
> So SuperAgent runs **locally on your Mac**. It builds your web app and **opens it in a real browser to click through and test it** — and builds your iOS app and **runs it in a real simulator, tapping through the flow**. It also drives a real browser signed in as **you** (check your dashboards, pull your data), and can work on a **schedule**. You **watch the whole thing happen** instead of reading a terminal.
>
> It runs on your **own Claude subscription**, so nothing leaves your machine and there's no new bill. It's **open source**.
>
> I'd genuinely love your feedback — especially: what would you point it at first? I'll be here all day. 🙏

---

## 7. Launch-day playbook (hour by hour)

- **T-0 (12:01 AM PT):** publish. Immediately post the maker's note (above).
- **T-0 to +2h:** reply to **every** comment within minutes. Ask each commenter a question back (drives thread depth).
- **T+1h:** post to your own audiences (see §9). Ask people to **comment**, not just upvote — comments are weighted and don't feel spammy.
- **Do NOT** mass-DM "upvote me" — PH penalizes vote manipulation. Drive people to the page; let them decide.
- **Throughout:** pin one great screenshot-reply or demo GIF in a comment when a question is common.
- **Evening:** a "we're #X, thank you" update comment re-surfaces the post.

---

## 8. Reply templates (for the comments you'll get)

- **"Isn't this just a Claude Code wrapper?"**
  > Fair — it's Claude Code with a *computer*. The wrapper is the point: the agent can finally browse your logged-in sites, run apps, use an iOS simulator, and work on a schedule, instead of just printing text. It does everything Claude Code does, plus a screen and an environment.

- **"Why local instead of cloud?"**
  > Because the value is your *real* accounts and files. A cloud sandbox can't log into your bank, your CRM, your GitHub. Local can — and nothing leaves your machine.

- **"Do I need an API key / does it cost extra?"**
  > It runs on your existing Claude subscription — no separate key, no new bill. (Coming: one-click "Sign in with Claude," and an optional hosted tier so non-devs can skip setup.)

- **"Windows / Linux?"**
  > Mac first (that's where the desktop-agent action is). [Say the truth about your roadmap.]

- **"Is it safe to let it use my logins?"**
  > It runs on your machine in your own browser session — same trust boundary as you using Chrome. You watch every action, and you choose how much it can do without asking (there's a permission mode).

---

## 9. Where else to post (day-of cross-promotion)

- **X/Twitter:** a thread — the wedge + the demo GIF + "we're live on PH [link]." Lead with the video.
- **Hacker News:** a "Show HN: SuperAgent — an open-source AI agent that runs on your Mac and uses your real browser." (HN loves local-first + open source; do NOT mention PH there.)
- **Reddit:** r/LocalLLaMA, r/ClaudeAI, r/macapps — genuine "I built this" posts, not ads.
- **Relevant Discords/Slacks** (Claude, indie hackers) — share the demo, ask for feedback.
- **Your email list / existing users**, if any.

---

## 10. Pre-launch (the week before)

- Build a **"coming soon"/ship page on Product Hunt** to collect followers — they get notified at launch (huge first-hour boost).
- Line up **10–20 people** who'll genuinely engage in the first hour (friends who'll actually try it and comment).
- Consider a **hunter**: a well-followed hunter posting it can help, but a good self-hunt with a real maker story works fine now. Only use a hunter if they'll actually champion it.
- Have the **demo GIF** and all screenshots done (this is the current screenshot pass).
- Make sure the **download works and the app opens clean** for a first-timer — the #1 way to waste a launch is a broken first run.

---

## 11. Assets checklist

- [ ] Thumbnail image (agent + logged-in browser) — 1270×760, first in gallery
- [ ] 4–5 gallery images with captions (§5)
- [ ] 5–10s demo GIF/video of one real task
- [ ] Logo (240×240)
- [ ] Tagline + description finalized (§2, §3)
- [ ] Maker's first comment ready to paste (§6)
- [ ] Working download + clean first-run verified
- [ ] "Sign in with Claude" or clear one-line setup, so first-run isn't a wall
- [ ] X thread + Show HN draft ready

---

## 12. The honest pre-launch risks (fix or frame these)

1. **Onboarding.** "Install Claude Code first" contradicts "for everyone." Either embed the runtime + add "Sign in with Claude" **before** launch, or be upfront that it's for people who already have Claude Code (a valid, dev-focused launch — just pick one story).
2. **Pick the hero.** The product does three things; lead the launch with **"it uses your computer/the web for you."** Keep the coding power as the deep end. A launch that tries to say all three says none.
3. **First run must be flawless.** Every visitor who downloads and hits a wall is a lost vote and a bad comment.

---

_See MARKETING.md for the full competitor landscape and the reasoning behind this positioning._
