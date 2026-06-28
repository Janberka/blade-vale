# Blade Vale — Release Roadmap

## Vision: Why This Will Be Addictive

Blade Vale already has the hardest thing to build: a 9/10 thirty-second experience — hit-stop, trauma shake, pose-snap swordplay, guard breaks, dodge i-frames, and wolf-pack AI that flanks you for real. What it lacks is everything that turns thirty seconds into thirty hours: **memory** (a best score to beat), **variance** (a reason run #5 differs from run #1), **arc** (bosses and a winnable climax instead of attrition fog), and **stakes** (a visible multiplier to protect, allies who can die for good). The thesis: do not add more combat — wrap the existing combat in persistence, drafts, bosses, and a daily seed, deliver it through a zero-friction browser funnel (sub-2MB, loads in seconds, no assets), and convert that funnel into a $4.99 Steam release. Every phase below ships something public, and "addictive" is defined by gate metrics (retry rate, runs/session, session length), not vibes.

---

## Milestone Plan

### Phase 0 — Safety Net (Week 1, ~2 days of work)
**Goal:** The game cannot be lost, and the single runtime point of failure is gone.
**Exit criteria:** Repo pushed to GitHub; game runs with the network cable unplugged; a stranger can play via URL.
- `git init` in `/Users/vic/Documents/GitHub/low-poly-hack-slash`, first commit, push to a private GitHub remote — **before any other edit**
- Vendor three.js r128 locally (download the file, replace the cdnjs `<script>`); keep the version, kill the CDN dependency
- Add `window.onerror` reporter + visible build version string; minimal README (controls, how to run)
- Fix stuck keys: `blur` listener that clears the `keys{}` object (the future #1 bug report, 2 lines)
- Deploy as-is to an unlisted itch.io page + GitHub Pages; this web build stays alive forever as the funnel
- Claim the name: itch page draft, Bluesky/X/TikTok/YouTube handles; post the first raw combat GIF

### Phase 1 — Shippable Skeleton (Weeks 1–2)
**Goal:** The three structural blockers (pause, persistence, state) land, and strangers' play is observable.
**Exit criteria:** A stranger plays 3+ runs with zero instructions; their best score survives a reload; telemetry shows the wave they died on.
- Replace scattered `gameRunning`/`betweenWaves`/`player.alive` booleans with one state machine (menu / playing / paused / between-waves / dead) — pause, settings, draft screen, and tutorial all hang off this
- Esc pause + auto-pause on `visibilitychange`; overlay with resume / restart / mute placeholder
- Persistence module: small versioned localStorage wrapper (one schema, before highscore/settings/progression each invent their own)
- Best score + best wave persisted; death recap with near-miss framing: "NEW BEST!" (gold banner + shake) or "Only 800 short of your best" — the cheapest, strongest retention mechanic in the whole plan
- Death screen run stats (wave, kills, best combo) + one-key instant retry; restart speed is sacred
- Keyboard attack alternative (mouse-only attack locks out keyboard players)
- Telemetry (GoatCounter or PostHog free tier): runs/session, retry rate, wave-at-death, session length
- Recruit 5–10 strangers (Discord playtest servers, r/playmygame); watch 2 over screen share

### Phase 2 — Sound and the First Minute (Weeks 3–6)
**Goal:** A 10-minute run feels like a finished game; nobody quits confused.
**Exit criteria:** Retry rate >40%; 3 fresh testers learn block/dodge/combo without being told and retry at least once after dying.
- Procedural WebAudio SFX (~100-line oscillator/noise helper, zero assets): swing whoosh per combo step, steel clang on block, guard-break crunch, kill thump **pitch-shifted by combo count** (the escalating reward ladder), low-HP heartbeat, wave horn. Hook points already exist: `damageEnemy`/`killEnemy`/`damagePlayer`/block branch/`showWaveBanner`. AudioContext init on the start button
- One combat music loop with an intensity layer tied to wave/HP (CC0 or generated); ducking under hit-stop
- Settings overlay off the pause menu, persisted: volume, screen-shake/vignette intensity sliders, quality toggle (shadow size, pixel ratio, torch count), colorblind-safe faction cues (shape/outline, not just red-vs-green)
- Contextual onboarding (first-run localStorage flag): wave 1 shrinks to 3 grunts; just-in-time prompts — "Click — attack", "Hold SHIFT — block!" on first enemy windup, "SPACE — dodge!" on first flank/guard-break, "Chain clicks — combos hit harder". Each shows once. No tutorial level
- Banked score multiplier: grows on kills-without-being-hit, big HUD element that visibly drains and shatters on damage; blocks preserve it, guard break halves it. Converts existing combat into continuous tension for ~80 lines
- Difficulty pass on waves 1–10 using the Phase 1 wave-at-death histogram (waves 1–3 winnable by a first-timer)

### Phase 3 — Tech Week, Then Public Beta (Weeks 7–11)
**Goal:** Codebase ready for 3x growth; itch page public; performance proven before traffic arrives.
**Exit criteria:** 100+ tracked plays, retry rate >50%, median session >8 min, 60fps with 45 actors on an integrated-GPU laptop.
- **Timeboxed 2-week tech window, own branch:** Vite + npm, upgrade to current three.js (relight for the r155+ intensity model), split game.js into ES modules along its existing section comments, unify `damageEnemy`/`damageAlly` into one combatant path. Regression checklist from current behavior; old build stays live as canary; **if it slips past 2 weeks, ship the beta on r128 and finish after** — the feel is the product
- Crowd performance pass against measured wave-10 numbers: shared materials per palette, shadow-caster budget, live actor cap, pooled sparks/popups if profiling demands, FPS counter, potato mode
- First boss: scaled brute at wave 5 with a boss bar and one new move from the existing MOVES table
- Mortal, named allies: stop free respawns, persist the warband across waves, names on health bars, "Warband 3/4" in HUD, surviving names on the death recap — attachment for ~60 changed lines
- Public itch.io page: 3 combat GIFs (wolf-pack flank and guard-break are the GIF currency), browser embed, feedback link; open the Discord the same day; Show HN + r/WebGames + r/playmygame posts
- Web presentation: favicon, OpenGraph tags (shared links must unfurl), loading state, fullscreen toggle

### Phase 4 — The Addiction Loop (Weeks 12–17)
**Goal:** Variance, arc, and meta land; metrics prove compulsion before any commercial push.
**Exit criteria:** Retry rate >65%, runs/session ≥3, median session ≥15 min, testers unprompted ask when the full version ships.
- Between-wave draft: pick 1 of 3 boons (15–20 upgrades tweaking existing constants: HP, speed, stamina costs, combo window, lifesteal, dodge i-frames, ally buffs; rarity tiers). Converts the dead 3-second timer into the most anticipated moment of the run
- Run arc: boss every 5 waves, milestone banners, **victory at wave 15** + endless mode after; difficulty steepens past wave 10
- Wave mutators + elite affixes ("BERSERK — 30% faster, 2x score"; shielded/frenzied tints) — N enemies × M affixes is the cheap content multiplier
- Daily challenge: mulberry32 seeded PRNG (route all `Math.random` call sites through it), date-seeded run, one rotating modifier, Wordle-style share string ("Blade Vale #142 — Wave 9, 24,350") copied from the death screen
- Meta progression v1: Valor earned per run (even wave-2 deaths pay out), unlock board on the start screen — weapon variants (greatsword/daggers as stat+geometry tweaks), ally types, starting boons drawn from the draft pool. Options and variety, never baseline power
- Local top-10 run history; juice pass 2 (kill-streak slow-mo, shatter deaths, score tally count-up)
- Weekly Discord playtest; fix the top rage-quit point (death with no retry) every week
- One fully-off week at the end of this phase

### Phase 5 — CrazyGames + Steam Page (Weeks 18–23)
**Goal:** First revenue channel live; wishlist clock starts as early as possible.
**Exit criteria:** Live on CrazyGames; Steam page public with trailer; demo build submitted; web funnel intact.
- **Steam page in week 1 of this phase** — wishlists compound with time: pay the $100, capsule art, 5 screenshots, 45-second GIF-paced trailer
- CrazyGames submission: SDK integration (ad breaks only at between-wave/death boundaries, riding the pause system — never mid-combat, never revive-for-ad), self-hosted bundle, store assets. CrazyGames is the lead portal — it accepts desktop-keyboard games today and takes no exclusivity; Poki waits until a touch version exists post-1.0
- Tauri desktop wrapper + Steamworks basics: achievements, cloud save of unlocks/highscores
- Controller support (tank controls map naturally to stick + face buttons) and key rebinding; complete the settings menu — Steam reviews punish missing options
- Demo = first 10 waves + boss, ending on a wishlist CTA; add the CTA to the itch build's death screen
- One email to Armor Games (mygame@armorgames.com) — accept whatever sponsorship it yields, block nothing on it

### Phase 6 — Next Fest, Content Lock, 1.0 (Weeks 24–36)
**Goal:** Ride one Next Fest well, then ship.
**Exit criteria:** Next Fest completed with a measurable wishlist bump; 1.0 live on Steam ($4.99, 10% launch discount) + itch; week-1 hotfix shipped; public post-launch roadmap.
- Next Fest gate: enter only with ~2k+ wishlists; otherwise skip to the following fest — you get one per game
- Written, frozen 1.0 content lock: 3 arena biomes, 3 weapons/stances, 6 enemy types, 3 bosses, endless + daily seed. Everything else goes to the icebox, one-in-one-out
- Accessibility completion: reduce-motion, photosensitivity-safe vignette option, remappable everything
- AI-assisted UI localization to FR/DE/PT-BR/zh-CN
- Fest week: looped broadcast on the Steam page, daily GIFs, reply to every demo comment; one post-fest week to act on the top 3 findings, nothing more
- Launch: balance freeze 2 weeks out, Discord bug bash, min-spec certification on an integrated-GPU laptop, press kit + emails to ~20 Vampire-Survivors-likes YouTubers 2 weeks out, day-1 Reddit/itch/Discord posts
- Reserve the full week after launch for hotfixes — zero planned work
- Global daily leaderboard (Cloudflare Worker + KV, plausibility-cap anti-cheat) ships **post-launch**, once there is traffic to populate it; an empty leaderboard is anti-retention

---

## Distribution Strategy

The route to market is a funnel, not a launch. Positioning line for every page: **"Lead your warband. Hold the line. One more wave."** — Souls-like deliberate melee, Vampire Survivors run-compulsion, in your browser tab right now. The unfair advantage is craft-per-kilobyte: a sub-2MB zero-asset build that loads in seconds.

1. **itch.io (Phase 0 unlisted → Phase 3 public)** — validation and feedback, not revenue. Success = a few hundred plays, 4.0+ rating, proof the loop retains
2. **CrazyGames (Phase 5)** — the lead commercial portal: 30M MAU, desktop-keyboard accepted, 60/70% revshare, no exclusivity. Their algorithm rewards exactly the D1/D7 retention Phase 4 is built to produce
3. **Steam (Phase 6)** — the real-money test: $4.99 Tauri-wrapped, demo into Next Fest, every portal page funneling wishlists. Good outcome 500–2,000 copies; breakout is streamer-driven
4. **Armor Games** — one email, modest license fee, zero engineering
5. **Poki and mobile stores — strictly post-1.0**, and only if metrics justify building touch controls; Poki's web-exclusivity preference conflicts with CrazyGames, so it is an alternative lead portal, not an addition
6. **Marketing cadence throughout:** 1–2 sub-15-second GIFs per week (flank kills, guard breaks, warband charges) on Bluesky/X/TikTok/Shorts, every post linking the playable build; devlog at Phase 2 exit ("procedural low-poly rigs in one JS file" travels well); the daily-seed share string is the built-in viral channel

## Metrics

| Metric | Source | Phase 2 gate | Phase 3 gate | Phase 4 gate |
|---|---|---|---|---|
| Retry rate (death → new run) | telemetry | >40% | >50% | >65% |
| Runs per session | telemetry | — | 2+ | ≥3 |
| Median session length | telemetry | — | >8 min | ≥15 min |
| Wave-at-death histogram | telemetry | tunes waves 1–10 | no cliff before wave 3 | smooth curve to 15 |
| Rage-quit points (death, no retry) | telemetry | identified | top one fixed weekly | trending down |
| FPS @ 45 actors, integrated GPU | profiling | measured | 60fps locked | regression-checked |
| Steam wishlists | Steam | — | — | 2k to enter Next Fest, ~5k+ at launch |

Decisions follow telemetry from anonymous strangers, not Discord veterans. Every milestone gate requires watching 2–3 fresh first-timers.

## We Will NOT Do

- **Energy systems, real-time timers, recharging lives, login streaks, escalate-and-reset daily rewards** — the entire appeal is "one more run RIGHT NOW"; the daily seed is an invitation, never a punishment for absence
- **Pay-to-win, paid stat boosts, loot boxes/gacha** — one purchasable +10% invalidates every "NEW BEST" moment and every leaderboard
- **Ads inside the core loop** — portal builds take ad breaks only at wave/death boundaries via the pause system; no interstitials mid-combat, no revive-for-ad (death must matter); Steam and itch builds are ad-free
- **Hidden rubber-banding or pity-loss difficulty** — deaths must be legible and the player's fault, or near-miss framing collapses
- **Power-gating core verbs** — dodge, block, and combos are in run #1 forever; unlocks add options, not the baseline fun
- **Fake social proof, nag-share dialogs, notification spam** — one clean share button that never interrupts the restart flow
- **glTF/asset pipeline** — zero-asset procedural characters are a strategic strength (tiny payload, instant load, free variants)
- **Replacing pose-snap animation with skeletal/AnimationMixer** — the snappy guard-to-guard transitions ARE the signature feel
- **ECS frameworks, TypeScript rewrite for its own sake, WebGPU, multiplayer, server infrastructure pre-traction** — local persistence first; backends only after the loop demonstrably retains
- **Premature optimization** — spatial hashing the O(n²) separation, pooling FX before profiling demands it

## Risks

1. **Scope creep** (top risk — "most addicting ever" is unfalsifiable): ship when gate metrics pass, not when ideas run out; written content lock at Phase 6; icebox doc for every "wouldn't it be cool"
2. **Crowd performance**: the most shareable feature (massed battles) is the most expensive; mitigated by Phase 2 quality settings, Phase 3 measured optimization + actor cap + potato mode, and a 60fps-on-integrated-GPU budget treated as a feature with regression checks
3. **Burnout** (part-time solo, ~9 months): fixed weekly hours as a hard budget; every phase ends with something public; cut Phase 6 content rather than extend the calendar; off-weeks after Phase 4 and after Next Fest
4. **three.js migration breaking hand-tuned feel**: timeboxed 2-week branch with a behavior checklist, old build live as canary, explicit fallback to shipping on r128
5. **Wishlist shortfall** (<5k at launch = algorithmic invisibility): Steam page months before launch, GIF habit from week 1, browser build as zero-friction top-of-funnel, pre-committed rule to skip an underpowered Next Fest
6. **Untracked code**: one bad AI-assisted refactor could destroy the only copy of working game feel — eliminated on day 1 by Phase 0
7. **Feedback distortion**: Discord regulars stop representing new players; fresh-stranger tests gate every milestone, and anonymous telemetry outranks veteran opinion on difficulty
