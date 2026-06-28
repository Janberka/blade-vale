# Blade Vale — Release Roadmap

**Working title:** Blade Vale · **Target:** free web funnel → $4.99 Steam release
**Budget assumption:** ~12–15 focused hours/week, solo dev with AI assistance. At that pace, 1.0 lands in **~10–12 months**; at 8–10 h/week it's 12–14 months. When behind: stretch phases, cut content — never skip gates.

---

## Vision: Why This Will Be Addictive

Blade Vale already has the hardest thing to build: a great thirty-second experience — hit-stop, trauma shake, pose-snap swordplay, guard breaks, dodge i-frames, wolf-pack AI that genuinely flanks, and a warband that fights beside you. What it lacks is everything that turns thirty seconds into thirty hours: **memory** (a best score to beat), **variance** (a reason run #5 differs from run #1), **arc** (bosses and a winnable climax), and **stakes** (a multiplier to protect, allies who can fall).

The thesis: **don't add more combat — wrap the existing combat** in persistence, between-wave drafts, bosses, and a daily seed; deliver it through a zero-friction browser funnel (sub-2MB, zero assets, loads in seconds); convert the funnel into a Steam release. "Addictive" is defined by gate metrics (retry rate, runs/session, session length), not vibes — and **never by dark patterns** (see *We Will NOT Do*).

Positioning line for every store page: **"Lead your warband. Hold the line. One more wave."**

---

## Phase 0 — Safety Net (week 1, ~2 days of work)

**Goal:** the game can't be lost and runs offline. **Exit:** repo pushed; plays with network unplugged; a stranger can play via URL.

- [ ] `git init` + first commit + push to a **private GitHub remote** — *before any other edit* (one bad refactor of an untracked `game.js` destroys the only copy of hand-tuned feel)
- [ ] Vendor three.js r128 locally — kill the CDN dependency, keep the version
- [ ] 2-line fix: `blur` listener clears the `keys{}` object (stuck-key bug = future #1 report)
- [ ] `window.onerror` → on-screen overlay now, telemetry pipe in Phase 1
- [ ] Upload as-is to an **unlisted itch.io page** (skip GitHub Pages — unavailable on free private repos; itch is enough, Cloudflare Pages if a second mirror is wanted)
- [ ] Claim the name: itch page draft + social handles; post the first raw combat GIF
- [ ] Write down the weekly hours budget and treat it as hard

## Phase 1 — Shippable Skeleton (weeks 2–4)

**Goal:** persistence + pause + observability. **Exit:** a stranger plays 3+ runs unprompted; **best score survives a reload inside the itch.io iframe in Safari**; telemetry shows their death wave.

- [ ] **Telemetry first** (load-bearing for every later gate): PostHog free tier *or* a 20-line Cloudflare Worker → KV. Fixed event schema before integrating: `run_start, wave_reached, death(wave,cause), retry, block, dodge, settings_open`. Route `window.onerror` into the same pipe. **Verify events fire from inside the itch iframe** (ad-blockers/CSP eat third-party analytics — measure the loss). *Not GoatCounter — pageview counters can't measure retry rate or session funnels.*
- [ ] **Persistence as a storage facade** from day one: versioned schema behind one interface, localStorage backend now — CrazyGames SDK data module and Steam Cloud slot in later without rewrites (itch/portal iframes partition or evict localStorage; plan for it, don't discover it)
- [ ] Best score + best wave persisted; **death recap with near-miss framing**: "NEW BEST!" (gold banner + shake) or "Only 800 short of your best" — the cheapest, strongest retention mechanic in this plan
- [ ] Death screen run stats (wave, kills, best combo) + one-key instant retry — restart speed is sacred
- [ ] Esc pause + auto-pause on `visibilitychange` — bolted onto the existing flags; the full state-machine refactor waits for the Phase 3 tech window
- [ ] Keyboard attack alternative (mouse-only attack locks out keyboard players)
- [ ] Recruit 5–10 strangers (playtest Discords, r/playmygame); watch 2 over screen share

## Phase 2 — Sound and the First Minute (weeks 5–8)

**Goal:** a 10-minute run feels finished; nobody quits confused. **Exit:** engaged retry rate >40%; 3 fresh testers learn block/dodge/combo unprompted and retry after dying.

- [ ] **Procedural WebAudio SFX** (~100-line oscillator/noise helper, zero assets, zero licensing): swing whoosh per combo step, steel clang on block, guard-break crunch, kill thump **pitch-shifted by combo count**, low-HP heartbeat, wave horn. Hook points already exist (`damageEnemy`/`killEnemy`/`damagePlayer`/block branch/`showWaveBanner`). AudioContext init on the start click
- [ ] One combat loop with an intensity layer tied to wave/HP — **verifiably CC0, commissioned (~$50–200), or procedural**; record provenance now (Steam's AI-content disclosure is mandatory and this plan uses AI assistance — disclose honestly, late discovery is a review-bomb)
- [ ] Settings overlay off the pause menu, persisted: volumes, screen-shake/vignette intensity, quality toggle (shadow size, pixel ratio, torch count), colorblind-safe faction cues (shape/outline, not just red-vs-green)
- [ ] Contextual onboarding, no tutorial level: wave 1 shrinks to 3 grunts; just-in-time one-time prompts ("Hold SHIFT — block!" on first enemy windup, "SPACE — dodge!" on first flank)
- [ ] **Banked score multiplier**: grows on kills-without-being-hit, big HUD element that visibly shatters on damage; blocks preserve it, guard break halves it (~80 lines that convert existing combat into continuous tension)
- [ ] Difficulty pass on waves 1–10 from the Phase 1 wave-at-death histogram (waves 1–3 winnable by a first-timer)

## Phase 3 — Tech Window + Soft Beta (weeks 9–13)

**Goal:** codebase ready to grow 3×; performance proven **before** traffic; soft-public. **Exit:** 100+ tracked plays; engaged retry >45%; 60fps with 45 actors on an integrated-GPU laptop.

- [ ] **Tech window, timeboxed 1 week, own branch:** Vite + npm, split `game.js` into ES modules along its existing section comments, unify `damageEnemy`/`damageAlly` into one combatant path. **No three.js engine upgrade pre-1.0** — r128 vendored locally is a safe runtime; a ~30-major-version jump relights every hand-tuned material for zero player payoff. Icebox it.
- [ ] **Desktop-wrapper spike (2–3 days, months before it can hurt):** stand up Tauri+steamworks-rs *and* Electron+steamworks.js skeletons; verify **Steam overlay, achievements, controller input on Windows**; pick the winner (Electron is the proven path — Vampire Survivors shipped on it; binary size is irrelevant for a $4.99 game)
- [ ] Crowd performance pass against measured wave-10 numbers: shared materials per palette, shadow-caster budget, live actor cap, pooled sparks/popups *if profiling demands*, FPS counter, potato mode
- [ ] WebGL **context-loss handler**: `webglcontextlost/restored` → save score, "Graphics reset — click to reload" overlay; log occurrences to telemetry (integrated GPUs + long sessions = real resets; `onerror` won't catch them)
- [ ] First boss: scaled brute at wave 5 with a boss bar and one new move from the existing MOVES table
- [ ] itch page **public** + web presentation (favicon, OpenGraph unfurls, loading state, fullscreen toggle); feedback link; low-touch Discord
- [ ] **Soft channels only**: r/playmygame, playtest servers. **Do NOT spend Show HN / r/WebGames yet** — one-shot channels wait for the proven loop (Phase 4 exit)
- [ ] Allies keep respawning for now — permadeath lands *with* its counterplay in Phase 4

## Phase 4 — The Addiction Loop (weeks 14–20, then one full week off)

**Goal:** variance, arc, stakes, meta. **Exit (engaged cohort = finished wave 1, segmented by source):** retry >50%; runs/session ≥3; engaged median session ≥8–10 min; testers unprompted ask when the full version ships.

- [ ] **Between-wave draft**: pick 1 of 3 boons — 15–20 upgrades tweaking existing constants (HP, speed, stamina costs, combo window, lifesteal, dodge i-frames, ally buffs), rarity tiers. The dead 3-second timer becomes the most anticipated moment of the run
- [ ] **Run arc**: boss every 5 waves, milestone banners, **victory at wave 15**, endless mode after; difficulty steepens past 10
- [ ] **Wave mutators + elite affixes** ("BERSERK — 30% faster, 2× score"; shielded/frenzied tints): N enemies × M affixes is the honest content multiplier
- [ ] **Mortal, named allies + the tools to care**: permadeath, names on bars, "Warband 3/4" HUD, surviving names on the recap — shipped *together with* draft options that touch it ("Recruit: a new ally joins", "Field medic: revive at half HP"). Loss only works when the player had a say
- [ ] **Daily challenge**: seeded PRNG (mulberry32; route `Math.random` call sites through it), date-seeded run, one rotating modifier, Wordle-style share string ("Blade Vale #142 — Wave 9 — 24,350") on the death screen
- [ ] **Meta progression v1**: Valor earned every run (even wave-2 deaths pay out), unlock board — weapon variants (greatsword/daggers as stat+geometry tweaks), ally types, starting boons. *Options and variety, never baseline power*
- [ ] Local top-10 run history; juice pass 2 (kill-streak slow-mo, shatter deaths, score tally count-up)
- [ ] Weekly playtest; fix the top rage-quit point (death with no retry) every week
- [ ] **Phase-exit marketing beat — the big one, now that the loop is real:** Show HN, r/WebGames, and the "procedural low-poly rigs in one JS file" devlog, all pointing at the daily-seed build

## Phase 5 — CrazyGames + Steam Page (weeks 21–26)

**Goal:** first revenue channel live; wishlist clock starts. **Exit:** live on CrazyGames; Steam page public with trailer; demo submitted; web funnel intact.

- [ ] **Write the paid-delta decision before the Steam page exists** (or launch reviews write "it's free in your browser" for you): web/portal builds = waves 1–10 + daily seed (the funnel and viral loop); **Steam 1.0 exclusively** = endless mode, bosses past the first, full unlock board, leaderboards, offline play, achievements, cloud saves
- [ ] **Steam page in week 1 of this phase** — wishlists compound: $100 Steam Direct, capsule art, 5 screenshots, 45-second GIF-paced trailer; **complete the AI-content disclosure honestly** (AI-assisted code/localization, music provenance)
- [ ] CrazyGames submission: SDK integration (ad breaks **only** at wave/death boundaries via the pause system — never mid-combat, never revive-for-ad), **SDK data module as the save backend** (fixes iframe-storage eviction), self-hosted bundle, store assets. CrazyGames is the lead portal: desktop-keyboard accepted, ~60/70% revshare, no exclusivity. Poki waits for touch controls post-1.0 (its web-exclusivity preference conflicts anyway)
- [ ] Desktop wrapper build-out on the Phase 3 spike winner: achievements, cloud save of unlocks/highscores
- [ ] Controller support + key rebinding + settings completion (Steam reviews punish missing options)
- [ ] **Save export/import code** (base64 of the versioned schema) in settings — doubles as itch→CrazyGames→Steam progress migration
- [ ] Demo build = waves 1–10 + boss, ending on a wishlist CTA; same CTA on the itch death screen
- [ ] One email to Armor Games — accept whatever sponsorship it yields, block nothing on it

## Phase 6 — Next Fest + 1.0 (anchored to fest dates, ~weeks 27–40)

**Goal:** ride one Next Fest well, then ship. **Exit:** fest completed with measurable wishlist bump; 1.0 live on Steam ($4.99, 10% launch discount) + itch; week-1 hotfix shipped; public post-launch roadmap.

- [ ] **Anchor to real dates now**: Next Fests run ~Feb / June / Oct with registration deadlines weeks earlier and a 2-week minimum page age + Valve review (2–5 business days) before. Back-schedule from the chosen fest. **Pre-committed decision date:** if <2k wishlists at the registration deadline, skip to the next fest and spend the slack on content polish — you get one fest per game; never enter underpowered, never float the fest
- [ ] **1.0 content lock — sized to what this calendar actually funds**: 2 arena looks (palette/prop/lighting variants of the existing arena), 2 weapons/stances, 5 enemy types (3 base + shielded + ranged harasser, multiplied by the affix system), 2 bosses, endless + daily seed. Everything else: icebox, one-in-one-out
- [ ] Accessibility completion: reduce-motion, photosensitivity-safe vignette, remappable everything
- [ ] UI localization to FR/DE/PT-BR/zh-CN (AI-assisted, disclosed)
- [ ] Fest week: looped broadcast on the page, daily GIFs, reply to every demo comment; one post-fest week to act on the top 3 findings, nothing more
- [ ] Launch: balance freeze 2 weeks out, Discord bug bash, min-spec certification (integrated GPU), press kit + emails to ~20 Vampire-Survivors-likes YouTubers 2 weeks out, day-1 Reddit/itch/Discord posts
- [ ] Reserve the full week after launch for hotfixes — zero planned work
- [ ] Global daily leaderboard (Cloudflare Worker + KV, plausibility-cap anti-cheat) ships **post-launch** once traffic exists — an empty leaderboard is anti-retention

---

## Distribution: a funnel, not a launch

1. **itch.io** (P0 unlisted → P3 public) — validation, not revenue: a few hundred plays, 4.0+ rating, proof the loop retains
2. **CrazyGames** (P5) — lead commercial portal (~30M MAU; their algorithm pays for exactly the D1/D7 retention Phase 4 builds). Mid-tier = 50k–500k plays, hundreds/month; a category hit = millions of plays
3. **Steam** (P6) — the real-money test: $4.99 wrapped build with real paid delta. Good = 500–2,000 copies; breakout is streamer-driven. Wishlist drivers in order: **Next Fest demo, the GIF habit, the web funnel** (portal players convert to Steam poorly — treat those wishlists as bonus)
4. **Armor Games** — one email, modest license fee, zero engineering
5. **Poki, mobile stores — strictly post-1.0**, only if metrics justify building touch controls
6. **Marketing cadence (budgeted, ~2–3 h/week from the same hour budget):** one *good* GIF per week (flank kills, guard breaks, warband charges), batch-captured monthly, cross-posted; devlog at P2 exit; the daily-seed share string is the built-in viral channel; Discord stays low-touch until P5

## Metrics (decisions follow stranger telemetry, not Discord veterans)

Segment every metric by source (itch embed / direct / portal). Gates are measured on the **engaged cohort** — players who finish wave 1 — so portal drive-by bounce doesn't poison the numbers.

| Metric (engaged cohort) | P2 gate | P3 gate | P4 gate |
|---|---|---|---|
| Retry rate (death → new run) | >40% | >45% | >50% |
| Runs per session | — | 2+ | ≥3 |
| Median session | — | >6 min | ≥8–10 min |
| Wave-at-death histogram | tunes 1–10 | no cliff < wave 3 | smooth to 15 |
| Rage-quits (death, no retry) | identified | top one fixed weekly | trending down |
| FPS @ 45 actors, integrated GPU | measured | 60fps locked | regression-checked |
| D1 return rate | — | — | tracked once CrazyGames is live |
| Steam wishlists | — | — | 2k at fest registration = go |

Every phase gate also requires watching 2–3 fresh first-timers play.

## We Will NOT Do

- **Energy systems, real-time timers, recharging lives, login streaks, escalate-and-reset rewards** — the appeal is "one more run RIGHT NOW"; the daily seed is an invitation, never a punishment for absence
- **Pay-to-win, paid stat boosts, loot boxes** — one purchasable +10% invalidates every "NEW BEST" and every leaderboard
- **Ads inside the core loop** — boundaries only on portals; no revive-for-ad (death must matter); Steam/itch ad-free
- **Hidden rubber-banding / pity-loss difficulty** — deaths must be legible and the player's fault or near-miss framing collapses
- **Power-gating core verbs** — dodge, block, combos are in run #1 forever; unlocks add options, never baseline fun
- **Fake social proof, nag-share dialogs, notification spam** — one clean share button that never interrupts the restart flow
- **Asset pipeline / glTF** — zero-asset procedural characters are the strategic edge (tiny payload, instant load, free variants)
- **Replacing pose-snap animation with skeletal blends** — the snappy guard-to-guard transitions ARE the signature feel
- **Pre-1.0 three.js engine upgrade, ECS/TypeScript rewrites, WebGPU, multiplayer, servers before traction**
- **Premature optimization** — pool/spatial-hash only when profiling demands it

## Risks

1. **Scope creep** ("most addicting ever" is unfalsifiable): ship when gates pass; written content lock at P6; icebox everything else
2. **Crowd performance** (the most shareable feature is the most expensive): quality settings P2, measured optimization + caps + potato mode P3, 60fps-on-integrated treated as a feature with regression checks
3. **Burnout**: hard weekly hour budget *including* marketing hours; every phase ends with something public; cut P6 content rather than extend; off-weeks after P4 and after the fest
4. **Web→Steam cannibalization**: solved structurally by the paid-delta split in P5 — decided before the page exists
5. **Wishlist shortfall**: page up months early, GIF habit from week 1, pre-committed fest skip rule
6. **Wrapper tech bet**: Steam overlay over OS webviews is notoriously flaky — de-risked by the P3 spike, months before it can sink the fest
7. **Save integrity in iframes**: storage facade + portal SDK backend + export codes — best scores must never silently vanish on the platforms where validation happens
8. **Feedback distortion**: regulars stop representing new players; fresh-stranger tests gate every phase and anonymous telemetry outranks veteran opinion

## Icebox (post-1.0, in rough order)

Modern three.js migration · Poki + touch controls · global leaderboards at scale · mobile wrappers (Capacitor) · new biomes/weapons beyond the lock · ascension difficulty tiers · localization beyond the first four · community features

---

## Addendum — Persistent NPC Careers & Living-World Server (added 2026-06-28)

> **This section deliberately overrides the "We Will NOT Do: multiplayer, servers before traction" line above**, on the owner's explicit direction. It records a new pillar that turns Blade Vale from a tight arena game into a Mount & Blade–like persistent war-RPG. Treat it as intended scope, not creep to be cut.

**What it is:** every soldier — even a rank-and-file swordsman — has a **unique name** and a **career** that grows from *actual* fighting (skill → stronger hits, hardier guard), from the group/nation they serve, and from the wars they march in (renown, rank). Kills and leadership are recorded. **Battles the player never attends are simulated from the characters who fight them** (character-weighted resolution), and a **Node + SQLite backend** runs an **always-on living world** that keeps warring while the player is offline. The player character uses the same system. Multiplayer-forward (per-token accounts/worlds), single-player today.

**Status (built & preview-verified): Steps 1–5 done.**
1. Client named-career layer (names, skill-from-combat, kill attribution, charsheet on **V**).
2. Shared `sim/world-sim.js` resolver + character-weighted off-map clashes with named warlords.
3. Node + better-sqlite3 backend (`server/`); careers + deeds persisted server-side; `client-net.js` with offline fallback.
4. Always-on world tick (time-driven, bounded); "While You Were Away" digest on login; capital ownership mirrored.
5. Per-token auth seam, server-side validation caps, `launchd` 24/7 agent, docs.

**Run:** `npm install && npm run server` (:8787). See `server/README.md`. Detailed design + per-step verification: `~/.claude/plans/i-want-to-bring-golden-grove.md`.

**Deferred (future):** full client-map-as-pure-view (snapshot + dead-reckoning + WS) reconciliation; real multiplayer auth + shared worlds. The headline ("a living world that evolves while you're away") is delivered; these are correctness/scale refinements.

**Roadmap interaction:** this changes the distribution math (a backend is no longer "post-traction"). The free web funnel can still ship the client with graceful offline degradation; the persistent world + cross-device saves become the Steam/CrazyGames delta. Revisit Phase 5's paid-delta split with this in mind.
