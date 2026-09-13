# Blade Vale — Systems Roadmap

**Working title:** Blade Vale · **Product now:** *Arena Fights* — a team sword-and-bow brawl in a Colosseum, phone-first, friends in the same pit, a career that follows you. **Product later:** the endless world, grown out of the arena's gates. Free web funnel → app stores / Steam.

> **North star (see `VISION.md`, rewritten 2026-09-12):** get attention with the arena, then expand it into the open world. The world systems below are **parked, not deleted** — they still run, they are hidden from the title screen (`?world` shows "Enter the Vale" again), and nothing in them is worked on until the arena has an audience.

This roadmap is organized **by mechanism**, not by week. Each section records where the system stands today, what its known limits are, and the improvement ladder. Dates matter less than order: the next milestone is always explicit. The arena mechanisms come first; the parked world mechanisms keep their full text at the bottom so nothing is lost.

---

## Next milestone — M0 (4 weeks): the arena a stranger can play

> **Goal:** a stranger opens a link on their phone and is fighting in the pit within thirty seconds, understands why they died, plays again, and can bring a friend in. Their fighter's career survives to the next day. **This is the demo, the trailer and the beta, all in one.**

Almost everything in the pit exists. M0 is the *product layer* around it — the first session, the phone, the return visit — and stabilising the large uncommitted passes (real meshes, Colosseum, terrain, entrance film, horse weight, archers) into a build we can hand out.

**Work list:**
- [x] **Title screen = the arena.** The open world is hidden behind `?world` / `localStorage bv-world=1`; the start overlay sells the pit; sign-in is optional for solo fights and required only to invite, keep a career and buy gear. *(shipped 2026-09-12)*
- [ ] **Commit the working tree in coherent pieces** (real-mesh fighters + `assets/`, Colosseum + ruins pack, terrain, horse weight, archer line) so regressions are bisectable. Resolve the licence question on `Ancient_Ruins.usdz` before any public build (the illustros Sketchfab figures are Standard-licensed and fine).
- [ ] **Quick Fight.** One button on the title screen: a sensible default (2 teams × 4, wide pit, mixed foes) straight into the entrance film. The full lobby stays one tap away. A new player must never see nine rows of knobs first.
- [ ] **The first five minutes.** A results screen that names the star, shows the purse and the next rank, and offers Rematch / Change teams / Marketplace. Just-in-time prompts for hold-to-load, block, roll and swap the first time each matters. Death recap: who killed you and with what.
- [ ] **Phone tier.** Explicit `QUALITY` tiers (pixel-ratio cap, shadow size, crowd density, rig LOD via the `lo.gltf` rank meshes below a body count) auto-picked on mobile; an FPS readout behind `?debug=1`; target 30 fps sustained on a mid-range Android at 4v4 in the Colosseum. The lobby laid out for a phone held sideways — it has never been tested on a real device.
- [ ] **Careers persisted end to end.** Results already pay out; make the return visit worth it — the career sheet on the title screen, "since you were away" (rank changes, trophies), and the marketplace reachable before a fight, not only from the lobby.
- [ ] **Two-phone shakeout.** The invite → accept → fight → rematch loop between two real phones on the internet (not LAN), with backgrounding and app switches mid-fight. The relay reconnect and acked `go` exist; this is the honest test.
- [ ] **Internet boundary, arena-sized.** Password hashing, HTTPS, rate limits on `/arena/result` and the relay, Litestream backups of the play DB. Only what a public beta needs.
- [ ] **A clip.** The entrance film and the frame hook exist; add a one-tap "save the last 15 s" (or at least a shareable seed+film link that replays the entrance). The cheapest viral surface we have.

**Exit criteria:** ten strangers (not friends) each play at least three fights from a phone without help, at least half come back the next day, and one shares a clip unprompted.

---

## Supporting milestone — M1: the circuit (the arena as a live service)

> **Goal:** a reason to come back tomorrow that isn't "my friend is online": ranked matchmaking, quests, seasons.

From the 2026-09-11 arena design note, still unbuilt: **daily/weekly quests**, a **seasonal battle pass** (cosmetic), **trophy-based matchmaking**. Plus: spectate a friend's fight, a leaderboard by trophies, and server-verified outcomes for ranked (replay the seed and orders through `sim/battle.js`'s deterministic path — see *Combat* below — rather than trusting the host).

**Exit criteria:** measured D7 return on the stranger cohort; a ranked fight between two strangers whose result the server verified.

---

## The mechanisms — the arena

### 1. Arena Fights (lobby, pit, careers) — the product

**Where it stands.** Documented in full in `ARENA.md`. Lobby: teams 2–6, 1–200 a side, invites over the relay (`who` / `invite` / `dm`), NPC fill with six archetypes (swordsman / brute / duelist / guardsman / archer / rider) pre-rolled per seat, an XP curve 0–100 (green / mixed / veteran), pit sizes cosy → colossal (and beyond, to fit a legion), hour, sky, ground (sand / hills / rocks / broken with real collision terrain). The fight: hold-to-load attacks, blade locks and ripostes, rolls, sword + bow for everyone, horses as separate creatures with weight, trample and dismounts; a tactics layer (captains, multi-rank blocks, flank marks, archer stand-off bands, cavalry charge cycles) that scales to 200 a side on a spatial grid. The entrance cinematic: six acts dealt per team, a shared finale, letterbox + skip. Careers on the server (`server/arena.js`, migration 015): XP / gold / ranks / trophies / achievements, a marketplace (`arena-items.js`) with rank and use-skill locks, uniques, a PvP purse, idempotent payout per `(seed, account)`.

**Improvement ladder (M0 → M1 order):**
- Quick Fight + first-session prompts + results screen (M0).
- Lobby on a phone; kick / ready-up; a host-migration story when the host drops (today the fight ends).
- Persist results into a visible career surface on the title screen; "since you were away".
- Quests, battle pass, trophy matchmaking, leaderboards, spectating (M1).
- Balance: cavalry evaporates within ~10 s of contact at legion scale; keep measuring with the hold-and-release proxy, never a tap-masher.

### 2. Combat & battle AI

**Where it stands.** *(Arena-first note: the pit uses this loop's velocity model, lunges, slash arcs, hit-stop, poise → stagger → execute, and a pack director of its own — see §1. The field-battle and command-layer text below describes the parked overworld use of the same primitives.)* The core 30-second loop is the game's strongest asset: pose-snap swordplay, hit-stop, trauma shake, guard breaks, dodge i-frames, poise/heavy/finisher layer, procedural WebAudio SFX (combat-feel Phases 1–2 shipped; Phase 3 telegraphs+parry pending). Enemy AI flanks in packs. The command layer is Orders × Pace (charge/hold/hold-zone/regroup/free × march/rush) issued live mid-fight or from the slowed command deck; squads persist between battles. Battle fighters are pinned to y=0 (terrain relief is backdrop). **Combat is no longer its own mode — and there is no mode toggle at all.** The old discrete strategic-map-vs-action split is gone: one continuous scroll-zoom axis (`fieldZoomT`, hysteresis-guarded thresholds) governs the whole overworld — pull out and the cursor frees for click-to-march at chart/miniature detail; push in past `Z_LOCK` and the pointer locks for mouse-aim combat at street detail (`Esc` frees the cursor to march without changing zoom). *Out to command, in to fight* is the entire control model. A player warband locks into the *same* timed map-battle system the AI hosts use (`playerClash` over `mapBattles`): the bar bleeds and you can settle it in person, or `dropIntoClash` turns the two sides into one in-place **field battle where the lines stood** — the road is the arena. When both hosts of a map-battle are materialised near the hero, their crowds now pair off **man-to-man** — each soldier picks an enemy, closes, and trades real windup→strike→recover swings (the hero's own move set) — while the numeric resolver still owns the *outcome* and culls the fallen from the crowd. Sieges reuse the path via a temporary garrison band (`makeGarrisonBand` / `siegeCapital` / `captureHold`, ownership flips on a storm); sim losses fold back into the real roster (`foldSimBattle`), survivors carry the battle. **Enemy armies are no longer a mass with pack behavior:** the **WAR HOST** layer (`game.js`, search `WAR HOST`) gives every fielded NPC host the battle editor's trained commander — a doctrine (line/wings/oblique/defensive/skirmish) chosen from the served champion θ_C, men carved into divisions with standing orders that re-task live, per-soldier θ_S nerve, and a genuine *withdraw-in-good-order* option instead of feeding you the last man. The same champion steers the strategic map: free hosts on the server take standing orders — hunt / mass / probe / storm / guard / withdraw (`server/warfare.js` `strategizeHosts`) — and skirt battles and walled towns (`keepClear`). **And the champion is *learned*, not hand-tuned:** the valley battle is also a pure headless kernel (`sim/battle.js` — no THREE, no DOM, one seeded RNG so `(seed, policies)` replays byte-identically), and an always-on self-play trainer (`sim/trainer.js`, (1+1)-ES over commander θ_C + soldier θ_S with raw-power genes frozen) breeds it continuously into a separate `train/ai.db`, served at `/api/v1/policy/champion` — verified 40%→80% champion-vs-baseline under the `perf/battle-determin.js` guard. A dedicated march bench (`?march`) tunes the other half of army life — how hosts *walk* between battles (formation cohesion, road-following, terrain, foot animation) on real worldgen ground. The full battle-system doc is `BATTLES.md`.

**Improvement ladder:**
- **Combat-feel Phase 3** (telegraphs + parry) — finishes the planned arc; readable enemy wind-ups are also the accessibility story.
- **Terrain in battle:** the y=0 pin was the right simplification, but battles fought on the actual streets/walls the street tier now renders is the obvious next fidelity jump — start with *flat but furnished* arenas (real buildings as obstacles) before attempting slopes.
- **AI officer layer — shipped (WAR HOST).** Enemy hosts now run the *same* command brain the player's battles use, driven by the editor-trained champion (divisions, standing orders re-tasked live, reserve commitment, morale-based rout, withdraw-when-broken) across field battles, watched NPC clashes, and the strategic map. *Next:* fold the duplicated tactical logic in `game.js` and the kernel (`sim/battle.js`) into one code path so the in-game host and the headless trainer can never drift.
- **Determinism & replay (kernel half shipped):** the headless kernel already *is* the (seed, policies) tuple — one seeded PRNG per battle, byte-identical replays, guarded by `perf/battle-determin.js`. What remains is routing the *rendered in-game* battles through the same path (they still mix `Math.random`), which is the same work as the unification item above — after it, replays, spectating, and server-side verification of co-op outcomes all fall out.
- **Scale ceiling:** profile the actor cap honestly on phone-class hardware (M1 work); instanced crowd rendering + LOD'd fighter logic (distant soldiers run cheap steering, not full combat) buys the "avalanche" sieges the crusade system promises.

### 3. Multiplayer & networking

**Where it stands.** *(Arena: host-authoritative fights over the same `/coop` relay, 20 Hz snapshots, acked `go`, seat grace + `hello.resume` for phones that drop the socket on an app switch, heartbeat reaping; direct guest-avatar control already works in the pit. The first real two-phone test failed on exactly this and was fixed 2026-09-11.)* Shared worlds: every account has a token, presence and armies render on the common map, ambient swarm keeps the map alive. Real-time co-op (J): host-authoritative WebSocket relay (`server/ws.js`, `/coop`), guests hand their warband to the host's arena and watch snapshots; verified headlessly, needs real two-device testing (M1 delivers exactly this). Map-level war (marches, clashes, reinforcement) is server-resolved in shared worlds.

**Improvement ladder:**
- **M1 is the real test** — two phones + a desktop in one world is the first honest multi-device shakeout of presence, co-op, and reconnect.
- **Guest agency in co-op:** v1 guests spectate their handed-over troops. Next: direct guest-avatar control (sword in hand in the host's arena) — snapshot codec exists, needs input forwarding + client prediction for the guest's own body only (everything else stays host-authoritative).
- **Protocol discipline:** define versioned message schemas for `/coop` and the REST surface now, while the client count is one. Every future client (mobile wrapper, bot, Steam build) holds the protocol stable.
- **Anti-cheat posture:** host-authoritative co-op means a malicious host owns the battle. Acceptable for friends-on-LAN; before open matchmaking, the deterministic-battle work in §3 enables server-side outcome verification (replay the seed+orders, compare results) — vastly cheaper than running battles server-side.
- **Scale ladder:** single relay → rooms pinned to worker processes → regional relay fleet. The relay is dependency-free and stateless-ish by design; keep it that way. Presence/map state at large N needs interest management (only stream what's near each player's view) — same principle as the tick, same win.

### 4. Rendering, LOD & performance

**Where it stands.** *(Arena, 2026-09-12: the zero-asset rule is retired for fighters and the set. Fighters are real sculpted meshes (illustros / Tripo, decimated to ~12k tris, skinned onto the procedural rig by `real-skin.js`, `assets/rigs/`), every helm carries the five Vale signatures (`CHARACTERS.md`), and the Colosseum is a baked lathe cavea with an instanced shader crowd (~2.5k spectators, ~700k tris/frame at a cosy pit) plus the `Ancient_Ruins` pack outside. The cost that matters now is draw calls per fighter (~54 meshes each; a colossal fight is thousands of calls) — the phone tier in M0 owns this.)* Zero-asset procedural everything (the strategic edge: ~2MB, instant load, free variants). Hex-prism terrain on a global lattice; detail tiers by zoom rung (chart → miniature → street level) with budgeted, distance-aware re-tessellation so rung changes never hitch; vista system ties fog/camera to explored miles; roads painted into terrain via canvas splats (no ribbon meshes); settlements generated from the landform; instanced scatter with server-persisted street rows. Painted map symbols (war ⚔ with live tug-of-war bars, hold pins, character pins) live on a **screen-space marker layer** (`#markers` + `MK` in `game.js`) — projected DOM elements at constant pixel size, hoverable at any zoom, one projection pass per frame — never 3D-scaled world sprites. three.js r128 vendored.

**Improvement ladder:**
- **Phone tier (M1):** the quality-toggle work lands here first — pixel-ratio cap, shadow budget, scatter density, tessellation lock. Make the tier system explicit (`QUALITY.low/med/high`) rather than scattered constants.
- **Frame budget instrumentation:** a permanent lightweight profiler (per-system ms: terrain, scatter, fighters, CA overlay, UI) behind `?debug=1` — every performance conversation should start from its numbers, not vibes.
- **Draw-call discipline at street tier:** street settlements rebuild per-hold; audit material/geometry sharing across holds (one material per palette globally, geometry caches already exist — verify nothing per-instance slipped in).
- **The r128 question, re-answered:** still no engine upgrade before the loop is proven — but the *reason* has shifted from "no player payoff" to "phone WebGL2 support is what matters, and r128 handles it." Revisit only if a phone-class rendering feature (e.g. proper instanced color on old iOS GPUs) forces it.
- **Long term:** WebGPU is icebox; the zero-asset pipeline means a renderer swap touches materials/instancing only, which is the payoff of never adopting glTF.

### 5. Accounts, identity & persistence

**Where it stands.** *(Arena: the same accounts carry the arena career; solo NPC fights need no account.)* Username/password sessions ride `X-Player-Token`; multiple characters per account per map; the U drawer switches/splits/gives between them with multi-select bulk orders; merge preserves careers via `member_of`. SQLite via better-sqlite3, migrations numbered (014 as of today). Client has offline fallback for everything.

**Improvement ladder:**
- **Password security audit before any non-LAN exposure:** hashing (argon2/scrypt), rate limiting, session expiry/rotation, HTTPS. LAN testers don't need it; the first internet-reachable deployment absolutely does — do it *at* that boundary, not after.
- **Account recovery & abuse surface:** email-optional recovery codes; per-account request quotas (the validation caps exist — formalize them per endpoint).
- **SQLite's honest ceiling:** better-sqlite3 on one box serves thousands of concurrent players fine (reads dominate, writes are tick-batched). The scale plan is *not* "switch to Postgres day one" — it's (a) Litestream/WAL backup replication immediately (a dead disk must not kill a world), (b) world sharding (one SQLite file per world — already nearly true structurally), (c) Postgres only when a single world outgrows a box.
- **GDPR/deletion path:** named persistent characters mean personal data. Account-delete that scrubs or anonymizes (character becomes an NPC with a generated name — fits the fiction perfectly) — design this early, it's cheap now and mandatory later.
- **Save export codes** (base64 of versioned state) remain the cross-platform migration story from the original plan — still right.

### 6. Game feel, audio & onboarding

**Where it stands.** *(Arena: onboarding is the M0 work list — Quick Fight, prompts, results screen, death recap. The synthesised crowd roar, bell and countdown sweep exist; no music.)* Procedural WebAudio SFX layer shipped (FEEL/AUDIO/SFX systems); combat juice pass 1–2 done. No music yet. Onboarding is the starting-station drop-in; no tutorialization of the deeper systems (command layer, map war, diplomacy).

**Improvement ladder:**
- Contextual just-in-time prompts (from the original plan — still exactly right) extended to the *map* verbs: first pact, first call-to-arms, and — now that one continuous zoom is the whole control model — teaching *out to command, in to fight* the first time a player zooms across the combat threshold (the highest-value onboarding beat post-unification).
- Procedural or CC0 music with an intensity layer; provenance recorded (Steam AI-disclosure requirement stands).
- The retention mechanics from the original plan (best-score memory, near-miss framing, death recap) remain valid and mostly unbuilt — they move to the milestone ladder below rather than being lost.

---

## Parked: the open world

Everything below still runs and is reachable with `?world`. The text is kept in full as the record of where each system stands; **none of it is in flight** until the arena has an audience (M0/M1). When the world comes back it comes back *through the arena* — the fighter walks out of the tunnel into the vale with the same character and gear.

### 7. Server-authoritative procedural worldgen

**Where it stands.** Terrain, settlements, and roads are generated by a shared deterministic kernel (`sim/terra.js`) that runs identically on client and server. The server owns the canonical world: chunks are generated on first visit, persisted in SQLite (`server/chunks.js`, `chunk` + `chunk_detail` tables), and served in batches (`/api/v1/chunks`, `/chunks/detail`). The client's local kernel produces byte-identical output, so the server payload is persistence, not a correctness dependency — offline play degrades gracefully. Detail is tiered: strategic pictograms at map zoom, persisted street-level rows (tree stands, boulders, groves) at action zoom. Worldgen versioning (`Terra.VERSION`) is stamped on every stored chunk, and stale-kernel payloads now **regenerate lazily in place** on next touch — a math bump makes a genuinely new world with no manual DB wipe (holds reseat automatically).

**The world has real geography now (shipped, `Terra.VERSION` 4).** The five capitals ride a wide ring (~216u) with a deterministic pair-relaxation pass guaranteeing open country between capital walls no matter what the coastline does; cities live on an 11-chunk lattice (~660u apart — a real journey), with villages and towns filling roughly half the chunks between them; every settlement tier got a bigger footprint, and a deterministic cross-chunk overlap cull (tier rank + stable hold-key tie-break over a ±4-chunk neighbour scan) guarantees exactly one of any colliding pair survives — with client and server independently agreeing on which.

**Frontier ownership coheres (shipped).** Beyond the five-power heartland, ownership is no longer a per-site coin-flip between anonymous free cities. A realm kernel (`sim/world-sim.js`, `realmFor`) carves the frontier into `REALM_BLOCK`-sized cells; each non-wilderness cell is one named realm grown from its region seed — deterministic banner name, seeded HSL colour, nominal capital seat — with contiguous borders. Same shared-kernel guarantee as terrain: a realm looks identical wherever it's first generated, client or server. Wilderness cells stay masterless (Free City). This is the endless-world pillar demoing itself: the politics keep going past the map's edge instead of thinning to salt-and-pepper towns.

**Why this design scales.** Determinism means the server never streams geometry — only compact seed-derived rows — so bandwidth per player is tiny and the client can always fall back to local generation. Generate-on-first-visit means storage grows with *explored* world, not world size.

**Determinism posture (stated plainly).** Byte-identical output is verified *on the same engine*. Float determinism leans on a seeded PRNG + disciplined ordering, **not fixed-point math** — it holds because it's all one engine today, and that fragility is the known seam. **Cross-engine conformance is a deliberate afterthought:** we're deterministic on whatever engines have the players (V8/Blink first) and harden for another engine only when its market share forces it. Support follows popularity, not ideology. The leap the vision asks for is extending determinism from geometry to the *whole stack* — terrain, rules, history, "how a region works" — all reproducible from seed + a versioned algorithm-set.

**Improvement ladder:**
- **Chunk payload budget:** measure real bytes/chunk at each tier; gzip is in place, but add a hard payload-size regression test so a worldgen change can't quietly 10× the wire cost.
- **Kernel migration story (v0 shipped):** the policy is now *regenerate lazily per chunk* — payloads carry the kernel version stamp and stale ones rebuild on next touch (`server/chunks.js`). At scale, world "seasons" (new version = new world, old worlds read-only archives) remain the industry-proven fallback if lazy regeneration ever needs player-visible edits preserved across a math change (see the edit layer below).
- **Server generation cost:** chunk generation is synchronous in the request path. Move to a worker thread + generation queue before any public traffic; pre-warm the ring around each active player.
- **Edit layer on top of determinism:** player/world *changes* to terrain (razed villages, built forts) need a sparse delta table over the deterministic base — design it before any feature needs it, because retrofitting deltas under a deterministic kernel is painful.
- **Long term:** region servers each owning a world-space shard of chunk generation, coordinated by chunk key — the deterministic kernel makes this embarrassingly parallel.

### 8. Living-world simulation (tick, careers, diplomacy, destiny)

**Where it stands.** A bounded time-driven tick (`server/tick.js`) advances the world 24/7 under `launchd`. Inside it: character careers (every soldier named, skill from real fighting, deeds persisted), the diplomacy/intent engine (faction relations, Phase A live), and the destiny engine (per-character fated arcs + a world "age," chronicle-only by design). **The living war (`server/warfare.js`, migrations `013`/`014`) is now the top layer:** every settlement fields a tier-scaled patrol ecology (`role='patrol'` warlord rows), and patrols now carry a roaming **focus** (`focus_*` columns, migration `014`) the server re-picks over time — mostly their home city's borders, sometimes a sortie to a nearby *owned* village or castle they also guard — so a garrison visibly ranges across the whole realm it holds instead of grinding one ring at the wall. On owned soil the watch is three-way: declared enemies are run down, neutral peer columns are shadowed and nudged back to the border with no blood, friends pass freely. (Emergent frontier realms now keep a *full* garrison like the five nations, not just a militia watch — only masterless Free Cities get the thin watch, which pushes more rows through the tick; see interest management below.) Factions rarely *call the banners* into muster→march→siege **campaigns** (`campaigns` table), and armies that meet no longer resolve instantly — they lock into a **timed battle that bleeds over ticks** (`sbattles` table) so a player can watch it on the map or walk up to the lines. The old instant `doClash` is gone; resolution still routes through the shared character-weighted resolver (`sim/world-sim.js`), deterministic per seed. The shared world keeps ticking under live players (they are pure viewers); `/world` is position-scoped (`getArmiesNear` ships nearby patrols + all hosts + anyone in a battle/campaign). "While You Were Away" digests summarize the elapsed war on login. The watch now covers the *infinite* world honestly: the old 640u patrol clamp (which stranded far-frontier watches mid-map) is gone — it's a pure NaN guard now — towns and villages field their own small watches, and freshly generated ground is **garrisoned in the same transaction that generates it** (`ensureRegion` bursts the full complement for virgin holds), so fast travel never lands in a ghost settlement waiting on the next patrol tick.

**Why this design scales.** The sim kernel is pure and shared — the same code that resolves a battle server-side can predict it client-side, which is the foundation for both trust (verifiable outcomes) and latency-hiding (client anticipates, server confirms).

**Improvement ladder:**
- **Tick cost profiling:** instrument per-system tick time (diplomacy, destiny, battles, careers) and per-world row counts. Establish the budget *now*: the tick must stay under N ms at 10× current population or the always-on promise breaks.
- **Interest management (now urgent):** the living war pushed the population past **1,300 warlord rows** (≈180 hosts + ≈1,100 patrols) and the tick touches every one every beat. Move to activity buckets — hosts and anything near a player/enemy tick every beat, distant patrols tick coarsely (every Nth beat with catch-up math). This is the single biggest headroom win and the patrol ecology is what forced it.
- **Diplomacy Phases B–D** (personality-driven intents, war weariness, betrayals) — already planned; each phase must land with its own drift guard (the all-neutral-peace bug of the crowded-map fix is the cautionary tale: a living world that converges to stasis reads as dead).
- **Observability (v0 shipped):** an admin god's-eye overview (`server/admin.js`, `GET /api/v1/admin/overview`, rendered by `admin.html`) now draws the *standing* world — terrain raster, routed roads, live border field — beneath the live entity feed (players + every army incl. patrols), all through the shared kernel so overwatch == game. First real window into the always-on tick; next it wants per-system tick-time and row-count instrumentation layered on (see profiling above) so we watch cost, not just entities.
- **Chronicle as a product surface:** the event log is currently flavor. At scale it becomes the social object — shareable world histories, "this week in your world" digests, famous-character pages. Cheap to build on what exists; enormous retention value.
- **Determinism testing:** byte-identical-per-seed is verified for destiny, and **battle resolution is now pinned** (`perf/battle-determin.js` plays every seed twice — bare and with mutated genomes — and asserts byte-identical traces; green on all seeds). Extend the same golden-seed regression harness to every tick system so no refactor silently forks the sim. **The `warfare.js` tick itself (musters, campaigns, patrol focus) still has none** and mutates the most rows per tick — the remaining half of the gap. Also fix a real drift hazard: `NATIONS` / `CAP_ANGLE` are duplicated between `warfare.js` and `tick.js` with "keep in sync" comments — hoist to one shared constant.

### 9. Overworld structure: roads, settlements, territory

**Where it stands.** Hierarchical road network (Gabriel trunks, branches, streets, gated walls — a road crosses a wall only at a gate), hex-A* routing, click-to-march ETA, armies travel by road (with the `?march` bench for tuning how they walk it). Terrain-aware settlements (contour-marched curtain walls fit the hills), now spaced like a real country (§1): capitals held far apart, cities ~660u landmarks, villages and towns filling the land between, and a deterministic guarantee that no two walled holds ever overlap. Territory as a breathing cellular-automaton influence field drawn as hex caps — now backed by coherent frontier ownership: beyond the heartland, holds fly the banner of their region's emergent realm (§1), so the border field reads as contiguous nations rather than a speckle of free cities. Starting-station system deals a scaled opening scenario.

**Improvement ladder:**
- **Settlements as gameplay, not scenery:** the street tier renders real towns — the next systems (garrisons you walk through, recruitment inside walls, markets, siege objectives tied to actual gates) should consume the geometry that now exists. Every settlement feature from here on should work *at street level first*.
- **Territory consequences:** the CA border is visual; wire it to the sim (tax/recruit pools by held hexes, supply attrition outside friendly territory) so the map's breathing matters.
- **Road economy:** roads already shape travel; let them shape the *war* — supply lines that can be cut, patrol routes that matter, richer settlements on trunk roads. All reads of existing data, no new generators.

### 10. AI-authored generators (the generative pillar)

**Where it stands.** The "generative layer" is **at authoring time, not runtime** — a deliberate architecture choice that dissolves the usual generative-content cost/latency/consistency problems. There is no LLM in the runtime content path: the world is produced by deterministic *algorithms*, so runtime is cheap and every region stays consistent forever. Today those algorithms are authored by a human pairing with Claude — the whole procedural stack (`sim/terra.js`, `sim/settle.js`, `server/roads.js`, `server/warfare.js`) is code written that way. The "AI cost" is a subscription and hours.

**Why this design scales.** Moving generative work to authoring time means: zero per-visit inference bill, no latency in the play path, and no "the world contradicts its own history" failure — the moat that runtime-LLM worlds can't have. The output is versioned, deterministic code shipped as tiny seeds.

**Improvement ladder:**
- **Formal generator spec:** today authoring is conversational. Define a spec/DSL a generator is authored *from* — the precondition for automating it.
- **Author-and-gate loop:** LLM proposes a generator → runs through the determinism harness (§1) *and* a quality/"is it fun" eval → best candidates promote into the library. Human-in-the-loop first.
- **Quality is not determinism:** deterministic ≠ good. Build the eval harness (playtest telemetry + heuristics) that lets "fun" gate a promotion, so full-auto authorship is safe.
- **Purpose-built model (long term):** a model trained specifically to author generation-algorithms, from our own generator corpus + which authored regions players actually engage with. Closing the loop is the endgame; the harness is what makes it safe.
- **Anti-sameness:** diversity comes from a *library* of authored generators, not one tuned noise function — the whole point of automating authorship.

### 11. Living NPC AI (the world moves without you)

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

1. **M0 — The arena a stranger can play** (above). *Exit: strangers on phones, half return next day.*
2. **M1 — The circuit** (above): quests, pass, trophy matchmaking, spectating, verified ranked. *Exit: measured D7 return.*
3. **M2 — Stores:** the phone tier and the touch layer graduate to Capacitor wrappers; itch / CrazyGames web build. *Exit: installs from a store, same retention as web.*
4. **M3 — Beyond the gates:** the arena fighter walks out into the vale — the parked world unhidden as the expansion (warbands, roads, sieges, the living war), the arena one building in it. The endless-world vertical slice (claim virgin frontier, the generator loop authors a living region) returns here as the headline. *Exit: an arena player crosses into the world and comes back to the pit.*
5. **M4 — Steam:** page + wishlist clock, Next Fest, desktop wrapper; the always-on world + cloud characters as the paid pillar.

## Metrics

Decisions follow stranger telemetry, segmented by source, measured on the engaged cohort.

| Metric | Gate |
|---|---|
| Time from link to first swing (phone, new player) | < 30 s |
| Fights per session (engaged cohort) | ≥ 3 |
| D1 return / D7 return | > 40% / > 15% |
| Phone FPS (mid-range Android, 4v4 Colosseum) | ≥ 30 sustained |
| Relay desync / lost-fight reports | zero tolerated — every one root-caused |
| Fights whose payout failed or double-paid | zero |
| Tick time at 10× population (synthetic) — *parked world* | < 250 ms sustained |

## We Will NOT Do

- **Energy systems, timers, streaks, escalate-and-reset rewards** — the daily rhythm is an invitation, never a punishment.
- **Pay-to-win, paid stat boosts, loot boxes** — one purchasable +10% invalidates every career and leaderboard. Uniques stay at most +2% damage; the pass is cosmetic.
- **Ads inside the core loop; no revive-for-ad** — death must matter.
- **Hidden rubber-banding** — outcomes stay legible.
- **Power-gating core verbs** — attack, block, roll, swap are in fight #1 forever.
- **Fake social proof, nag-share, notification spam.**
- **Unlicensed meshes** — every real model ships with its licence recorded; the Clash-of-Clans fan art was reference only.
- **Premature optimization** — the profiler decides, not intuition.
- ~~Asset pipeline / glTF~~ — **retired 2026-09-12**: the user rejected the procedural "lego men"; fighters and the set are real meshes now. The procedural rig stays as the skeleton and animator underneath.
- ~~Replacing pose-snap animation with skeletal blends~~ — **softened**: the real meshes are skinned onto the same pose-snap rig; the snap is still the signature, the skin is not.
- ~~No multiplayer/servers before traction~~ — retired 2026-06-28; the relay is the arena's backbone.
- ~~Endless-world slice before anything else~~ — **retired 2026-09-12 by owner direction**: arena first.

## Risks (updated)

1. **The uncommitted mountain** — five large passes live in one working tree with untracked assets. Mitigation: first M0 item is committing in pieces; nothing public ships from an uncommitted tree.
2. **Phone performance sinks M0** — 54-mesh fighters and a 700k-tri set. Mitigation: explicit quality tiers and rig LOD; if a mid-range Android can't hold 30 fps at 4v4, the Colosseum drops a ring and the crowd thins before anything else does.
3. **Host-authoritative trust** — fine for friends and the beta, wrong for ranked. Mitigation: deterministic replay verification before matchmaking, never live server simulation.
4. **Licensing** — the ruins pack's licence is unknown. Mitigation: resolve or replace before the public build.
5. **The parked world rots** — hidden code drifts. Mitigation: `?world` stays a first-class flag, the determinism harnesses keep running in CI-by-hand, and M3 is on the ladder, not "someday".
6. **Solo-dev burnout** — unchanged: hard weekly hour budget, every milestone ends public, cut content not gates.

---

## Appendix — historical addenda

The endless-world M0 (claim virgin frontier, generator loop, warfare determinism, interest management, NPC legibility) and the mobile LAN playtest M1 that headed this file until 2026-09-12 survive in git history (`git log --follow ROADMAP.md`); their work lists are folded into M3 and the parked sections above. The three dated addenda from June 2026 (Persistent NPC Careers & Living-World Server · Allied Co-op & Crusades · Global Destiny Engine) are folded into the parked sections; implementation detail lives in `BATTLE_CONTROLS.md`, `server/README.md`, and the plan files under `~/.claude/plans/`.
