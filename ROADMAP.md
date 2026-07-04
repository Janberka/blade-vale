# Blade Vale — Systems Roadmap

**Working title:** Blade Vale · **Ambition:** *the real endless world* — a single persistent world that generates itself into being wherever real people go, played by millions. Free web funnel → Steam → mobile.
**What it is now:** an always-on server simulates a five-nation war on a procedurally generated hex world; players ride it together, command warbands in real-time 3D battles, and every soldier has a name and a career. The strategic bet on top of it: **claim virgin frontier and the world authors itself there**, its generators written by AI, its NPCs living lives of their own.

> **North star (see `VISION.md`):** three pillars — (1) the endless deterministic world, (2) AI-authored *generators* (generative work at authoring time, not runtime), (3) living NPC AI that allies, builds, and wars on its own. The company's core engineering is reconciling all three **at the scale of millions**. Scale is the headline mandate, not a footnote.

This roadmap is organized **by mechanism**, not by week. Each section records where the system stands today, what its known limits are, and the improvement ladder that takes it from "works for ten testers" to "works for millions." Dates matter less than order: the next milestone is always explicit.

---

## Next milestone — M0 (2 months): the endless-world vertical slice

> **Goal:** the demo that proves the whole thesis, running on the internet for a small invite cohort. **A player claims virgin frontier no one has ever visited; the generator loop authors a living region around them — terrain, roads, a town, a faction with a stake — and it persists for everyone.** That slice *is* the pitch for the next raise.

This is the headline milestone now; the mobile LAN work (M1 below) is a supporting track, not the lead. The bones exist — generate-on-first-visit, chunk persistence, versioning — so the slice is mostly *new product surface* (claiming/ownership/naming) plus the first honest pass at the two hard bets.

**Work list:**
- [ ] **Frontier claim + ownership:** a player selects unvisited frontier, the world generates+persists it, and it carries an owner/name that everyone else sees. Sparse delta over the deterministic base (design the edit layer here — see §1).
- [ ] **Generator-authoring loop v0:** formalize even a thin spec for a region generator; author one new generator with human+Claude; gate it through the determinism harness before it ships. This is the first turn of the loop that later goes auto (§2).
- [ ] **Warfare determinism test** (the highest-priority gap — §2) so the living region's war is reproducible.
- [ ] **First interest-management pass** (§2) so the tick survives the demo cohort.
- [ ] **Internet security boundary** (§5): password hashing, HTTPS, rate limits, Litestream backups — the M4 checklist, pulled forward only as far as the invite cohort needs.
- [ ] **NPC legibility v0** (§2/new pillar): one readable decision — a warlord that expands *because* it was boxed in, surfaced in the chronicle.

**Exit criteria:** a stranger with an invite claims frontier, watches a living region come into being and persist, sees at least one NPC make a legible choice, and it's all reproducible from seed. Runs on the public internet, not just your box.

---

## Supporting milestone — M1: Mobile LAN playtest

> **Goal:** testers on the same Wi-Fi open a URL on their phones and play the shared world together, giving feedback the same evening. No app store, no accounts friction beyond sign-in, no cables.

This is the highest-leverage move available: the touch layer already exists, the client already derives the backend from `location.hostname`, and the server already binds all interfaces. What remains is glue, phone-class performance, and a repeatable host procedure.

**Already in place (verified in code):**
- Touch controls: full layer (floating stick, combat/kingdom buttons, drag-look), auto-enabled on touch devices (`TOUCH` detection in `game.js:1505`), `?touch=1` desktop preview.
- Network topology: `client-net.js:8` and `net-battle.js:11` build the API/WS base from `location.hostname:8787` — a phone loading `http://<host-ip>:8099` automatically talks to `http://<host-ip>:8787`. `server/index.js` listens on all interfaces.
- Shared world: distinct `X-Player-Token` per account; presence, armies, co-op relay (`/coop`) all live.

**Work list:**
- [ ] **One-command host script** (`npm run lan` or similar): start the backend, start the static server on `0.0.0.0:8099`, print a QR code / URL with the Mac's LAN IP. Zero-thought session start for the host.
- [ ] **Phone performance tier:** auto-detect mobile → drop shadow map size, cap pixel ratio at ~1.5, halve scatter density, disable street-tier tessellation (rung 2 stays at canonical hexes), reduce fog distance. Target: 30fps sustained on a mid-range Android; 60 on recent iPhones. Add an FPS readout behind `?debug=1`.
- [ ] **iOS Safari audit:** AudioContext unlock on first touch (procedural SFX are silent until a gesture), `viewport-fit=cover` + safe-area insets for the notch, prevent double-tap zoom / pull-to-refresh, `touch-action: none` on the canvas, home-screen PWA manifest so it launches fullscreen.
- [ ] **Touch parity for the new systems:** zoom rungs (P/L) as pinch or on-screen buttons, F-flares and U-drawer reachable from the touch HUD, battle command (order × pace) usable with thumbs — audit every keyboard-only feature added since the touch layer shipped.
- [ ] **Session resilience on phones:** backgrounding a tab kills timers/WS — reconnect cleanly on `visibilitychange`, resume the world snapshot, never lose the character. Test lock-screen → return.
- [ ] **Feedback channel:** an in-game "!" button that posts a note + auto-attached state (position, mode, fps, device) to the server — testers report without leaving the game.
- [ ] **The dry run:** two real phones (one iOS, one Android) + one desktop in the same world, 20 minutes, no host intervention. Fix everything that broke; repeat until boring.

**Exit criteria:** a tester who has never seen the game joins from their phone via QR code, signs in, rides the map, fights one battle with touch controls, and their feedback note arrives server-side. Host setup under 60 seconds.

---

## The mechanisms

### 1. Server-authoritative procedural worldgen

**Where it stands.** Terrain, settlements, and roads are generated by a shared deterministic kernel (`sim/terra.js`) that runs identically on client and server. The server owns the canonical world: chunks are generated on first visit, persisted in SQLite (`server/chunks.js`, `chunk` + `chunk_detail` tables), and served in batches (`/api/v1/chunks`, `/chunks/detail`). The client's local kernel produces byte-identical output, so the server payload is persistence, not a correctness dependency — offline play degrades gracefully. Detail is tiered: strategic pictograms at map zoom, persisted street-level rows (tree stands, boulders, groves) at action zoom. Worldgen versioning (`Terra.VERSION`) is stamped on every stored chunk so a kernel change never silently regenerates someone's saved ground.

**Why this design scales.** Determinism means the server never streams geometry — only compact seed-derived rows — so bandwidth per player is tiny and the client can always fall back to local generation. Generate-on-first-visit means storage grows with *explored* world, not world size.

**Determinism posture (stated plainly).** Byte-identical output is verified *on the same engine*. Float determinism leans on a seeded PRNG + disciplined ordering, **not fixed-point math** — it holds because it's all one engine today, and that fragility is the known seam. **Cross-engine conformance is a deliberate afterthought:** we're deterministic on whatever engines have the players (V8/Blink first) and harden for another engine only when its market share forces it. Support follows popularity, not ideology. The leap the vision asks for is extending determinism from geometry to the *whole stack* — terrain, rules, history, "how a region works" — all reproducible from seed + a versioned algorithm-set.

**Improvement ladder:**
- **Chunk payload budget:** measure real bytes/chunk at each tier; gzip is in place, but add a hard payload-size regression test so a worldgen change can't quietly 10× the wire cost.
- **Kernel migration story:** today a `Terra.VERSION` bump orphans old rows. Define the policy — regenerate lazily per chunk vs. world "seasons" (new version = new world, old worlds read-only archives). Seasons are the industry-proven answer at scale.
- **Server generation cost:** chunk generation is synchronous in the request path. Move to a worker thread + generation queue before any public traffic; pre-warm the ring around each active player.
- **Edit layer on top of determinism:** player/world *changes* to terrain (razed villages, built forts) need a sparse delta table over the deterministic base — design it before any feature needs it, because retrofitting deltas under a deterministic kernel is painful.
- **Long term:** region servers each owning a world-space shard of chunk generation, coordinated by chunk key — the deterministic kernel makes this embarrassingly parallel.

### 2. Living-world simulation (tick, careers, diplomacy, destiny)

**Where it stands.** A bounded time-driven tick (`server/tick.js`) advances the world 24/7 under `launchd`. Inside it: character careers (every soldier named, skill from real fighting, deeds persisted), the diplomacy/intent engine (faction relations, Phase A live), and the destiny engine (per-character fated arcs + a world "age," chronicle-only by design). **The living war (`server/warfare.js`, migration `013`) is now the top layer:** every settlement fields a tier-scaled patrol ecology (`role='patrol'` warlord rows on a home leash), factions rarely *call the banners* into muster→march→siege **campaigns** (`campaigns` table), and armies that meet no longer resolve instantly — they lock into a **timed battle that bleeds over ticks** (`sbattles` table) so a player can watch it on the map or walk up to the lines. The old instant `doClash` is gone; resolution still routes through the shared character-weighted resolver (`sim/world-sim.js`), deterministic per seed. The shared world keeps ticking under live players (they are pure viewers); `/world` is position-scoped (`getArmiesNear` ships nearby patrols + all hosts + anyone in a battle/campaign). "While You Were Away" digests summarize the elapsed war on login.

**Why this design scales.** The sim kernel is pure and shared — the same code that resolves a battle server-side can predict it client-side, which is the foundation for both trust (verifiable outcomes) and latency-hiding (client anticipates, server confirms).

**Improvement ladder:**
- **Tick cost profiling:** instrument per-system tick time (diplomacy, destiny, battles, careers) and per-world row counts. Establish the budget *now*: the tick must stay under N ms at 10× current population or the always-on promise breaks.
- **Interest management (now urgent):** the living war pushed the population past **1,300 warlord rows** (≈180 hosts + ≈1,100 patrols) and the tick touches every one every beat. Move to activity buckets — hosts and anything near a player/enemy tick every beat, distant patrols tick coarsely (every Nth beat with catch-up math). This is the single biggest headroom win and the patrol ecology is what forced it.
- **Diplomacy Phases B–D** (personality-driven intents, war weariness, betrayals) — already planned; each phase must land with its own drift guard (the all-neutral-peace bug of the crowded-map fix is the cautionary tale: a living world that converges to stasis reads as dead).
- **Chronicle as a product surface:** the event log is currently flavor. At scale it becomes the social object — shareable world histories, "this week in your world" digests, famous-character pages. Cheap to build on what exists; enormous retention value.
- **Determinism testing:** byte-identical-per-seed is verified for destiny; extend the same golden-seed regression harness to every tick system so no refactor silently forks the sim. **`warfare.js` has none yet** and mutates the most rows per tick — highest-priority gap. Also fix a real drift hazard: `NATIONS` / `CAP_ANGLE` / `MAP_HALF` are duplicated between `warfare.js` and `tick.js` with "keep in sync" comments — hoist to one shared constant.

### 3. Combat & battle AI

**Where it stands.** The core 30-second loop is the game's strongest asset: pose-snap swordplay, hit-stop, trauma shake, guard breaks, dodge i-frames, poise/heavy/finisher layer, procedural WebAudio SFX (combat-feel Phases 1–2 shipped; Phase 3 telegraphs+parry pending). Enemy AI flanks in packs. The command layer is Orders × Pace (charge/hold/hold-zone/regroup/free × march/rush) issued live mid-fight or from the slowed command deck; squads persist between battles. Battle fighters are pinned to y=0 (terrain relief is backdrop). **Combat is no longer its own mode — it happens on the map.** A player warband locks into the *same* timed map-battle system the AI hosts use (`playerClash` over `mapBattles`): the bar bleeds and you can settle it in person, or `dropIntoClash` turns the two sides into one in-place **field battle where the lines stood** — the road is the arena. Sieges reuse the path via a temporary garrison band (`makeGarrisonBand` / `siegeCapital` / `captureHold`, ownership flips on a storm); sim losses fold back into the real roster (`foldSimBattle`), survivors carry the battle.

**Improvement ladder:**
- **Combat-feel Phase 3** (telegraphs + parry) — finishes the planned arc; readable enemy wind-ups are also the accessibility story.
- **Terrain in battle:** the y=0 pin was the right simplification, but battles fought on the actual streets/walls the street tier now renders is the obvious next fidelity jump — start with *flat but furnished* arenas (real buildings as obstacles) before attempting slopes.
- **AI officer layer:** enemy hosts currently fight as one mass with pack behavior. Give enemy armies the *same* Orders × Pace system the player has, driven by a simple commander policy (hold chokepoints, commit reserves, retreat when broken) — symmetric systems are cheaper to maintain and make enemy behavior legible.
- **Determinism & replay:** route all battle randomness through the seeded PRNG; a battle then becomes a (seed, orders-timeline) tuple — replays, spectating, and server-side verification of co-op outcomes all fall out of this one refactor.
- **Scale ceiling:** profile the actor cap honestly on phone-class hardware (M1 work); instanced crowd rendering + LOD'd fighter logic (distant soldiers run cheap steering, not full combat) buys the "avalanche" sieges the crusade system promises.

### 4. Multiplayer & networking

**Where it stands.** Shared worlds: every account has a token, presence and armies render on the common map, ambient swarm keeps the map alive. Real-time co-op (J): host-authoritative WebSocket relay (`server/ws.js`, `/coop`), guests hand their warband to the host's arena and watch snapshots; verified headlessly, needs real two-device testing (M1 delivers exactly this). Map-level war (marches, clashes, reinforcement) is server-resolved in shared worlds.

**Improvement ladder:**
- **M1 is the real test** — two phones + a desktop in one world is the first honest multi-device shakeout of presence, co-op, and reconnect.
- **Guest agency in co-op:** v1 guests spectate their handed-over troops. Next: direct guest-avatar control (sword in hand in the host's arena) — snapshot codec exists, needs input forwarding + client prediction for the guest's own body only (everything else stays host-authoritative).
- **Protocol discipline:** define versioned message schemas for `/coop` and the REST surface now, while the client count is one. Every future client (mobile wrapper, bot, Steam build) holds the protocol stable.
- **Anti-cheat posture:** host-authoritative co-op means a malicious host owns the battle. Acceptable for friends-on-LAN; before open matchmaking, the deterministic-battle work in §3 enables server-side outcome verification (replay the seed+orders, compare results) — vastly cheaper than running battles server-side.
- **Scale ladder:** single relay → rooms pinned to worker processes → regional relay fleet. The relay is dependency-free and stateless-ish by design; keep it that way. Presence/map state at large N needs interest management (only stream what's near each player's view) — same principle as the tick, same win.

### 5. Accounts, identity & persistence

**Where it stands.** Username/password sessions ride `X-Player-Token`; multiple characters per account per map; the U drawer switches/splits/gives between them with multi-select bulk orders; merge preserves careers via `member_of`. SQLite via better-sqlite3, migrations numbered (011 as of today). Client has offline fallback for everything.

**Improvement ladder:**
- **Password security audit before any non-LAN exposure:** hashing (argon2/scrypt), rate limiting, session expiry/rotation, HTTPS. LAN testers don't need it; the first internet-reachable deployment absolutely does — do it *at* that boundary, not after.
- **Account recovery & abuse surface:** email-optional recovery codes; per-account request quotas (the validation caps exist — formalize them per endpoint).
- **SQLite's honest ceiling:** better-sqlite3 on one box serves thousands of concurrent players fine (reads dominate, writes are tick-batched). The scale plan is *not* "switch to Postgres day one" — it's (a) Litestream/WAL backup replication immediately (a dead disk must not kill a world), (b) world sharding (one SQLite file per world — already nearly true structurally), (c) Postgres only when a single world outgrows a box.
- **GDPR/deletion path:** named persistent characters mean personal data. Account-delete that scrubs or anonymizes (character becomes an NPC with a generated name — fits the fiction perfectly) — design this early, it's cheap now and mandatory later.
- **Save export codes** (base64 of versioned state) remain the cross-platform migration story from the original plan — still right.

### 6. Rendering, LOD & performance

**Where it stands.** Zero-asset procedural everything (the strategic edge: ~2MB, instant load, free variants). Hex-prism terrain on a global lattice; detail tiers by zoom rung (chart → miniature → street level) with budgeted, distance-aware re-tessellation so rung changes never hitch; vista system ties fog/camera to explored miles; roads painted into terrain via canvas splats (no ribbon meshes); settlements generated from the landform; instanced scatter with server-persisted street rows. three.js r128 vendored.

**Improvement ladder:**
- **Phone tier (M1):** the quality-toggle work lands here first — pixel-ratio cap, shadow budget, scatter density, tessellation lock. Make the tier system explicit (`QUALITY.low/med/high`) rather than scattered constants.
- **Frame budget instrumentation:** a permanent lightweight profiler (per-system ms: terrain, scatter, fighters, CA overlay, UI) behind `?debug=1` — every performance conversation should start from its numbers, not vibes.
- **Draw-call discipline at street tier:** street settlements rebuild per-hold; audit material/geometry sharing across holds (one material per palette globally, geometry caches already exist — verify nothing per-instance slipped in).
- **The r128 question, re-answered:** still no engine upgrade before the loop is proven — but the *reason* has shifted from "no player payoff" to "phone WebGL2 support is what matters, and r128 handles it." Revisit only if a phone-class rendering feature (e.g. proper instanced color on old iOS GPUs) forces it.
- **Long term:** WebGPU is icebox; the zero-asset pipeline means a renderer swap touches materials/instancing only, which is the payoff of never adopting glTF.

### 7. Overworld structure: roads, settlements, territory

**Where it stands.** Hierarchical road network (Gabriel trunks, branches, streets, gated walls — a road crosses a wall only at a gate), hex-A* routing, click-to-march ETA, armies travel by road. Terrain-aware settlements (contour-marched curtain walls fit the hills). Territory as a breathing cellular-automaton influence field drawn as hex caps. Starting-station system deals a scaled opening scenario.

**Improvement ladder:**
- **Settlements as gameplay, not scenery:** the street tier renders real towns — the next systems (garrisons you walk through, recruitment inside walls, markets, siege objectives tied to actual gates) should consume the geometry that now exists. Every settlement feature from here on should work *at street level first*.
- **Territory consequences:** the CA border is visual; wire it to the sim (tax/recruit pools by held hexes, supply attrition outside friendly territory) so the map's breathing matters.
- **Road economy:** roads already shape travel; let them shape the *war* — supply lines that can be cut, patrol routes that matter, richer settlements on trunk roads. All reads of existing data, no new generators.

### 8. Game feel, audio & onboarding

**Where it stands.** Procedural WebAudio SFX layer shipped (FEEL/AUDIO/SFX systems); combat juice pass 1–2 done. No music yet. Onboarding is the starting-station drop-in; no tutorialization of the deeper systems (command layer, map war, diplomacy).

**Improvement ladder:**
- Contextual just-in-time prompts (from the original plan — still exactly right) extended to the *map* verbs: first pact, first call-to-arms, first zoom rung change.
- Procedural or CC0 music with an intensity layer; provenance recorded (Steam AI-disclosure requirement stands).
- The retention mechanics from the original plan (best-score memory, near-miss framing, death recap) remain valid and mostly unbuilt — they move to the milestone ladder below rather than being lost.

### 9. AI-authored generators (the generative pillar)

**Where it stands.** The "generative layer" is **at authoring time, not runtime** — a deliberate architecture choice that dissolves the usual generative-content cost/latency/consistency problems. There is no LLM in the runtime content path: the world is produced by deterministic *algorithms*, so runtime is cheap and every region stays consistent forever. Today those algorithms are authored by a human pairing with Claude — the whole procedural stack (`sim/terra.js`, `sim/settle.js`, `server/roads.js`, `server/warfare.js`) is code written that way. The "AI cost" is a subscription and hours.

**Why this design scales.** Moving generative work to authoring time means: zero per-visit inference bill, no latency in the play path, and no "the world contradicts its own history" failure — the moat that runtime-LLM worlds can't have. The output is versioned, deterministic code shipped as tiny seeds.

**Improvement ladder:**
- **Formal generator spec:** today authoring is conversational. Define a spec/DSL a generator is authored *from* — the precondition for automating it.
- **Author-and-gate loop:** LLM proposes a generator → runs through the determinism harness (§1) *and* a quality/"is it fun" eval → best candidates promote into the library. Human-in-the-loop first.
- **Quality is not determinism:** deterministic ≠ good. Build the eval harness (playtest telemetry + heuristics) that lets "fun" gate a promotion, so full-auto authorship is safe.
- **Purpose-built model (long term):** a model trained specifically to author generation-algorithms, from our own generator corpus + which authored regions players actually engage with. Closing the loop is the endgame; the harness is what makes it safe.
- **Anti-sameness:** diversity comes from a *library* of authored generators, not one tuned noise function — the whole point of automating authorship.

### 10. Living NPC AI (the world moves without you)

**Where it stands.** The scaffolding runs 24/7 — a five-nation war (`server/warfare.js`), a diplomacy engine (`server/diplomacy.js`, faction relations), settlements generated from the landform, armies that muster→march→siege. But the intelligence is **rule-based, not agentic**: it's a simulation, not a mind. NPC decisions are scripted and not yet *legible* — a player can't read *why* a warlord moved.

**Why it matters.** "Living world" is a slogan until NPCs visibly **form and break alliances, found cities, build roads out to them, raise armies, and fight wars on their own**. A world that keeps building and warring while everyone sleeps is the entire retention and "aliveness" promise.

**Improvement ladder:**
- **Legibility first:** surface the *reason* behind existing rule-based decisions in the chronicle (boxed-in → expand; third power rises → two rivals ally). Cheap, high-value, and the honest first step.
- **Goal-driven agents:** replace scripts with agents that hold goals and make readable trade-offs. Same philosophy as the generators — deterministic, persistent, consistent behavior whose choices become permanent world history.
- **Cost model of the leap:** decide the mechanism deliberately — rules vs. planner vs. LLM-per-NPC — at the scale of thousands of NPCs. This is a headline CTO design question, not a detail.
- **Determinism + chronicle:** route agent decisions through the seeded resolver so NPC history is reproducible and replayable, and feeds the chronicle as a social object (§2).

---

## Milestone ladder after M0/M1

Order, not dates. Each milestone ends with something a stranger can play and a written verdict on its exit metric.

1. **M1 — Mobile LAN playtest** (above). *Exit: phones in the living room, feedback flowing.*
2. **M2 — Feedback → feel:** burn down the top 10 tester findings; combat-feel Phase 3 (telegraphs + parry); touch-control iteration from real thumbs. *Exit: the same testers voluntarily return.*
3. **M3 — Retention loop:** persistence of progress across sessions surfaced properly (best runs, career milestones, chronicle digest), death/defeat recap with near-miss framing, instant retry. Telemetry pipe (event schema from the original plan) — decisions from data, not Discord. *Exit: measured D1 return on the tester cohort.*
4. **M4 — Internet-reachable alpha:** the §5 security boundary work (hashing, HTTPS, rate limits, backups via Litestream), deploy on a VPS, invite-code gate. *Exit: 50 remote accounts, zero data loss, tick under budget.*
5. **M5 — The public funnel:** itch/CrazyGames build with graceful offline degradation; the persistent shared world becomes the platform delta (this replaces the original paid-delta split — the living world is the thing you can't get from a copy of the client). *Exit: engaged retry >45%, runs/session ≥3.*
6. **M6 — Steam:** page + wishlist clock, Next Fest anchoring, desktop wrapper spike (Electron + steamworks.js as the proven path), $4.99 with the always-on world + cloud characters as the paid pillar. The original plan's fest discipline (pre-committed skip rule at <2k wishlists) stands unchanged.
7. **M7 — Mobile stores:** the M1 touch layer + performance tier graduate to Capacitor wrappers once the loop is proven on web. LAN testing (M1) is deliberately the cheap rehearsal for this.

## Metrics

Unchanged in spirit from the original: decisions follow stranger telemetry, segmented by source, measured on the engaged cohort. The gate table (retry >40/45/50%, runs/session ≥3, median session ≥8–10 min, no wave-cliff, 60fps on integrated GPU) now applies per-milestone rather than per-phase, plus two new ones:

| New metric | Gate |
|---|---|
| Tick time at 10× population (synthetic) | < 250ms sustained |
| Phone FPS (mid-range Android, action mode) | ≥ 30 sustained |
| Co-op battle desync reports | zero tolerated — every one root-caused |
| Time from `git clone` to hosted LAN session | < 5 min |

## We Will NOT Do

Unchanged and still binding — with one line formally retired:

- **Energy systems, timers, streaks, escalate-and-reset rewards** — the daily rhythm is an invitation, never a punishment.
- **Pay-to-win, paid stat boosts, loot boxes** — one purchasable +10% invalidates every career and leaderboard.
- **Ads inside the core loop; no revive-for-ad** — death must matter.
- **Hidden rubber-banding** — outcomes stay legible (the destiny engine is chronicle-only for exactly this reason).
- **Power-gating core verbs** — dodge, block, combos, command are in session #1 forever.
- **Fake social proof, nag-share, notification spam.**
- **Asset pipeline / glTF** — zero-asset procedural generation is the strategic edge.
- **Replacing pose-snap animation with skeletal blends** — the snap IS the signature.
- **Premature optimization** — the profiler (§6) decides, not intuition.
- ~~No multiplayer/servers before traction~~ — **retired 2026-06-28 by owner direction**; the living-world server is now a core pillar, and this roadmap is built around it.

## Risks (updated)

1. **Scope breadth** — eight live mechanisms is a lot for a solo dev. Mitigation: the milestone ladder forces convergence; each mechanism's improvement ladder is *ordered*, and only the top item of each is ever in flight.
2. **The tick outgrows the box** — mitigated by interest management (§2) and the profiling gate; measured before it's felt.
3. **Phone performance sinks M1** — mitigated by the explicit quality-tier work; if a mid-range Android can't hold 30fps in action mode, street tier stays desktop-only and the milestone still ships.
4. **Security debt at the M4 boundary** — the LAN phase is deliberately security-light; the M4 checklist is the wall, and nothing internet-facing ships before it.
5. **Host-authoritative trust** — fine for friends, wrong for strangers; deterministic-battle verification (§3/§4) is the planned answer, not server-side battle simulation.
6. **Solo-dev burnout** — unchanged: hard weekly hour budget, every milestone ends public, cut content not gates.

---

## Appendix — historical addenda

The three dated addenda (Persistent NPC Careers & Living-World Server, 2026-06-28 · Allied Co-op & Crusades, 2026-06-29 · Global Destiny Engine, 2026-06-29) that previously lived at the bottom of this file are now folded into §2–§4 above. Their full text survives in git history (`git log --follow ROADMAP.md`) and their implementation detail lives in `BATTLE_CONTROLS.md`, `server/README.md`, and the plan files under `~/.claude/plans/`.
