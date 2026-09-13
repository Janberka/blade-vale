# CTO Brief — honest technical state

Read `VISION.md` first for the *why*. This is the *what's actually true*, including the gaps. Nothing here is polished for a candidate; it's the map you'd want before reviewing the code.

> **Strategy change, 2026-09-12:** the product is now **Arena Fights** (`ARENA.md`), and the open world described below is *parked* — still in the build, hidden from the title screen behind `?world`, to return later as the arena's expansion (`ROADMAP.md` → *Parked: the open world*). Everything in this brief about worldgen, the tick, warfare and diplomacy remains true; it is simply not what is being worked on. The arena-side state (real-mesh fighters, the Colosseum, careers, the relay's reconnect story) is in `ARENA.md`, `CHARACTERS.md` and the arena sections of `ROADMAP.md`.

## What's real today (verified in the repo)
- **~36,000 lines of JS**, zero art assets. Whole client loads in ~2MB; everything is procedurally generated.
- **Deterministic worldgen kernel** — `sim/terra.js` (~70k), plus `sim/settle.js` and `server/roads.js`. Byte-identical client/server **on the same engine**. Chunks generate on first visit, persist in SQLite (`server/chunks.js`), served in batches. Worldgen version is stamped on every stored chunk, and stale-kernel chunks regenerate lazily in place — a kernel math bump needs no DB wipe.
- **Always-on server** — Node + `better-sqlite3`, 14 numbered migrations, a bounded time-driven tick (`server/tick.js`) running 24/7 under `launchd`. World DB is actively mutating (~18MB + WAL).
- **Living war** — `server/warfare.js` (~40k): settlement patrol ecologies, muster→march→siege campaigns, timed battles that bleed across ticks. Resolution routes through the shared character-weighted resolver in `sim/world-sim.js`.
- **Diplomacy + destiny** — `server/diplomacy.js` (faction relations, Phase A), `server/destiny.js` (per-character fated arcs). Both scaffolded, rule-based.
- **Real-time 3D combat** — pose-snap swordplay, hit-stop, procedural WebAudio SFX. The 30-second loop is the strongest asset. All in `game.js`.
- **Self-play battle AI** — a headless deterministic battle kernel (`sim/battle.js`, `(seed, policies)` replays byte-identically) + an always-on (1+1)-ES trainer (`sim/trainer.js`, policy store `train/ai.db`) breeding commander + soldier policies; the champion is served at `/api/v1/policy/champion` and commands every NPC army in the live game (the WAR HOST layer in `game.js`, strategic orders via `strategizeHosts` in `server/warfare.js`). Verified 40%→80% vs. baseline under a byte-identical determinism guard.
- **Accounts** — username/password sessions on `X-Player-Token`, multiple characters per account, `server/auth.js` + `server/chars.js`.
- **Determinism tests** — `perf/roads-determin.js`, `perf/settle-determin.js`, `perf/battle-determin.js` (battle kernel pinned byte-identical across every seed, bare + mutated genomes), and destiny golden-seed coverage. Perf-regression harness in `perf/`.

## The honest gaps (surface these, don't hide them)
1. **The warfare tick has no determinism test** — battle *resolution* is now pinned (`perf/battle-determin.js`), but the server tick that mutates the most rows (musters, campaigns, patrol focus) still has no golden trace. Highest-priority test to write. First-sprint material.
2. **Float determinism leans on single-engine luck** — seeded PRNG + disciplined ordering, not fixed-point. It holds because it's all one engine. Cross-engine is a deliberate afterthought (support follows engine popularity), but the fragility is real and undocumented.
3. **Scale is unbuilt** — one Node process, one SQLite file, one box. Interest management is partial (`getArmiesNear` is position-scoped; the tick still touches every entity). Thousands→millions is the CTO's core mandate, not a solved problem.
4. **Combat/world authority is mixed** — map war is server-resolved; action combat is client-side; co-op is host-authoritative. Fine for friends, wrong for strangers. Anti-cheat = deterministic replay verification (planned, not built).
5. **Bus factor** — the world keeps ticking without the founder, but *changes* don't. Much of the "why" is in one head. De-risking that is part of the role.
6. **The generative loop is manual** — generators are authored by human+Claude pairing. No formal spec, no automated quality/eval harness yet. Full-auto authorship and a purpose-built model are the bet, not the state.
7. **NPC intelligence above the battlefield is rule-based** — battlefield command is now genuinely learned (self-play champion), but war/diplomacy/settlement decisions are scripted, not agentic or legible.
8. **Two battle brains** — the in-game WAR HOST tactics (`game.js`) and the headless kernel (`sim/battle.js`) implement the same logic twice and can drift; folding them into one code path matters more now that the kernel is the thing being trained.

## Reading path for a code review (suggested order)
1. `VISION.md` → `ROADMAP.md` (mechanism-by-mechanism state + improvement ladders).
2. `sim/terra.js` — the deterministic kernel; the whole architecture rests on it.
3. `server/chunks.js` — generate-on-first-visit + persistence + versioning.
4. `server/tick.js` + `server/warfare.js` — the living world; where scale breaks first.
5. `sim/world-sim.js` — the shared battle/diplomacy resolver (pure, runs both sides). Then `sim/battle.js` + `sim/trainer.js` — the headless battle kernel and the self-play loop that trains on it.
6. `server/index.js` — the HTTP/WS surface (the protocol a future client holds stable).
7. `game.js` — the client; combat loop, rendering, detail tiers. Large; skim by system.

## 2-month target
Ship the vertical slice that proves the thesis, internet-reachable for a small invite cohort: claim virgin frontier → the generator loop authors a living region (terrain, roads, a town, a faction) → it persists for everyone. Along the way: warfare determinism test, first real interest-management pass, and the security boundary for internet exposure (hashing, HTTPS, rate limits, Litestream backups).

## Stack notes
- **Node/JS, staying** — the deterministic kernel must run identically client and server; one language is a feature. Plain JS today; a TypeScript migration is reasonable and open.
- **SQLite is pragmatic, not religious** — one box serves thousands (reads dominate, writes are tick-batched). Scale plan: replication first, world sharding next, Postgres only if a single world outgrows a box.
- **three.js r128 vendored** — no engine upgrade before the loop is proven; the zero-asset pipeline means a renderer swap touches materials/instancing only.
