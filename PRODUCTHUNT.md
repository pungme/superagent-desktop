# Superagent — Product Hunt Launch Plan

_Everything ready to paste. Positioning is the "local, logged-in, watchable" wedge (see MARKETING.md)._

---

## 0. The one decision that shapes everything

Launch on the **gap**, not the crowd. Not "another Claude Code GUI" (Conductor, Crystal), not "another cloud agent" (Manus, Operator). The hook:

> **The open-source Claude Code UX — a computer you watch, not a terminal you read.**

Every other Claude Code app is code + chat — a prettier terminal. Superagent gives Claude a whole computer you watch it use: a real browser (logged in as you), a real iPhone simulator it taps through, your files, a calendar, scheduled routines. It's the difference between *reading what an AI did* and *watching it work* — a teammate at a desk, not a wall of text.

And because you can read every line of it, "watch it work" isn't a promise — it's verifiable. That's the whole pitch: **the most powerful thing you can give an AI is your real computer, and the only honest way to ship that is in the open.**

Everything below serves that line.

---

## 1. Timing

- **Day: Sunday** (decided). Lower traffic, but far less competition — a solo/indie launch can realistically take the top spot, and PH's weekly newsletter still counts you.
- **Time:** **12:01 AM Pacific** — PH days start then; you want a full 24h.
- **You be awake** for the first 3–4 hours to reply to every comment. Engagement in hour 1–2 drives the algorithm.
- Don't launch the same day as a big-name product if you can see it coming.

---

## 2. Product name & tagline

**Name:** `Superagent`

**Tagline** (PH limit ~60 chars):
- `The open-source Claude Code UX` ✅ decided — renders as **Superagent — The open-source Claude Code UX** (30 chars)

Alternates if you want to test the feel:
- `Best Claude Code UX — open source` (33)
- `The open-source desktop app for Claude Code` (43)
- `Open-source Claude Code, with a computer` (40)

**Why open source belongs in the tagline, not the footnotes:** it's the only differentiator here that a competitor can't copy by shipping a feature, and it's searchable — "open source" is a term people actively filter for on PH and HN. It also converts your biggest objection into your headline (see §2a).

### 2a. Why open source is the wedge (not just a badge)

Most products list "open source" as a footer virtue. For Superagent it's the **answer to the objection the product itself creates**:

> "You want me to let an AI drive my browser, signed into my bank, my CRM, my GitHub?"

There are only two possible answers. A closed app says *trust us*. Superagent says **read the code** — every line that touches your session is on GitHub. That's not a nicer answer to the same question; it's the only one that actually resolves it.

Three things follow, and each is a launch asset:

1. **It's a moat competitors can't copy in a sprint.** Conductor and Crystal can ship a browser pane. They can't retroactively become auditable — open-sourcing a commercial product is a business decision, not a feature.
2. **It makes "local" credible.** "Nothing leaves your machine" is an unverifiable claim from a closed binary. From a public repo it's a checkable fact — and people *will* check, which is free scrutiny that converts skeptics into advocates.
3. **It changes the audience.** Open source is the difference between "an app I'd try" and "a project I'd star, fork, and post about." Stars and forks keep compounding after launch day, long after the PH ranking freezes.

**The line to reuse everywhere:** _"You're handing it your logged-in browser. You should be able to read exactly what it does with it."_

**Watch the free-vs-open trap.** Don't let "open source" get heard as "free, so probably unsupported." Pair it with the polish every time — *"open source and it looks like it belongs on a Mac"* — because your differentiator versus most OSS is that this one is genuinely beautiful.

---

## 3. Description (the ~260-char blurb under the tagline)

> The open-source desktop app for Claude Code. Watch it work instead of reading a terminal: it drives a real browser signed in as you, taps through your iOS app in a real simulator, and runs on a schedule. Local, on your own Claude subscription, and every line auditable.

**The three proof points, in order:** **open source** (you can read exactly how it touches your browser), **you just watch** (no commands to learn — browser, phone, and files change live on screen), and **one-click setup** (Install-Claude-Code means a non-dev is running in a minute, no terminal, no npm). Show all three in the gallery.

## 3a. The killer demo: "it builds AND tests, end to end"

This is the most *differentiated, demoable* thing Superagent does, and neither camp can match it:

- **Cloud agents (Manus/Operator)** can't build or run your code — they're browser sandboxes.
- **Claude Code GUIs (Conductor/Crystal)** can write code, but they can't *drive* a browser or *tap through* an iOS simulator to test it.

**Superagent does the whole loop on your machine:** write the code → run it → **open the web app in a real browser and click through it** / **launch the iOS app in a real simulator and tap through it** → see what broke → fix → repeat. Lead the launch with this — it's the "wait, it actually *tests* it?" moment.

Suggested framing for the tagline/first-line if you want to lead with it:
- **"An AI agent that builds your app — and tests it, in a real browser and iOS simulator."**
- **"It writes your app, then clicks through it to make sure it works."**

---

## 4. Topics / categories (pick 3)

`Open Source` · `Artificial Intelligence` · `Developer Tools` — and if allowed a 4th, `Mac`.

**`Open Source` is now a must-pick, not the spare.** It's a browsable category with a self-selecting audience that upvotes on principle, and it's far less crowded than `Artificial Intelligence`, where you're one of forty AI launches that day. "Mac" still ties you to the "desktop is the agent battlefield" wave — keep it if you get a fourth slot.

---

## 5. The gallery (this is what converts — plan the shots)

Order matters; the first image is the thumbnail in the feed.

1. **Thumbnail / hero (image 1):** a 10-sec GIF, split-screen — chat on one side, a real browser + iPhone simulator on the other, Claude clicking and tapping through an app it just built. Caption: _"You don't read what the AI did. You watch it work."_ (If the slot demands a static image, use a frame of this and put the GIF at #2.)
2. **iOS simulator (image 2):** the agent launching the app in a real simulator and **tapping through the flow**. Caption: _"Same for iOS: it runs your app in a real simulator and taps through it."_
3. **Logged-in browser (image 3):** the agent on a real, signed-in site. Caption: _"It uses your browser, signed in as you — real accounts, real data."_
4. **Schedule / routines (image 4):** a routine set up. Caption: _"Give it a job on a schedule — it works while you don't."_
5. **Open source (image 5):** the GitHub repo — stars, the actual source of the browser-driving code — or a split of the app beside the file that implements it. Caption: _"It's your browser. Read exactly what it does with it."_ This is the trust shot; put it last so it's the note people leave on.

_Keep captions short. Show it *doing*, never a settings screen._

---

## 6. First comment — the maker's note (paste as your first comment the moment it goes live)

> Hey Product Hunt 👋 I'm [name], I built Superagent.
>
> Claude Code is incredible — and stuck in a terminal. Superagent gives it a **screen**. Think **Claude Code meets Arc**: a beautiful, sidebar-and-panes Mac app where you don't read what the AI did — you **watch it do it**: open your site, click through it, tap your app on a real iPhone simulator, fix what broke.
>
> It runs **locally on your Mac**, drives a real browser signed in as **you** (check your dashboards, pull your data), runs your iOS app in a **real simulator and taps through it**, edits your files next to the chat, and can work on a **schedule**. Setup is one click — no terminal, no npm. It uses your **own Claude subscription**, so there's no new bill.
>
> One thing I want to be upfront about, because it's the reason I built it this way: **you're handing this thing your logged-in browser.** I don't think you should have to take my word for what it does with that. So the whole app is **open source** — every line that touches your session is on GitHub, and nothing leaves your machine. [github.com/…]
>
> I'd genuinely love your feedback — especially: what would you point it at first? And if you read the code, tell me what you'd do differently. I'll be here all day. 🙏

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

- **"Is it really open source, or 'source available'?"**
  > Really open source — [LICENSE], full history, issues and PRs open. Fork it. The browser-driving code is [path], if you want to go straight to the part that matters.

- **"What's the catch / how do you make money?"**
  > No catch on the app — it's open source and runs on your own Claude subscription, so I'm not reselling you tokens. [If you have a plan: an optional hosted tier for people who don't want to set anything up. If you don't: say so — "I built it for myself and I'd rather it be used than monetized" is a completely respectable answer on PH, and honesty here reads far better than a vague roadmap.]

- **"Is it safe to let it use my logins?"**
  > It runs on your machine in your own browser session — same trust boundary as you using Chrome. You watch every action, and you choose how much it can do without asking (there's a permission mode). And you don't have to take my word for any of that — it's open source, so you can read exactly how it touches your session: [link to the file].

---

## 9. Where else to post (day-of cross-promotion)

- **X/Twitter:** a thread — lead with the demo GIF and the cool line: _"Claude Code meets Arc. You don't read what the AI did — you watch it do it: open your site, click through it, tap your app on a phone, fix what broke. It's Claude Code, made human."_ Then "we're live on PH [link]."
- **Hacker News:** "Show HN: Superagent — an open-source AI agent that runs on your Mac and uses your real browser." This is where open source pays off most — HN's audience reads the repo before the landing page, so link GitHub *first* and the site second, and lead the post body with the trust argument (§2a) rather than the feature list. Do NOT mention PH there.
- **r/opensource and r/selfhosted** — add these to the Reddit list; "open source" is the entire reason those communities will care.
- **Awesome-lists & OSS aggregators:** submit to awesome-claude / awesome-ai-agents style lists and OSS newsletters in the days *after* launch — that's the tail that keeps stars coming once the PH page goes quiet.
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
